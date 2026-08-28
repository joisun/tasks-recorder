import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'

import { createScheduleDefinitionRepository } from '../server/src/scheduler/schedule-definition-repository.mjs'
import { migrateSchedulerV1 } from '../server/src/scheduler/scheduler-migration.mjs'

const NOW = '2026-08-25T09:00:00.000Z'

function createV1(databasePath, { id = randomUUID(), title = 'Legacy brief' } = {}) {
  const db = new DatabaseSync(databasePath)
  db.exec(`
    CREATE TABLE scheduled_jobs (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, prompt TEXT NOT NULL, workspace TEXT NOT NULL,
      cadence_json TEXT NOT NULL, timezone_mode TEXT NOT NULL, thread_mode TEXT NOT NULL,
      sandbox_mode TEXT NOT NULL, model TEXT, reasoning_effort TEXT, timeout_seconds INTEGER NOT NULL,
      enabled INTEGER NOT NULL, revision INTEGER NOT NULL, schedule_generation INTEGER NOT NULL,
      sync_state TEXT NOT NULL, sync_error_code TEXT, next_run_at TEXT, last_run_at TEXT,
      deleted_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE scheduled_dispatches (
      id TEXT PRIMARY KEY, job_id TEXT NOT NULL, trigger TEXT NOT NULL, state TEXT NOT NULL,
      requested_at TEXT NOT NULL, consumed_at TEXT, run_id TEXT, canceled_at TEXT, created_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE scheduled_runs (
      id TEXT PRIMARY KEY, job_id TEXT NOT NULL, dispatch_id TEXT UNIQUE, job_revision INTEGER NOT NULL,
      spec_json TEXT NOT NULL, trigger TEXT NOT NULL, scheduled_for TEXT, status TEXT NOT NULL,
      run_nonce_hash TEXT, claimed_at TEXT, thread_id TEXT, started_at TEXT, heartbeat_at TEXT,
      finished_at TEXT, exit_code INTEGER, error_code TEXT, final_message TEXT, stdout_log_path TEXT,
      stderr_log_path TEXT, completion_json TEXT, reviewed_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    ) STRICT;
    PRAGMA user_version = 1;
  `)
  const cadence = JSON.stringify({ kind: 'daily', hour: 9, minute: 30, timezone_mode: 'system' })
  db.prepare(`INSERT INTO scheduled_jobs VALUES (?, ?, ?, ?, ?, 'system', 'new', 'read-only', NULL, 'high', 7200, 1, 3, 4, 'synced', NULL, ?, ?, NULL, ?, ?)`)
    .run(id, title, 'Summarize yesterday.', '/tmp/project', cadence, '2026-08-26T09:30:00.000Z', NOW, NOW, NOW)
  const runId = randomUUID()
  const spec = JSON.stringify({
    job_id: id, job_revision: 3, title, prompt: 'Old executed prompt.', workspace: '/tmp/project',
    cadence: JSON.parse(cadence), timezone_mode: 'system', thread_mode: 'new', sandbox_mode: 'read-only',
    model: null, reasoning_effort: 'high', timeout_seconds: 7200,
  })
  const completion = JSON.stringify({ status: 'succeeded', finished_at: NOW, thread_id: 'thread-old' })
  db.prepare(`INSERT INTO scheduled_runs VALUES (?, ?, NULL, 3, ?, 'scheduled', ?, 'succeeded', ?, ?, 'thread-old', ?, ?, ?, 0, NULL, 'Done.', NULL, NULL, ?, NULL, ?, ?)`)
    .run(runId, id, spec, NOW, 'a'.repeat(64), NOW, NOW, NOW, NOW, completion, NOW, NOW)
  db.close()
  return { id, runId, title }
}

