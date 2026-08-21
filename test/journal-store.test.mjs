import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import { createJournalStore } from '../mcp/src/journal-store.mjs'
import { createTaskStore } from '../mcp/src/task-store.mjs'
import { taskInput } from './helpers.mjs'

test('JournalStore creates and composes a canonical schema v3 database', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tasks-recorder-journal-store-'))
  const databasePath = join(directory, 'tasks.sqlite')
  let store
  try {
    store = createJournalStore({
      databasePath,
      clock: () => new Date('2026-08-19T01:00:00.000Z'),
    })
    store.projects.create({ id: 'project-a', name: 'Project A' })
    store.tasks.create({
      id: 'main-task',
      project_id: 'project-a',
      title: 'Main task',
      lifecycle: 'in_progress',
    })
    store.work.startExecution({
      id: 'execution-1',
      source: 'codex',
      source_session_key: 'session-1',
      root_session_key: 'session-1',
      project_id: 'project-a',
      source_turn_key: 'turn-1',
      kind: 'main',
      started_at: '2026-08-19T01:00:00.000Z',
    })
    store.work.focus({
      execution_id: 'execution-1',
      task_id: 'main-task',
      provenance: 'agent_explicit',
      rationale_code: 'selected_task',
      observed_at: '2026-08-19T01:00:00.000Z',
    })

    assert.deepEqual(store.check(), {
      schemaVersion: 3,
      integrityCheck: 'ok',
      foreignKeyViolations: [],
      invariantViolations: [],
    })
    const snapshot = store.snapshot()
    assert.equal(snapshot.projects.length, 1)
    assert.equal(snapshot.tasks.length, 1)
    assert.equal(snapshot.executions.length, 1)
    assert.equal(snapshot.segments[0].task_id, 'main-task')
  } finally {
    store?.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('JournalStore refuses v2 without mutating it while the current v2 runtime remains usable', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tasks-recorder-journal-v2-gate-'))
  const databasePath = join(directory, 'tasks.sqlite')
  let db
  try {
    const legacy = createTaskStore({ databasePath })
    legacy.upsert(taskInput({ id: 'legacy-task', title: 'Legacy task' }))
    legacy.close()

    assert.throws(
      () => createJournalStore({ databasePath }),
      (error) => error.code === 'SCHEMA_MIGRATION_REQUIRED'
        && error.details.actual === 2
        && error.details.expected === 3,
    )
    db = new DatabaseSync(databasePath)
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 2)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM tasks').get().count, 1)
    db.close()
    db = null

    const legacyAgain = createTaskStore({ databasePath })
    assert.equal(legacyAgain.show('legacy-task').task.title, 'Legacy task')
    legacyAgain.close()
  } finally {
    db?.close()
    await rm(directory, { recursive: true, force: true })
  }
})
