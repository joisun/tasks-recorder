import assert from 'node:assert/strict'
import test from 'node:test'

import { taskInput, temporaryStore } from './helpers.mjs'

function executionRecord(overrides = {}) {
  return {
    external_key: 'codex:turn:root-session:turn-1:0',
    kind: 'main',
    root_session_id: 'root-session',
    session_id: 'root-session',
    turn_id: 'turn-1',
    agent_id: null,
    agent_type: 'Codex',
    agent_path: null,
    parent_external_key: null,
    transcript_path: '/sessions/root-session.jsonl',
    task_id: null,
    classification: 'unknown',
    workfolder: '/workspace/project',
    git_root: null,
    worktree: '/workspace/project',
    branch: 'main',
    status: 'completed',
    started_at: '2026-08-14T01:00:00.000Z',
    last_seen_at: '2026-08-14T01:10:00.000Z',
    ended_at: '2026-08-14T01:10:00.000Z',
    ...overrides,
  }
}

test('execution import dry-run previews exact changes and performs zero writes', async () => {
  const fixture = await temporaryStore()
  try {
    assert.equal(typeof fixture.store.importExecutions, 'function')
    const input = {
      source: 'codex',
      dry_run: true,
      session_id: 'root-session',
      records: [executionRecord()],
    }
    const preview = fixture.store.importExecutions(input)
    assert.deepEqual(preview, {
      source: 'codex',
      session_id: 'root-session',
      dry_run: true,
      root_turns: 1,
      subagent_executions: 0,
      would_create: 1,
      would_update: 0,
      created: 0,
      updated: 0,
      skipped: 0,
      unassigned: 1,
      changed: false,
    })
    assert.deepEqual(fixture.store.listExecutions(), [])
  } finally {
    await fixture.cleanup()
  }
})

test('execution import applies once, preserves exact Task bindings, and replays as all skipped', async () => {
  const fixture = await temporaryStore()
  try {
    fixture.store.upsert(taskInput({
      id: 'bound-task',
      title: 'Bound task',
      session_id: 'root-session',
      workfolder: '/workspace/project',
    }))
    const child = executionRecord({
      external_key: 'codex:import:subagent:root-session:child-session',
      kind: 'subagent',
      session_id: 'child-session',
      turn_id: 'turn-1',
      agent_id: 'child-session',
      agent_type: 'worker',
      agent_path: '/root/worker',
      parent_external_key: 'codex:turn:root-session:turn-1:0',
      transcript_path: '/sessions/child-session.jsonl',
      started_at: '2026-08-14T01:01:00.000Z',
    })
    const input = {
      source: 'codex', dry_run: false, session_id: 'root-session',
      records: [executionRecord(), child],
    }

    const applied = fixture.store.importExecutions(input)
    assert.equal(applied.created, 2)
    assert.equal(applied.updated, 0)
    assert.equal(applied.skipped, 0)
    assert.equal(applied.unassigned, 1)
    assert.equal(applied.changed, true)

    const rows = fixture.store.listExecutions({ root_session_id: 'root-session' })
    assert.equal(rows.length, 2)
    assert.equal(rows[0].task_id, 'bound-task')
    assert.equal(rows[0].classification, 'work')
    assert.equal(rows[1].task_id, null)
    assert.equal(rows[1].parent_execution_id, rows[0].id)

    const replayed = fixture.store.importExecutions(input)
    assert.equal(replayed.created, 0)
    assert.equal(replayed.updated, 0)
    assert.equal(replayed.skipped, 2)
    assert.equal(replayed.changed, false)
    assert.equal(fixture.store.listExecutions().length, 2)
  } finally {
    await fixture.cleanup()
  }
})

test('execution import rolls back the whole batch on an immutable identity conflict', async () => {
  const fixture = await temporaryStore()
  try {
    fixture.store.turnStart({
      external_key: 'codex:turn:root-a:turn-existing:0',
      root_session_id: 'root-a',
      session_id: 'root-a',
      turn_id: 'turn-existing',
      agent_type: 'Codex',
      workfolder: '/workspace/a',
    })

    assert.throws(() => fixture.store.importExecutions({
      source: 'codex', dry_run: false, session_id: 'root-b',
      records: [
        executionRecord({
          external_key: 'codex:turn:root-b:new-turn:0',
          root_session_id: 'root-b', session_id: 'root-b', turn_id: 'new-turn',
        }),
        executionRecord({
          external_key: 'codex:turn:root-a:turn-existing:0',
          root_session_id: 'root-b', session_id: 'root-b', turn_id: 'turn-existing',
        }),
      ],
    }), (error) => error.code === 'EXECUTION_IMPORT_CONFLICT')

    const rows = fixture.store.listExecutions()
    assert.equal(rows.length, 1)
    assert.equal(rows[0].root_session_id, 'root-a')
  } finally {
    await fixture.cleanup()
  }
})