async function fixture(t, legacy = {}) {
  const root = await mkdtemp(join(tmpdir(), 'tasks-recorder-migration-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const databasePath = join(root, 'scheduler.sqlite')
  const definitionsRoot = join(root, 'definitions')
  const legacyData = createV1(databasePath, legacy)
  const repository = createScheduleDefinitionRepository({ rootDirectory: definitionsRoot, clock: () => new Date(NOW) })
  return { root, databasePath, definitionsRoot, repository, ...legacyData }
}

test('migrates v1 definitions to Markdown and preserves immutable Run history in ledger v3', async (t) => {
  const current = await fixture(t)
  const result = await migrateSchedulerV1({ databasePath: current.databasePath, repository: current.repository, clock: () => new Date(NOW) })
  assert.deepEqual(result, { migrated: true, definitions: 1, runs: 1, dispatches: 0 })
  const definitions = await current.repository.scan()
  assert.equal(definitions.jobs.length, 1)
  assert.equal(definitions.jobs[0].id, current.id)
  assert.equal(definitions.jobs[0].prompt, 'Summarize yesterday.')

  const db = new DatabaseSync(current.databasePath, { readOnly: true })
  try {
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 3)
    assert.equal(db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE name='scheduled_jobs'").get().count, 0)
    const run = db.prepare('SELECT * FROM scheduled_runs WHERE id=?').get(current.runId)
    assert.equal(run.job_id, current.id)
    assert.equal(JSON.parse(run.spec_json).prompt, 'Old executed prompt.')
    assert.match(run.definition_etag, /^[0-9a-f]{64}$/)
  } finally { db.close() }
  assert.deepEqual(await migrateSchedulerV1({ databasePath: current.databasePath, repository: current.repository }), {
    migrated: false, reason: 'already_v3', definitions: 0, runs: 0, dispatches: 0,
  })
})

test('migrates a v2 ledger in place and preserves pending dispatches and Run history', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'tasks-recorder-migration-v2-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const databasePath = join(root, 'scheduler.sqlite')
  const repository = createScheduleDefinitionRepository({ rootDirectory: join(root, 'definitions'), clock: () => new Date(NOW) })
  await repository.scan()
  const jobId = randomUUID()
  const runId = randomUUID()
  const db = new DatabaseSync(databasePath)
  db.exec(`
    CREATE TABLE scheduled_sync_state (
      schedule_id TEXT PRIMARY KEY, definition_etag TEXT NOT NULL, generation INTEGER NOT NULL,
      sync_state TEXT NOT NULL, sync_error_code TEXT, updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE scheduled_dispatches (
      id TEXT PRIMARY KEY, job_id TEXT NOT NULL, trigger TEXT NOT NULL, state TEXT NOT NULL,
      requested_at TEXT NOT NULL, consumed_at TEXT, run_id TEXT, canceled_at TEXT, created_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE scheduled_runs (
      id TEXT PRIMARY KEY, job_id TEXT NOT NULL, dispatch_id TEXT UNIQUE, definition_etag TEXT NOT NULL,
      spec_json TEXT NOT NULL, trigger TEXT NOT NULL, scheduled_for TEXT, status TEXT NOT NULL,
      run_nonce_hash TEXT, claimed_at TEXT, thread_id TEXT, started_at TEXT, heartbeat_at TEXT,
      finished_at TEXT, exit_code INTEGER, error_code TEXT, final_message TEXT, stdout_log_path TEXT,
      stderr_log_path TEXT, completion_json TEXT, reviewed_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    ) STRICT;
    PRAGMA user_version = 2;
  `)
  db.prepare(`INSERT INTO scheduled_runs VALUES (?, ?, NULL, ?, ?, 'scheduled', NULL, 'succeeded', ?, ?, 'thread-v2', ?, ?, ?, 0, NULL, 'Done', NULL, NULL, ?, NULL, ?, ?)`)
    .run(runId, jobId, 'a'.repeat(64), JSON.stringify({ workspace: '/tmp/project' }), 'b'.repeat(64), NOW, NOW, NOW, NOW, JSON.stringify({ status: 'succeeded', finished_at: NOW }), NOW, NOW)
  db.close()

  const result = await migrateSchedulerV1({ databasePath, repository })
  assert.deepEqual(result, { migrated: true, reason: 'v2_to_v3', definitions: 0, runs: 1, dispatches: 0 })
  const migrated = new DatabaseSync(databasePath, { readOnly: true })
  try {
    assert.equal(migrated.prepare('PRAGMA user_version').get().user_version, 3)
    const run = migrated.prepare('SELECT file_changes_json FROM scheduled_runs WHERE id = ?').get(runId)
    assert.equal(run.file_changes_json, null)
  } finally { migrated.close() }
})

test('aborts before database mutation when a target definition conflicts', async (t) => {
  const current = await fixture(t)
  await current.repository.create({
    id: current.id, title: 'Conflicting file', prompt: 'Different.', workspace: '/tmp/project',
    cadence: { kind: 'daily', hour: 9, minute: 30 }, sandbox_mode: 'read-only', timeout_seconds: 7200,
  })
  await assert.rejects(
    () => migrateSchedulerV1({ databasePath: current.databasePath, repository: current.repository }),
    (error) => error.code === 'SCHEDULE_MIGRATION_CONFLICT',
  )
  const db = new DatabaseSync(current.databasePath, { readOnly: true })
  try { assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1) } finally { db.close() }
})

test('moves newly written definitions out of the active registry when ledger migration fails', async (t) => {
  const current = await fixture(t)
  await assert.rejects(() => migrateSchedulerV1({
    databasePath: current.databasePath,
    repository: current.repository,
    beforeLedgerMigration: () => { throw Object.assign(new Error('injected'), { code: 'INJECTED' }) },
  }), /injected/)
  assert.equal((await current.repository.scan()).jobs.length, 0)
  const db = new DatabaseSync(current.databasePath, { readOnly: true })
  try { assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1) } finally { db.close() }
})
