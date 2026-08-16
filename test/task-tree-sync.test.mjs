import assert from 'node:assert/strict'
import test from 'node:test'

import { temporaryStore } from './helpers.mjs'

function syncInput(overrides = {}) {
  return {
    session_id: 'root-session',
    turn_id: 'turn-1',
    workfolder: '/workspace',
    expected_revision: null,
    root: {
      id: 'root',
      project: 'Example',
      title: 'Root task',
      description: 'Deliver the feature',
      status: 'active',
      start_date: '2026-08-14',
    },
    children: [
      {
        id: 'child-a', title: 'Storage', description: 'Build storage',
        status: 'done', sort_order: 0, agent_key: 'storage-worker',
      },
      {
        id: 'child-b', title: 'UI', description: 'Build UI',
        status: 'planned', sort_order: 1, agent_key: 'ui-worker',
      },
    ],
    focus_task_id: 'child-a',
    ...overrides,
  }
}

test('sync tree atomically creates nodes, binds focus, reconciles plan, and replays as no-op', async () => {
  const fixture = await temporaryStore({
    clock: () => new Date('2026-08-14T01:00:00.000Z'),
  })
  try {
    fixture.store.turnStart({
      external_key: 'codex:turn:root-session:turn-1:0',
      root_session_id: 'root-session',
      session_id: 'root-session',
      turn_id: 'turn-1',
      workfolder: '/workspace',
    })
    fixture.store.toolUse({
      external_key: 'codex:tool:plan-1',
      root_session_id: 'root-session',
      session_id: 'root-session',
      turn_id: 'turn-1',
      tool_name: 'update_plan',
      plan: { plan: [{ step: 'Build storage', status: 'in_progress' }] },
    })
    assert.equal(typeof fixture.store.syncTree, 'function')

    const created = fixture.store.syncTree(syncInput())
    assert.equal(created.changed, true)
    assert.equal(created.root.id, 'root')
    assert.equal(created.root.revision, 3)
    assert.deepEqual(created.children.map(({ id }) => id), ['child-a', 'child-b'])
    assert.deepEqual(created.progress, {
      total: 2, remaining: 1, completed: 1, ratio: 0.5,
    })
    assert.equal(created.focused_task.id, 'child-a')
    assert.equal(created.bound_execution.task_id, 'child-a')
    assert.deepEqual(created.reconciled_plan_observations, ['codex:tool:plan-1'])

    const replayed = fixture.store.syncTree(syncInput({
      expected_revision: created.root.revision,
    }))
    assert.equal(replayed.changed, false)
    assert.equal(replayed.root.revision, created.root.revision)
    assert.deepEqual(replayed.reconciled_plan_observations, [])
    assert.equal(fixture.store.listExecutions({ root_session_id: 'root-session' }).length, 1)
  } finally {
    await fixture.cleanup()
  }
})

test('generated task ids survive a lost first response and preserve identity on later rename', async () => {
  const fixture = await temporaryStore({
    clock: () => new Date('2026-08-14T01:00:00.000Z'),
  })
  try {
    fixture.store.turnStart({
      external_key: 'codex:turn:root-session:turn-1:0',
      root_session_id: 'root-session',
      session_id: 'root-session',
      turn_id: 'turn-1',
      workfolder: '/workspace',
    })
    const input = syncInput({
      root: {
        project: 'Example', title: 'Generated root', status: 'active',
        start_date: '2026-08-14',
      },
      children: [
        { title: 'Generated child', status: 'planned', sort_order: 0 },
      ],
      focus_task_id: null,
    })

    const created = fixture.store.syncTree(input)
    assert.match(created.root.id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    assert.match(created.children[0].id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/)

    const lostResponseRetry = fixture.store.syncTree(input)
    assert.equal(lostResponseRetry.changed, false)
    assert.equal(lostResponseRetry.root.id, created.root.id)
    assert.equal(lostResponseRetry.children[0].id, created.children[0].id)

    const renamed = fixture.store.syncTree(syncInput({
      expected_revision: created.root.revision,
      root: { ...input.root, id: created.root.id },
      children: [{
        id: created.children[0].id,
        title: 'Renamed generated child',
        status: 'active',
        sort_order: 0,
      }],
      focus_task_id: created.children[0].id,
    }))
    assert.equal(renamed.children[0].id, created.children[0].id)
    assert.equal(renamed.children[0].title, 'Renamed generated child')
  } finally {
    await fixture.cleanup()
  }
})

test('tree revision conflict rolls back and omitted children remain unchanged', async () => {
  const fixture = await temporaryStore({
    clock: () => new Date('2026-08-14T01:00:00.000Z'),
  })
  try {
    fixture.store.turnStart({
      external_key: 'codex:turn:root-session:turn-1:0',
      root_session_id: 'root-session',
      session_id: 'root-session',
      turn_id: 'turn-1',
      workfolder: '/workspace',
    })
    const created = fixture.store.syncTree(syncInput())

    assert.throws(
      () => fixture.store.syncTree(syncInput({
        expected_revision: created.root.revision - 1,
        root: { ...syncInput().root, title: 'Stale overwrite' },
        children: [{
          ...syncInput().children[0], status: 'blocked',
        }],
      })),
      (error) => error.code === 'TASK_TREE_VERSION_CONFLICT'
        && error.details.actual_revision === created.root.revision,
    )
    assert.equal(fixture.store.show('root').task.title, 'Root task')
    assert.equal(fixture.store.show('child-a').task.status, 'done')

    const omitted = fixture.store.syncTree(syncInput({
      expected_revision: created.root.revision,
      children: [syncInput().children[0]],
    }))
    assert.equal(omitted.changed, false)
    assert.deepEqual(omitted.children.map(({ id }) => id), ['child-a', 'child-b'])
    assert.equal(omitted.children[1].status, 'planned')
  } finally {
    await fixture.cleanup()
  }
})
