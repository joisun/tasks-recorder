import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

import { parseScheduleDefinition, serializeScheduleDefinition } from './schedule-definition-codec.mjs'
import { SchedulerError } from './scheduler-errors.mjs'
import {
  checkSchedulerSchemaInvariants,
  createRunSchema,
  createSchedulerSchema,
  RUN_SCHEMA_VERSION,
  SCHEDULER_SCHEMA_VERSION,
} from './scheduler-schema.mjs'

function fail(code, message, details) { throw new SchedulerError(code, message, details) }

function legacyDefinition(row) {
  let cadence
  try { cadence = JSON.parse(row.cadence_json) } catch { fail('SCHEDULE_MIGRATION_INVALID', `Legacy Schedule ${row.id} has invalid cadence JSON`, { id: row.id }) }
  return {
    id: row.id,
    title: row.title,
    prompt: row.prompt,
    workspace: row.workspace,
    cadence,
    enabled: row.enabled === 1,
    sandbox_mode: row.sandbox_mode,
    model: row.model,
    reasoning_effort: row.reasoning_effort,
    timeout_seconds: row.timeout_seconds,
  }
}

function executable(value) {
  return JSON.stringify({
    id: value.id,
    title: value.title,
    prompt: value.prompt,
    workspace: value.workspace,
    cadence: value.cadence,
    enabled: value.enabled === true || value.enabled === 1,
    sandbox_mode: value.sandbox_mode,
    model: value.model ?? null,
    reasoning_effort: value.reasoning_effort ?? null,
    timeout_seconds: value.timeout_seconds,
  })
}

function validatedLegacyDefinition(row, clock) {
  const value = legacyDefinition(row)
  const source = serializeScheduleDefinition(value, { clock })
  return parseScheduleDefinition(source, { clock })
}

async function rollbackCreated(repository, created) {
  for (const definition of [...created].reverse()) {
    try { await repository.remove(definition.id, definition.etag) } catch {}
  }
}

