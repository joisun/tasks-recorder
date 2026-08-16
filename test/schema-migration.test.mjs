import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { promisify } from 'node:util'

import { createTaskStore } from '../mcp/src/task-store.mjs'
import { taskInput } from './helpers.mjs'

const execFileAsync = promisify(execFile)

function createV1Database(databasePath, { includeAgent = false } = {}) {
  const db = new DatabaseSync(databasePath)
  db.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, parent_id TEXT REFERENCES tasks(id), project TEXT NOT NULL,
      title TEXT NOT NULL, status TEXT NOT NULL, start_date TEXT NOT NULL, due_date TEXT,
      next_action TEXT, completed_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE task_sessions (
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL, workfolder TEXT NOT NULL, git_root TEXT, worktree TEXT,
      branch TEXT, ${includeAgent ? 'agent TEXT,' : ''} first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL, PRIMARY KEY(task_id, session_id)
    ) STRICT;
    CREATE INDEX tasks_parent_id_idx ON tasks(parent_id);
    PRAGMA user_version = 1;
  `)
  return db
}

test('initializes a new database with schema v2 lifecycle storage', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tasks-recorder-schema-v2-'))
  const databasePath = join(directory, 'tasks.sqlite')
  let store
  let db
  try {
    store = createTaskStore({ databasePath })
    const canceled = store.upsert(taskInput({ status: 'canceled' })).task
    assert.equal(canceled.status, 'canceled')
    store.close()
    store = null

    db = new DatabaseSync(databasePath)
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 2)
    const taskColumns = db.prepare('PRAGMA table_info(tasks)').all().map(({ name }) => name)
    assert.deepEqual(taskColumns, [
      'id', 'parent_id', 'project', 'title', 'description', 'status', 'start_date',
      'due_date', 'next_action', 'agent_key', 'sort_order', 'revision', 'completed_at',
      'archived_at', 'deleted_at', 'created_at', 'updated_at',
    ])
    const tables = db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `).all().map(({ name }) => name)
    assert.deepEqual(tables, [
      'plan_observations',
      'task_events',
      'task_executions',
      'task_sessions',
      'tasks',
    ])
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
  } finally {
    db?.close()
    store?.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('migrates schema v1 task trees and sessions without inventing execution history', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tasks-recorder-schema-v1-'))
  const databasePath = join(directory, 'tasks.sqlite')
  let store
  let db
  try {
    db = createV1Database(databasePath)
    db.exec(`
      INSERT INTO tasks VALUES (
        'root-task', NULL, 'Example', 'Root', 'active', '2026-08-01', NULL, 'Continue',
        NULL, '2026-08-01T01:00:00.000Z', '2026-08-02T01:00:00.000Z'
      );
      INSERT INTO tasks VALUES (
        'child-task', 'root-task', 'Example', 'Child', 'done', '2026-08-01', '2026-08-02', NULL,
        '2026-08-02T00:30:00.000Z', '2026-08-01T02:00:00.000Z', '2026-08-02T00:30:00.000Z'
      );
      INSERT INTO task_sessions VALUES (
        'child-task', 'session-1', '/workspace', '/workspace', '/workspace/.worktree/a',
        'feature/a', '2026-08-01T02:00:00.000Z', '2026-08-02T00:30:00.000Z'
      );
    `)
    db.close()
    db = null

    store = createTaskStore({ databasePath })
    assert.equal(store.check().schemaVersion, 2)
    assert.deepEqual({ ...store.show('child-task').task }, {
      id: 'child-task',
      parent_id: 'root-task',
      project: 'Example',
      title: 'Child',
      description: null,
      status: 'done',
      start_date: '2026-08-01',
      due_date: '2026-08-02',
      next_action: null,
      agent_key: null,
      sort_order: 0,
      revision: 1,
      completed_at: '2026-08-02T00:30:00.000Z',
      archived_at: null,
      deleted_at: null,
      created_at: '2026-08-01T02:00:00.000Z',
      updated_at: '2026-08-02T00:30:00.000Z',
    })
    assert.equal(store.show('child-task').sessions[0].agent, null)
    store.close()
    store = null

    db = new DatabaseSync(databasePath)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM task_executions').get().count, 0)
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
  } finally {
    db?.close()
    store?.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('rejects a database schema newer than this runtime supports', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tasks-recorder-schema-future-'))
  const databasePath = join(directory, 'tasks.sqlite')
  const db = new DatabaseSync(databasePath)
  db.exec('PRAGMA user_version = 3')
  db.close()
  try {
    assert.throws(
      () => createTaskStore({ databasePath }),
      (error) => error.code === 'SCHEMA_VERSION_UNSUPPORTED'
        && error.details.expected === 2
        && error.details.actual === 3,
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('concurrent schema initialization rechecks the version after acquiring the write lock', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tasks-recorder-schema-race-'))
  const databasePath = join(directory, 'tasks.sqlite')
  const blocker = new DatabaseSync(databasePath)
  blocker.exec('PRAGMA journal_mode = WAL')
  blocker.exec('BEGIN IMMEDIATE')
  const moduleUrl = new URL('../mcp/src/task-store.mjs', import.meta.url).href
  const script = `
    import { createTaskStore } from ${JSON.stringify(moduleUrl)}
    const store = createTaskStore({ databasePath: process.argv[1] })
    store.close()
  `
  try {
    const attempts = [1, 2].map(() => execFileAsync(
      process.execPath,
      ['--input-type=module', '--eval', script, databasePath],
    ))
    await new Promise((resolve) => setTimeout(resolve, 150))
    blocker.exec('COMMIT')
    await Promise.all(attempts)

    const db = new DatabaseSync(databasePath)
    try {
      assert.equal(db.prepare('PRAGMA user_version').get().user_version, 2)
      assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
    } finally {
      db.close()
    }
  } finally {
    if (blocker.isTransaction) blocker.exec('ROLLBACK')
    blocker.close()
    await rm(directory, { recursive: true, force: true })
  }
})