test('execution import rejects a subagent parent from another root without partial writes', async () => {
  const fixture = await temporaryStore()
  try {
    fixture.store.turnStart({
      external_key: 'codex:turn:root-a:turn-1:0',
      root_session_id: 'root-a',
      session_id: 'root-a',
      turn_id: 'turn-1',
      agent_type: 'Codex',
      workfolder: '/workspace/a',
    })

    assert.throws(() => fixture.store.importExecutions({
      source: 'codex', dry_run: false, session_id: 'root-b',
      records: [
        executionRecord({
          external_key: 'codex:turn:root-b:turn-1:0',
          root_session_id: 'root-b', session_id: 'root-b', turn_id: 'turn-1',
        }),
        executionRecord({
          external_key: 'codex:import:subagent:root-b:child-1',
          kind: 'subagent',
          root_session_id: 'root-b',
          session_id: 'child-1',
          turn_id: null,
          parent_external_key: 'codex:turn:root-a:turn-1:0',
        }),
      ],
    }), (error) => error.code === 'EXECUTION_IMPORT_INVALID'
      && error.details.parent_external_key === 'codex:turn:root-a:turn-1:0')

    const rows = fixture.store.listExecutions()
    assert.equal(rows.length, 1)
    assert.equal(rows[0].root_session_id, 'root-a')
  } finally {
    await fixture.cleanup()
  }
})

test('execution import rejects nested subagent parents without partial writes', async () => {
  const fixture = await temporaryStore()
  try {
    const root = executionRecord()
    const parent = executionRecord({
      external_key: 'codex:import:subagent:root-session:child-1',
      kind: 'subagent',
      session_id: 'child-1',
      turn_id: null,
      parent_external_key: root.external_key,
    })
    const nested = executionRecord({
      external_key: 'codex:import:subagent:root-session:child-2',
      kind: 'subagent',
      session_id: 'child-2',
      turn_id: null,
      parent_external_key: parent.external_key,
    })

    assert.throws(() => fixture.store.importExecutions({
      source: 'codex', dry_run: false, session_id: 'root-session',
      records: [root, parent, nested],
    }), (error) => error.code === 'EXECUTION_IMPORT_INVALID'
      && error.details.parent_external_key === parent.external_key)

    assert.deepEqual(fixture.store.listExecutions(), [])
  } finally {
    await fixture.cleanup()
  }
})

test('execution import rejects a parent on a main execution', async () => {
  const fixture = await temporaryStore()
  try {
    const first = executionRecord()
    const second = executionRecord({
      external_key: 'codex:turn:root-session:turn-2:0',
      turn_id: 'turn-2',
      parent_external_key: first.external_key,
    })

    assert.throws(() => fixture.store.importExecutions({
      source: 'codex', dry_run: false, session_id: 'root-session',
      records: [first, second],
    }), (error) => error.code === 'EXECUTION_IMPORT_INVALID'
      && error.details.parent_external_key === first.external_key)

    assert.deepEqual(fixture.store.listExecutions(), [])
  } finally {
    await fixture.cleanup()
  }
})

test('execution import leaves ambiguous historical Task sessions unassigned and unchanged', async () => {
  const fixture = await temporaryStore()
  try {
    for (const id of ['root-one', 'root-two', 'root-three']) {
      fixture.store.upsert(taskInput({
        id,
        title: id,
        session_id: 'root-session',
        workfolder: '/workspace/project',
      }))
    }
    const before = fixture.store.snapshot().tasks
    const preview = fixture.store.importExecutions({
      source: 'codex', dry_run: true, session_id: 'root-session',
      records: [executionRecord()],
    })
    assert.equal(preview.unassigned, 1)
    assert.deepEqual(fixture.store.snapshot().tasks, before)
    assert.deepEqual(fixture.store.listExecutions(), [])
  } finally {
    await fixture.cleanup()
  }
})

test('execution import rejects missing required lifecycle timestamps before previewing', async () => {
  const fixture = await temporaryStore()
  try {
    assert.throws(() => fixture.store.importExecutions({
      source: 'codex', dry_run: true, session_id: 'root-session',
      records: [executionRecord({ started_at: undefined })],
    }), (error) => error.code === 'EXECUTION_INPUT_INVALID'
      && error.details.field === 'records[0].started_at')
  } finally {
    await fixture.cleanup()
  }
})
