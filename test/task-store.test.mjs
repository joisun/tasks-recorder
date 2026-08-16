import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import { createTaskStore } from '../mcp/src/task-store.mjs'
import { taskInput, temporaryStore } from './helpers.mjs'

test('opens a schema-v1 database by adding nullable task_sessions.agent', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tasks-recorder-migration-'))
  const databasePath = join(directory, 'tasks.sqlite')
  const db = new DatabaseSync(databasePath)
  db.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, parent_id TEXT, project TEXT NOT NULL, title TEXT NOT NULL,
      status TEXT NOT NULL, start_date TEXT NOT NULL, due_date TEXT, next_action TEXT,
      completed_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE task_sessions (
      task_id TEXT NOT NULL, session_id TEXT NOT NULL, workfolder TEXT NOT NULL,
      git_root TEXT, worktree TEXT, branch TEXT, first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL, PRIMARY KEY(task_id, session_id)
    ) STRICT;
    PRAGMA user_version = 1;
  `)
  db.close()

  const store = createTaskStore({ databasePath })
  try {
    store.upsert(taskInput())
    assert.equal(store.show('example-task').sessions[0].agent, 'Codex')
  } finally {
    store.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('heartbeat updates only the most recently bound unfinished task', async () => {
  let current = new Date('2026-08-12T08:00:00.000Z')
  const fixture = await temporaryStore({ clock: () => current })
  try {
    fixture.store.upsert(taskInput({ id: 'older-task', title: 'Older task' }))
    current = new Date('2026-08-12T08:01:00.000Z')
    fixture.store.upsert(taskInput({ id: 'current-task', title: 'Current task' }))
    current = new Date('2026-08-12T08:02:00.000Z')

    assert.deepEqual(fixture.store.heartbeat({
      session_id: 'session-1',
      agent: 'Codex',
      minimum_interval_ms: 10_000,
    }), {
      updated: true,
      task_id: 'current-task',
      last_seen_at: '2026-08-12T08:02:00.000Z',
    })
    assert.equal(
      fixture.store.show('older-task').sessions[0].last_seen_at,
      '2026-08-12T08:00:00.000Z',
    )
  } finally {
    await fixture.cleanup()
  }
})

test('heartbeat is throttled and ignores sessions without unfinished tasks', async () => {
  let current = new Date('2026-08-12T08:00:00.000Z')
  const fixture = await temporaryStore({ clock: () => current })
  try {
    assert.deepEqual(fixture.store.heartbeat({ session_id: 'missing' }), {
      updated: false,
      reason: 'no-active-task',
    })
    fixture.store.upsert(taskInput())
    current = new Date('2026-08-12T08:00:05.000Z')
    assert.deepEqual(fixture.store.heartbeat({
      session_id: 'session-1',
      minimum_interval_ms: 10_000,
    }), {
      updated: false,
      reason: 'throttled',
      task_id: 'example-task',
      last_seen_at: '2026-08-12T08:00:00.000Z',
    })
    current = new Date('2026-08-12T08:01:00.000Z')
    fixture.store.complete(taskInput())
    current = new Date('2026-08-12T08:02:00.000Z')
    assert.deepEqual(fixture.store.heartbeat({ session_id: 'session-1' }), {
      updated: false,
      reason: 'no-active-task',
    })
  } finally {
    await fixture.cleanup()
  }
})

test('rejects impossible calendar dates and accepts leap day', async () => {
  const fixture = await temporaryStore()
  try {
    assert.throws(
      () => fixture.store.upsert(taskInput({ start_date: '2026-02-30' })),
      (error) => error.code === 'TASK_DATE_INVALID',
    )
    const result = fixture.store.upsert(taskInput({ start_date: '2028-02-29' }))
    assert.equal(result.task.start_date, '2028-02-29')
  } finally {
    await fixture.cleanup()
  }
})

test('status mutation enforces optimistic concurrency and completion timestamps', async () => {
  let current = new Date('2026-08-12T08:00:00.000Z')
  const fixture = await temporaryStore({ clock: () => current })
  try {
    const created = fixture.store.upsert(taskInput()).task
    current = new Date('2026-08-12T08:10:00.000Z')
    const done = fixture.store.updateStatus({
      id: created.id,
      status: 'done',
      expected_updated_at: created.updated_at,
    })
    assert.equal(done.changed, true)
    assert.equal(done.task.completed_at, '2026-08-12T08:10:00.000Z')

    const noop = fixture.store.updateStatus({
      id: created.id,
      status: 'done',
      expected_updated_at: done.task.updated_at,
    })
    assert.equal(noop.changed, false)
    assert.equal(noop.task.updated_at, done.task.updated_at)

    assert.throws(
      () => fixture.store.updateStatus({
        id: created.id,
        status: 'active',
        expected_updated_at: created.updated_at,
      }),
      (error) => error.code === 'TASK_VERSION_CONFLICT'
        && error.details.actual_updated_at === done.task.updated_at,
    )

    const reopenedAtSameClock = fixture.store.updateStatus({
      id: created.id,
      status: 'waiting',
      expected_updated_at: done.task.updated_at,
    })
    assert.notEqual(reopenedAtSameClock.task.updated_at, done.task.updated_at)
    assert.equal(reopenedAtSameClock.task.completed_at, null)
  } finally {
    await fixture.cleanup()
  }
})

test('status mutation blocks incomplete parent and reopens a done parent with its child', async () => {
  let current = new Date('2026-08-12T08:00:00.000Z')
  const fixture = await temporaryStore({ clock: () => current })
  try {
    fixture.store.upsert(taskInput({ id: 'parent', title: 'Parent' }))
    const child = fixture.store.upsert(taskInput({
      id: 'child',
      parent_id: 'parent',
      title: 'Child',
      status: 'active',
    })).task
    const parent = fixture.store.show('parent').task

    assert.throws(
      () => fixture.store.updateStatus({
        id: 'parent',
        status: 'done',
        expected_updated_at: parent.updated_at,
      }),
      (error) => error.code === 'CHILD_TASKS_INCOMPLETE'
        && error.details.child_ids[0] === 'child',
    )

    current = new Date('2026-08-12T08:10:00.000Z')
    const childDone = fixture.store.updateStatus({
      id: 'child',
      status: 'done',
      expected_updated_at: child.updated_at,
    }).task
    const parentReady = fixture.store.show('parent').task
    const parentDone = fixture.store.updateStatus({
      id: 'parent',
      status: 'done',
      expected_updated_at: parentReady.updated_at,
    }).task

    current = new Date('2026-08-12T08:20:00.000Z')
    const reopened = fixture.store.updateStatus({
      id: 'child',
      status: 'blocked',
      expected_updated_at: childDone.updated_at,
    })
    assert.equal(reopened.task.status, 'blocked')
    assert.equal(reopened.task.completed_at, null)
    assert.equal(reopened.affected_parent.status, 'active')
    assert.equal(reopened.affected_parent.completed_at, null)
    assert.notEqual(reopened.affected_parent.updated_at, parentDone.updated_at)
  } finally {
    await fixture.cleanup()
  }
})