function migrateLedger(databasePath, definitions, clock) {
  const db = new DatabaseSync(databasePath)
  db.exec('PRAGMA foreign_keys = OFF')
  db.exec('BEGIN IMMEDIATE')
  try {
    const version = db.prepare('PRAGMA user_version').get().user_version
    if (version !== 1) fail('SCHEDULE_SCHEMA_VERSION_UNSUPPORTED', `Expected scheduler schema v1, received v${version}`)
    db.exec(`
      ALTER TABLE scheduled_runs RENAME TO scheduled_runs_v1;
      ALTER TABLE scheduled_dispatches RENAME TO scheduled_dispatches_v1;
      ALTER TABLE scheduled_jobs RENAME TO scheduled_jobs_v1;
      PRAGMA user_version = 0;
    `)
    createSchedulerSchema(db)

    const legacyJobs = db.prepare('SELECT * FROM scheduled_jobs_v1 WHERE deleted_at IS NULL').all()
    const insertSync = db.prepare(`INSERT INTO scheduled_sync_state (
      schedule_id, definition_etag, generation, sync_state, sync_error_code, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)`)
    for (const job of legacyJobs) {
      const definition = definitions.get(job.id)
      if (!definition) continue
      const state = ['synced', 'error', 'unsupported'].includes(job.sync_state) ? job.sync_state : 'pending'
      insertSync.run(job.id, definition.etag, Math.max(1, job.schedule_generation), state, state === 'synced' ? null : job.sync_error_code, job.updated_at)
    }

    const legacyDispatches = db.prepare('SELECT * FROM scheduled_dispatches_v1 ORDER BY created_at, id').all()
    const insertDispatch = db.prepare(`INSERT INTO scheduled_dispatches (
      id, job_id, trigger, state, requested_at, consumed_at, run_id, canceled_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    for (const dispatch of legacyDispatches) {
      insertDispatch.run(dispatch.id, dispatch.job_id, dispatch.trigger, dispatch.state, dispatch.requested_at, dispatch.consumed_at, dispatch.run_id, dispatch.canceled_at, dispatch.created_at)
    }

    const legacyRuns = db.prepare('SELECT * FROM scheduled_runs_v1 ORDER BY created_at, id').all()
    const insertRun = db.prepare(`INSERT INTO scheduled_runs (
      id, job_id, dispatch_id, definition_etag, spec_json, trigger, scheduled_for, status,
      run_nonce_hash, claimed_at, thread_id, started_at, heartbeat_at, finished_at, exit_code,
      error_code, final_message, stdout_log_path, stderr_log_path, completion_json,
      reviewed_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    for (const run of legacyRuns) {
      let spec
      try { spec = JSON.parse(run.spec_json) } catch { fail('SCHEDULE_MIGRATION_INVALID', `Legacy Run ${run.id} has invalid spec JSON`, { id: run.id }) }
      if (!spec || typeof spec !== 'object' || Array.isArray(spec)) fail('SCHEDULE_MIGRATION_INVALID', `Legacy Run ${run.id} has invalid spec`, { id: run.id })
      const definitionTag = createHash('sha256').update(run.spec_json).digest('hex')
      insertRun.run(
        run.id, run.job_id, run.dispatch_id, definitionTag, run.spec_json, run.trigger,
        run.scheduled_for, run.status, run.run_nonce_hash, run.claimed_at, run.thread_id,
        run.started_at, run.heartbeat_at, run.finished_at, run.exit_code, run.error_code,
        run.final_message, run.stdout_log_path, run.stderr_log_path, run.completion_json,
        run.reviewed_at, run.created_at, run.updated_at,
      )
    }
    db.exec('DROP TABLE scheduled_runs_v1; DROP TABLE scheduled_dispatches_v1; DROP TABLE scheduled_jobs_v1;')
    const checked = checkSchedulerSchemaInvariants(db)
    if (checked.integrityCheck !== 'ok' || checked.foreignKeyViolations.length > 0 || checked.invariantViolations.length > 0) {
      fail('SCHEDULE_MIGRATION_INVARIANT_FAILED', 'Migrated scheduler ledger failed integrity checks')
    }
    db.exec('COMMIT')
    db.exec('PRAGMA foreign_keys = ON')
    return { runs: legacyRuns.length, dispatches: legacyDispatches.length }
  } catch (error) {
    try { db.exec('ROLLBACK') } catch {}
    throw error
  } finally { db.close() }
}

function migrateV2Ledger(databasePath) {
  const db = new DatabaseSync(databasePath)
  db.exec('BEGIN IMMEDIATE')
  try {
    const version = db.prepare('PRAGMA user_version').get().user_version
    if (version !== 2) fail('SCHEDULE_SCHEMA_VERSION_UNSUPPORTED', `Expected scheduler schema v2, received v${version}`)
    const runs = db.prepare('SELECT count(*) AS count FROM scheduled_runs').get().count
    const dispatches = db.prepare('SELECT count(*) AS count FROM scheduled_dispatches').get().count
    db.exec(`
      ALTER TABLE scheduled_dispatches ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0);
      ALTER TABLE scheduled_dispatches ADD COLUMN last_attempted_at TEXT;
      ALTER TABLE scheduled_dispatches ADD COLUMN last_error_code TEXT;
      ALTER TABLE scheduled_runs ADD COLUMN file_changes_json TEXT CHECK(file_changes_json IS NULL OR json_valid(file_changes_json));
      PRAGMA user_version = 3;
    `)
    const checked = checkSchedulerSchemaInvariants(db)
    if (checked.integrityCheck !== 'ok' || checked.foreignKeyViolations.length > 0 || checked.invariantViolations.length > 0) {
      fail('SCHEDULE_MIGRATION_INVARIANT_FAILED', 'Migrated scheduler ledger failed integrity checks')
    }
    db.exec('COMMIT')
    return { migrated: true, reason: 'v2_to_v3', definitions: 0, runs, dispatches }
  } catch (error) {
    try { db.exec('ROLLBACK') } catch {}
    throw error
  } finally { db.close() }
}

export function migrateSchedulerV4({
  databasePath,
  clock = () => new Date(),
} = {}) {
  if (typeof databasePath !== 'string' || databasePath.length === 0) {
    throw new TypeError('databasePath is required')
  }
  const timestampValue = clock()
  const timestamp = (timestampValue instanceof Date
    ? timestampValue
    : new Date(timestampValue)).toISOString()
  const db = new DatabaseSync(databasePath)
  db.exec('BEGIN IMMEDIATE')
  try {
    const version = db.prepare('PRAGMA user_version').get().user_version
    if (version === RUN_SCHEMA_VERSION) {
      db.exec('ROLLBACK')
      return { migrated: false, reason: 'already_v4', runs: 0 }
    }
    if (version === 0) {
      createRunSchema(db)
      db.exec('COMMIT')
      return { migrated: true, reason: 'initialized_v4', runs: 0 }
    }
    if (version !== SCHEDULER_SCHEMA_VERSION) {
      fail(
        'SCHEDULE_SCHEMA_VERSION_UNSUPPORTED',
        `Expected scheduler schema v${SCHEDULER_SCHEMA_VERSION}, received v${version}`,
      )
    }
    const legacyRuns = db.prepare(
      'SELECT * FROM scheduled_runs ORDER BY created_at, id',
    ).all()

    db.exec(`
      ALTER TABLE scheduled_runs RENAME TO scheduled_runs_v3;
      DROP INDEX IF EXISTS scheduled_runs_one_active_per_job;
      DROP INDEX IF EXISTS scheduled_runs_job_history;
      DROP INDEX IF EXISTS scheduled_runs_review_queue;
    `)
    createRunSchema(db)

    const insert = db.prepare(`
      INSERT INTO scheduled_runs (
        id, schedule_id, definition_etag, runtime_id, origin,
        occurrence_key, idempotency_key, scheduled_for, status,
        snapshot_json, runtime_version, executable_digest, pid, session_id,
        created_at, started_at, finished_at, exit_code, error_code,
        final_message, usage_json, file_changes_json, stdout_log_path,
        stderr_log_path, reviewed_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?
      )
    `)

    for (const legacy of legacyRuns) {
      const snapshot = parseLegacyJson(legacy.spec_json, legacy.id, 'spec_json')
      const completion = legacy.completion_json === null
        ? null
        : parseLegacyJson(legacy.completion_json, legacy.id, 'completion_json')
      const status = migrateRunStatus(legacy.status)
      const finishedAt = ['queued', 'running'].includes(status)
        ? null
        : (legacy.finished_at ?? timestamp)
      const errorCode = migrationErrorCode(legacy, status)
      const runtimeId = typeof snapshot.agent === 'string'
        && /^[a-z][a-z0-9-]{0,63}$/.test(snapshot.agent)
        ? snapshot.agent
        : 'codex'

      insert.run(
        legacy.id,
        legacy.job_id,
        legacy.definition_etag,
        runtimeId,
        legacy.trigger,
        legacy.trigger === 'manual' ? legacy.dispatch_id : null,
        legacy.scheduled_for,
        status,
        legacy.spec_json,
        legacy.thread_id,
        legacy.created_at,
        legacy.started_at,
        finishedAt,
        legacy.exit_code,
        errorCode,
        legacy.final_message,
        completion && Object.hasOwn(completion, 'usage')
          ? JSON.stringify(completion.usage)
          : null,
        legacy.file_changes_json,
        legacy.stdout_log_path,
        legacy.stderr_log_path,
        legacy.reviewed_at,
        legacy.updated_at,
      )
    }

    db.exec('DROP TABLE scheduled_runs_v3')
    const integrity = db.prepare('PRAGMA integrity_check').get().integrity_check
    if (integrity !== 'ok') {
      fail(
        'SCHEDULE_MIGRATION_INVARIANT_FAILED',
        'Migrated Run ledger failed integrity checks',
      )
    }
    db.exec('COMMIT')
    return { migrated: true, reason: 'v3_to_v4', runs: legacyRuns.length }
  } catch (error) {
    try { db.exec('ROLLBACK') } catch {}
    throw error
  } finally {
    db.close()
  }
}

function parseLegacyJson(source, runId, field) {
  try {
    const value = JSON.parse(source)
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error()
    return value
  } catch {
    fail(
      'SCHEDULE_MIGRATION_INVALID',
      `Legacy Run ${runId} has invalid ${field}`,
      { id: runId, field },
    )
  }
}

function migrateRunStatus(status) {
  if (['succeeded', 'failed', 'timed_out', 'canceled'].includes(status)) return status
  if (['claimed', 'running', 'lost'].includes(status)) return 'interrupted'
  if (status === 'skipped_overlap') return 'failed'
  fail('SCHEDULE_MIGRATION_INVALID', `Legacy Run has unsupported status ${status}`)
}

function migrationErrorCode(legacy, status) {
  if (legacy.status === 'skipped_overlap') return legacy.error_code ?? 'SCHEDULE_OVERLAP'
  if (status === 'interrupted') {
    return legacy.error_code ?? 'TASKD_MIGRATION_INTERRUPTED'
  }
  return legacy.error_code
}

export async function migrateSchedulerV1({
  databasePath,
  repository,
  clock = () => new Date(),
  beforeLedgerMigration = () => undefined,
} = {}) {
  if (typeof databasePath !== 'string' || !repository?.scan || !repository?.create || !repository?.remove) {
    throw new TypeError('databasePath and definition repository are required')
  }
  const inspection = new DatabaseSync(databasePath)
  let version
  let legacyJobs
  try {
    version = inspection.prepare('PRAGMA user_version').get().user_version
    if (version === RUN_SCHEMA_VERSION) return { migrated: false, reason: 'already_v4', definitions: 0, runs: 0, dispatches: 0 }
    if (version === SCHEDULER_SCHEMA_VERSION) return { migrated: false, reason: 'already_v3', definitions: 0, runs: 0, dispatches: 0 }
    if (version === 0) return { migrated: false, reason: 'empty', definitions: 0, runs: 0, dispatches: 0 }
    if (version === 2) return migrateV2Ledger(databasePath)
    if (version !== 1) fail('SCHEDULE_SCHEMA_VERSION_UNSUPPORTED', `scheduler schema v${version} cannot migrate to v${SCHEDULER_SCHEMA_VERSION}`)
    legacyJobs = inspection.prepare('SELECT * FROM scheduled_jobs WHERE deleted_at IS NULL ORDER BY created_at, id').all()
  } finally { inspection.close() }

  const scanned = await repository.scan()
  if (scanned.invalid.length > 0) fail('SCHEDULE_MIGRATION_CONFLICT', 'Definitions directory contains invalid Schedule files', { count: scanned.invalid.length })
  const existing = new Map(scanned.jobs.map((definition) => [definition.id, definition]))
  const planned = legacyJobs.map((row) => ({ row, definition: validatedLegacyDefinition(row, clock) }))
  for (const { row, definition } of planned) {
    const current = existing.get(row.id)
    if (current && executable(current) !== executable(definition)) {
      fail('SCHEDULE_MIGRATION_CONFLICT', `Schedule ${row.id} conflicts with an existing Markdown definition`, { id: row.id, source_path: current.source_path })
    }
  }

  const created = []
  const definitions = new Map(existing)
  try {
    for (const { row, definition } of planned) {
      if (definitions.has(row.id)) continue
      const written = await repository.create(definition)
      created.push(written)
      definitions.set(written.id, written)
    }
    await beforeLedgerMigration()
    const ledger = migrateLedger(databasePath, definitions, clock)
    return { migrated: true, definitions: planned.length, ...ledger }
  } catch (error) {
    await rollbackCreated(repository, created)
    throw error
  }
}
