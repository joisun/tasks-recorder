import { randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { runtimeError } from '../runtime/runtime-errors.mjs'
import {
  createRunSchema,
  RUN_SCHEMA_VERSION,
} from '../scheduler/scheduler-schema.mjs'

const ORIGINS = new Set(['manual', 'scheduled', 'catchup'])
const OPEN_STATUSES = new Set(['queued', 'running'])
const TERMINAL_STATUSES = new Set([
  'succeeded',
  'failed',
  'timed_out',
  'canceled',
  'interrupted',
])
const TRANSITIONS = Object.freeze({
  queued: new Set(['running', 'failed', 'canceled', 'interrupted']),
  running: new Set([
    'succeeded',
    'failed',
    'timed_out',
    'canceled',
    'interrupted',
  ]),
})
const SAFE_RUNTIME_ID = /^[a-z][a-z0-9-]{0,63}$/

export function createRunStore({
  databasePath,
  clock = () => new Date(),
  createId = randomUUID,
} = {}) {
  requiredString(databasePath, 'databasePath')
  if (typeof clock !== 'function') throw new TypeError('clock must be a function')
  if (typeof createId !== 'function') throw new TypeError('createId must be a function')

  const directory = dirname(databasePath)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  chmodSync(directory, 0o700)
  const db = new DatabaseSync(databasePath)
  try {
    initialize(db)
    harden(databasePath)
  } catch (error) {
    db.close()
    throw error
  }

  const selectById = db.prepare('SELECT * FROM scheduled_runs WHERE id = ?')
  const selectByIdempotency = db.prepare(
    'SELECT * FROM scheduled_runs WHERE idempotency_key = ?',
  )
  const selectOccurrence = db.prepare(`
    SELECT id FROM scheduled_runs
    WHERE schedule_id = ? AND occurrence_key = ?
  `)
  const selectActive = db.prepare(`
    SELECT id FROM scheduled_runs
    WHERE schedule_id = ? AND status IN ('queued', 'running')
    LIMIT 1
  `)

  function transaction(operation) {
    db.exec('BEGIN IMMEDIATE')
    try {
      const result = operation()
      db.exec('COMMIT')
      harden(databasePath)
      return result
    } catch (error) {
      try { db.exec('ROLLBACK') } catch {}
      throw error
    }
  }

  function requireRun(id) {
    const run = selectById.get(requiredString(id, 'run_id'))
    if (!run) throw runtimeError('RUN_NOT_FOUND', `Run ${id} does not exist`)
    return run
  }

  function create(input) {
    const value = normalizeCreation(input)
    return transaction(() => {
      if (value.idempotency_key !== null) {
        const existing = selectByIdempotency.get(value.idempotency_key)
        if (existing) {
          if (existing.schedule_id !== value.schedule.id) {
            throw runtimeError(
              'RUN_IDEMPOTENCY_CONFLICT',
              'The idempotency key belongs to another Schedule',
            )
          }
          return publicRun(existing, { includeSnapshot: true })
        }
      }
      if (value.occurrence_key !== null
        && selectOccurrence.get(value.schedule.id, value.occurrence_key)) {
        throw runtimeError(
          'RUN_OCCURRENCE_EXISTS',
          'This Schedule occurrence already has a Run',
        )
      }
      if (selectActive.get(value.schedule.id)) {
        throw runtimeError('RUN_ALREADY_ACTIVE', 'Schedule already has an active Run')
      }

      const timestamp = nowIso(clock)
      const id = requiredString(createId(), 'run_id')
      db.prepare(`
        INSERT INTO scheduled_runs (
          id, schedule_id, definition_etag, runtime_id, origin,
          occurrence_key, idempotency_key, scheduled_for, status,
          snapshot_json, runtime_version, executable_digest, pid,
          session_id, created_at, started_at, finished_at, exit_code,
          error_code, final_message, usage_json, file_changes_json,
          stdout_log_path, stderr_log_path, reviewed_at, updated_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, NULL, NULL, NULL, NULL,
          ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?
        )
      `).run(
        id,
        value.schedule.id,
        value.schedule.etag,
        value.runtime_id,
        value.origin,
        value.occurrence_key,
        value.idempotency_key,
        value.scheduled_for,
        JSON.stringify(value.schedule),
        timestamp,
        timestamp,
      )
      return publicRun(requireRun(id), { includeSnapshot: true })
    })
  }

  function markRunning(id, input = {}) {
    return transition(id, 'running', (run, timestamp) => {
      const pid = input.pid ?? null
      if (pid !== null && (!Number.isSafeInteger(pid) || pid < 1)) {
        throw runtimeError('RUN_INPUT_INVALID', 'pid must be a positive integer')
      }
      db.prepare(`
        UPDATE scheduled_runs
        SET status = 'running', runtime_version = ?, executable_digest = ?,
            pid = ?, started_at = ?, updated_at = ?
        WHERE id = ?
      `).run(
        optionalString(input.runtime_version, 'runtime_version'),
        optionalString(input.executable_digest, 'executable_digest'),
        pid,
        timestamp,
        timestamp,
        run.id,
      )
    })
  }

  function complete(id, input = {}) {
    if (!TERMINAL_STATUSES.has(input.status)) {
      throw runtimeError('RUN_INPUT_INVALID', 'completion status must be terminal')
    }
    return transition(id, input.status, (run, timestamp) => {
      const exitCode = input.exit_code ?? null
      if (exitCode !== null && !Number.isInteger(exitCode)) {
        throw runtimeError('RUN_INPUT_INVALID', 'exit_code must be an integer or null')
      }
      db.prepare(`
        UPDATE scheduled_runs
        SET status = ?, pid = NULL, session_id = ?, finished_at = ?,
            exit_code = ?, error_code = ?, final_message = ?, usage_json = ?,
            file_changes_json = ?, stdout_log_path = ?, stderr_log_path = ?,
            updated_at = ?
        WHERE id = ?
      `).run(
        input.status,
        optionalString(input.session_id, 'session_id'),
        timestamp,
        exitCode,
        optionalString(input.error_code, 'error_code'),
        optionalString(input.final_message, 'final_message'),
        optionalJson(input.usage, 'usage'),
        optionalJson(input.file_changes, 'file_changes'),
        optionalString(input.stdout_log_path, 'stdout_log_path'),
        optionalString(input.stderr_log_path, 'stderr_log_path'),
        timestamp,
        run.id,
      )
    })
  }

  function transition(id, nextStatus, mutation) {
    return transaction(() => {
      const run = requireRun(id)
      if (!OPEN_STATUSES.has(run.status) || !TRANSITIONS[run.status].has(nextStatus)) {
        throw runtimeError(
          'RUN_STATE_CONFLICT',
          `Run cannot transition from ${run.status} to ${nextStatus}`,
        )
      }
      const timestamp = nowIso(clock)
      mutation(run, timestamp)
      return publicRun(requireRun(run.id), { includeSnapshot: true })
    })
  }

  function cancelQueued(id) {
    return transition(id, 'canceled', (run, timestamp) => {
      db.prepare(`
        UPDATE scheduled_runs
        SET status = 'canceled', finished_at = ?, error_code = 'RUN_CANCELED',
            updated_at = ?
        WHERE id = ?
      `).run(timestamp, timestamp, run.id)
    })
  }

  function interruptOpen() {
    return transaction(() => {
      const timestamp = nowIso(clock)
      return db.prepare(`
        UPDATE scheduled_runs
        SET status = 'interrupted', pid = NULL, finished_at = ?,
            error_code = 'TASKD_RESTARTED', updated_at = ?
        WHERE status IN ('queued', 'running')
      `).run(timestamp, timestamp).changes
    })
  }

  function get(id) {
    return publicRun(requireRun(id), { includeSnapshot: true })
  }

  function list({ schedule_id: scheduleId, status, limit = 100 } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw runtimeError('RUN_INPUT_INVALID', 'limit is invalid')
    }
    const clauses = []
    const values = []
    if (scheduleId !== undefined) {
      clauses.push('schedule_id = ?')
      values.push(requiredString(scheduleId, 'schedule_id'))
    }
    if (status !== undefined) {
      if (!OPEN_STATUSES.has(status) && !TERMINAL_STATUSES.has(status)) {
        throw runtimeError('RUN_INPUT_INVALID', 'status is invalid')
      }
      clauses.push('status = ?')
      values.push(status)
    }
    values.push(limit)
    return db.prepare(`
      SELECT * FROM scheduled_runs
      ${clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''}
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(...values).map((run) => publicRun(run))
  }

  function markReviewed(id) {
    return transaction(() => {
      const run = requireRun(id)
      if (!TERMINAL_STATUSES.has(run.status)) {
        throw runtimeError('RUN_NOT_REVIEWABLE', 'Open Run cannot be reviewed')
      }
      if (run.reviewed_at !== null) return publicRun(run, { includeSnapshot: true })
      const timestamp = nowIso(clock)
      db.prepare(`
        UPDATE scheduled_runs SET reviewed_at = ?, updated_at = ? WHERE id = ?
      `).run(timestamp, timestamp, run.id)
      return publicRun(requireRun(run.id), { includeSnapshot: true })
    })
  }

  function hasOccurrence(scheduleId, occurrenceKey) {
    return Boolean(selectOccurrence.get(
      requiredString(scheduleId, 'schedule_id'),
      requiredString(occurrenceKey, 'occurrence_key'),
    ))
  }

  return Object.freeze({
    create,
    markRunning,
    complete,
    cancelQueued,
    interruptOpen,
    get,
    list,
    markReviewed,
    hasOccurrence,
    close: () => db.close(),
  })
}

function initialize(db) {
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA busy_timeout = 5000')
  db.exec('PRAGMA journal_mode = WAL')
  const version = db.prepare('PRAGMA user_version').get().user_version
  if (version === 0) {
    createRunSchema(db)
    return
  }
  if (version !== RUN_SCHEMA_VERSION) {
    throw runtimeError(
      'RUN_SCHEMA_VERSION_UNSUPPORTED',
      `Run schema v${version} is unsupported`,
      { expected: RUN_SCHEMA_VERSION, actual: version },
    )
  }
}

function normalizeCreation(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw runtimeError('RUN_INPUT_INVALID', 'Run creation input must be an object')
  }
  const schedule = JSON.parse(JSON.stringify(input.schedule))
  if (!schedule || typeof schedule !== 'object' || Array.isArray(schedule)) {
    throw runtimeError('RUN_INPUT_INVALID', 'schedule must be an object')
  }
  requiredString(schedule.id, 'schedule.id')
  requiredString(schedule.etag, 'schedule.etag')
  requiredString(schedule.prompt, 'schedule.prompt')
  requiredString(schedule.workspace, 'schedule.workspace')
  if (!SAFE_RUNTIME_ID.test(input.runtime_id)) {
    throw runtimeError('RUN_INPUT_INVALID', 'runtime_id is invalid')
  }
  if (!ORIGINS.has(input.origin)) {
    throw runtimeError('RUN_INPUT_INVALID', 'origin is invalid')
  }
  const occurrenceKey = nullableString(input.occurrence_key, 'occurrence_key')
  const scheduledFor = nullableInstant(input.scheduled_for, 'scheduled_for')
  const idempotencyKey = nullableString(input.idempotency_key, 'idempotency_key')
  if (input.origin === 'manual' && occurrenceKey !== null) {
    throw runtimeError('RUN_INPUT_INVALID', 'manual Runs cannot have an occurrence_key')
  }
  if (input.origin !== 'manual' && occurrenceKey === null) {
    throw runtimeError('RUN_INPUT_INVALID', 'scheduled Runs require an occurrence_key')
  }
  return {
    schedule,
    runtime_id: input.runtime_id,
    origin: input.origin,
    occurrence_key: occurrenceKey,
    scheduled_for: scheduledFor,
    idempotency_key: idempotencyKey,
  }
}

function publicRun(row, { includeSnapshot = false } = {}) {
  const result = { ...row }
  delete result.snapshot_json
  if (includeSnapshot) result.snapshot = JSON.parse(row.snapshot_json)
  result.usage = row.usage_json === null ? null : JSON.parse(row.usage_json)
  result.file_changes = row.file_changes_json === null
    ? null
    : JSON.parse(row.file_changes_json)
  delete result.usage_json
  delete result.file_changes_json
  return result
}

function nowIso(clock) {
  const value = clock()
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.valueOf())) {
    throw runtimeError('CLOCK_INVALID', 'clock must return a valid date')
  }
  return date.toISOString()
}

function requiredString(value, field) {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 65_536) {
    throw runtimeError('RUN_INPUT_INVALID', `${field} must be a bounded string`)
  }
  return value
}

function nullableString(value, field) {
  return value === null || value === undefined ? null : requiredString(value, field)
}

function nullableInstant(value, field) {
  if (value === null || value === undefined) return null
  const normalized = requiredString(value, field)
  if (!Number.isFinite(Date.parse(normalized))) {
    throw runtimeError('RUN_INPUT_INVALID', `${field} must be an ISO date`)
  }
  return normalized
}

function optionalString(value, field) {
  return nullableString(value, field)
}

function optionalJson(value, field) {
  if (value === null || value === undefined) return null
  try {
    return JSON.stringify(value)
  } catch {
    throw runtimeError('RUN_INPUT_INVALID', `${field} must be JSON serializable`)
  }
}

function harden(databasePath) {
  for (const path of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
    try {
      chmodSync(path, 0o600)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
}
