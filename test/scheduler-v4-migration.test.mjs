import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import { migrateSchedulerV4 } from '../server/src/scheduler/scheduler-migration.mjs'
import { createSchedulerSchema } from '../server/src/scheduler/scheduler-schema.mjs'

const NOW = '2026-08-27T09:00:00.000Z'

function legacyRun({ scheduleId, status, trigger = 'scheduled' }) {
  const open = ['claimed', 'running'].includes(status)
  const overlap = status === 'skipped_overlap'
  return {
    id: randomUUID(),
    job_id: scheduleId,
    dispatch_id: null,
    definition_etag: 'a'.repeat(64),
    spec_json: JSON.stringify({
      job_id: scheduleId,
      definition_etag: 'a'.repeat(64),
      title: 'Legacy Run',
      prompt: `Prompt for ${status}`,
      workspace: '/tmp/project',
      cadence: { kind: 'daily', hour: 9, minute: 30, timezone_mode: 'system' },
      timezone_mode: 'system',
      thread_mode: 'new',
      sandbox_mode: 'read-only',
      model: null,
      reasoning_effort: null,
      timeout_seconds: 7_200,
    }),
    trigger,
    scheduled_for: NOW,
    status,
    run_nonce_hash: overlap ? null : 'b'.repeat(64),
    claimed_at: overlap ? null : NOW,
    thread_id: status === 'succeeded' ? 'session-old' : null,
    started_at: status === 'claimed' || overlap ? null : NOW,
    heartbeat_at: overlap ? null : NOW,
    finished_at: open ? null : NOW,
    exit_code: status === 'succeeded' ? 0 : null,
    error_code: overlap ? 'SCHEDULE_OVERLAP' : null,
    final_message: status === 'succeeded' ? 'Done.' : null,
    stdout_log_path: status === 'succeeded' ? '/tmp/stdout.log' : null,
    stderr_log_path: null,
    file_changes_json: status === 'succeeded'
      ? JSON.stringify([{ path: 'README.md', kind: 'update' }])
      : null,
    completion_json: open ? null : JSON.stringify({ status, finished_at: NOW }),
    reviewed_at: status === 'succeeded' ? NOW : null,
    created_at: NOW,
    updated_at: NOW,
  }
}

function insertLegacyRun(db, run) {
  db.prepare(`
    INSERT INTO scheduled_runs (
      id, job_id, dispatch_id, definition_etag, spec_json, trigger,
      scheduled_for, status, run_nonce_hash, claimed_at, thread_id,
      started_at, heartbeat_at, finished_at, exit_code, error_code,
      final_message, stdout_log_path, stderr_log_path, file_changes_json,
      completion_json, reviewed_at, created_at, updated_at
    ) VALUES (
      @id, @job_id, @dispatch_id, @definition_etag, @spec_json, @trigger,
      @scheduled_for, @status, @run_nonce_hash, @claimed_at, @thread_id,
      @started_at, @heartbeat_at, @finished_at, @exit_code, @error_code,
      @final_message, @stdout_log_path, @stderr_log_path, @file_changes_json,
      @completion_json, @reviewed_at, @created_at, @updated_at
    )
  `).run(run)
}

test('migrates v3 Runs to the unified v4 ledger without inventing dispatch Runs', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'tasks-recorder-v4-migration-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const databasePath = join(root, 'scheduler.sqlite')
  const db = new DatabaseSync(databasePath)
  createSchedulerSchema(db)
  const scheduleId = randomUUID()
  const runs = [
    legacyRun({ scheduleId, status: 'succeeded' }),
    legacyRun({ scheduleId: randomUUID(), status: 'running' }),
    legacyRun({ scheduleId: randomUUID(), status: 'skipped_overlap' }),
  ]
  for (const run of runs) insertLegacyRun(db, run)
  db.prepare(`
    INSERT INTO scheduled_dispatches (
      id, job_id, trigger, state, requested_at, consumed_at, run_id,
      canceled_at, created_at
    ) VALUES (?, ?, 'manual', 'pending', ?, NULL, NULL, NULL, ?)
  `).run(randomUUID(), randomUUID(), NOW, NOW)
  db.close()

  assert.deepEqual(migrateSchedulerV4({ databasePath, clock: () => new Date(NOW) }), {
    migrated: true,
    reason: 'v3_to_v4',
    runs: 3,
  })

  const migrated = new DatabaseSync(databasePath, { readOnly: true })
  try {
    assert.equal(migrated.prepare('PRAGMA user_version').get().user_version, 4)
    const rows = migrated.prepare('SELECT * FROM scheduled_runs ORDER BY id').all()
    assert.equal(rows.length, 3)
    const succeeded = rows.find(({ id }) => id === runs[0].id)
    assert.equal(succeeded.schedule_id, runs[0].job_id)
    assert.equal(succeeded.runtime_id, 'codex')
    assert.equal(succeeded.origin, 'scheduled')
    assert.equal(succeeded.status, 'succeeded')
    assert.equal(succeeded.session_id, 'session-old')
    assert.equal(JSON.parse(succeeded.snapshot_json).prompt, 'Prompt for succeeded')
    assert.deepEqual(JSON.parse(succeeded.file_changes_json), [
      { path: 'README.md', kind: 'update' },
    ])
    assert.equal(rows.find(({ id }) => id === runs[1].id).status, 'interrupted')
    const overlap = rows.find(({ id }) => id === runs[2].id)
    assert.equal(overlap.status, 'failed')
    assert.equal(overlap.error_code, 'SCHEDULE_OVERLAP')
  } finally {
    migrated.close()
  }
})

test('v4 migration rolls back atomically when legacy Run JSON is malformed', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'tasks-recorder-v4-rollback-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const databasePath = join(root, 'scheduler.sqlite')
  const db = new DatabaseSync(databasePath)
  createSchedulerSchema(db)
  const run = legacyRun({ scheduleId: randomUUID(), status: 'succeeded' })
  insertLegacyRun(db, run)
  db.exec('PRAGMA ignore_check_constraints = ON')
  db.prepare('UPDATE scheduled_runs SET spec_json = ? WHERE id = ?')
    .run('{malformed', run.id)
  db.close()

  assert.throws(
    () => migrateSchedulerV4({ databasePath, clock: () => new Date(NOW) }),
    { code: 'SCHEDULE_MIGRATION_INVALID' },
  )

  const rolledBack = new DatabaseSync(databasePath, { readOnly: true })
  try {
    assert.equal(rolledBack.prepare('PRAGMA user_version').get().user_version, 3)
    const columns = rolledBack.prepare('PRAGMA table_info(scheduled_runs)').all()
      .map(({ name }) => name)
    assert.equal(columns.includes('job_id'), true)
    assert.equal(columns.includes('schedule_id'), false)
    assert.equal(
      rolledBack.prepare('SELECT spec_json FROM scheduled_runs WHERE id = ?').get(run.id)
        .spec_json,
      '{malformed',
    )
  } finally {
    rolledBack.close()
  }
})

test('initializes an empty scheduler database directly as the v4 Run ledger', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'tasks-recorder-v4-empty-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const databasePath = join(root, 'scheduler.sqlite')

  assert.deepEqual(migrateSchedulerV4({ databasePath }), {
    migrated: true,
    reason: 'initialized_v4',
    runs: 0,
  })

  const database = new DatabaseSync(databasePath, { readOnly: true })
  try {
    assert.equal(database.prepare('PRAGMA user_version').get().user_version, 4)
  } finally {
    database.close()
  }
})
