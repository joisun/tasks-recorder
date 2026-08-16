import assert from 'node:assert/strict'
import test from 'node:test'

import { taskInput, temporaryStore } from './helpers.mjs'

test('turn start creates one unassigned main execution and replays idempotently', async () => {
  const fixture = await temporaryStore({
    clock: () => new Date('2026-08-14T01:00:00.000Z'),
  })
  try {
    assert.equal(typeof fixture.store.turnStart, 'function')
    const input = {
      external_key: 'codex:turn:root-session:turn-1:0',
      root_session_id: 'root-session',
      session_id: 'root-session',
      turn_id: 'turn-1',
      agent_type: 'Codex',
      transcript_path: '/sessions/root-session.jsonl',
      workfolder: '/workspace',
      git_root: '/workspace',
      worktree: '/workspace/.worktree/feature-a',
      branch: 'feature/a',
    }

    const created = fixture.store.turnStart(input)
    assert.equal(created.changed, true)
    assert.equal(created.execution.external_key, input.external_key)
    assert.equal(created.execution.kind, 'main')
    assert.equal(created.execution.task_id, null)
    assert.equal(created.execution.classification, 'unknown')
    assert.equal(created.execution.status, 'active')
    assert.equal(created.execution.started_at, '2026-08-14T01:00:00.000Z')
    assert.equal(created.execution.ended_at, null)

    const replayed = fixture.store.turnStart(input)
    assert.equal(replayed.changed, false)
    assert.equal(replayed.execution.id, created.execution.id)
    assert.deepEqual(
      fixture.store.listExecutions({ root_session_id: 'root-session' }).map(({ id }) => id),
      [created.execution.id],
    )
  } finally {
    await fixture.cleanup()
  }
})

test('store snapshot exposes execution aggregates without copying execution rows', async () => {
  let current = new Date('2026-08-14T01:00:00.000Z')
  const fixture = await temporaryStore({ clock: () => current })
  try {
    fixture.store.upsert(taskInput({ id: 'root', title: 'Root' }))
    fixture.store.turnStart({
      external_key: 'codex:turn:root-session:turn-1:0',
      root_session_id: 'root-session',
      session_id: 'root-session',
      turn_id: 'turn-1',
      agent_type: 'Codex',
      workfolder: '/workspace',
      worktree: '/workspace/.worktree/feature-tree',
      branch: 'feature/tree',
    })
    fixture.store.focusExecution({
      root_session_id: 'root-session',
      session_id: 'root-session',
      turn_id: 'turn-1',
      task_id: 'root',
    })
    current = new Date('2026-08-14T02:00:00.000Z')
    fixture.store.subagentStart({
      external_key: 'codex:subagent:worker-1',
      root_session_id: 'root-session',
      session_id: 'worker-1',
      parent_session_id: 'root-session',
      turn_id: 'turn-1',
      task_id: 'root',
      agent_id: 'worker-1',
      agent_type: 'worker',
      workfolder: '/workspace',
      worktree: '/workspace/.worktree/feature-tree',
      branch: 'feature/tree',
    })
    fixture.store.turnStart({
      external_key: 'codex:turn:unassigned:turn-2:0',
      root_session_id: 'unassigned',
      session_id: 'unassigned',
      turn_id: 'turn-2',
      agent_type: 'Codex',
      workfolder: '/other',
    })

    const snapshot = fixture.store.snapshot()
    assert.equal('executions' in snapshot, false)
    assert.equal(snapshot.unassigned_execution_count, 1)
    assert.deepEqual(snapshot.task_execution_aggregates, [{
      task_id: 'root',
      execution_count: 2,
      active_execution_count: 2,
      active_agent_count: 2,
      recent_execution: {
        session_id: 'worker-1',
        agent_type: 'worker',
        workfolder: '/workspace',
        git_root: null,
        worktree: '/workspace/.worktree/feature-tree',
        branch: 'feature/tree',
        last_seen_at: '2026-08-14T02:00:00.000Z',
      },
    }])
  } finally {
    await fixture.cleanup()
  }
})

test('focus changes preserve A to B to A as three main execution intervals', async () => {
  let current = new Date('2026-08-14T01:00:00.000Z')
  const fixture = await temporaryStore({ clock: () => current })
  try {
    fixture.store.upsert(taskInput({ id: 'root', title: 'Root' }))
    fixture.store.upsert(taskInput({
      id: 'task-a', parent_id: 'root', title: 'Task A', status: 'active',
    }))
    fixture.store.upsert(taskInput({
      id: 'task-b', parent_id: 'root', title: 'Task B', status: 'planned',
    }))
    fixture.store.turnStart({
      external_key: 'codex:turn:root-session:turn-1:0',
      root_session_id: 'root-session',
      session_id: 'root-session',
      turn_id: 'turn-1',
      agent_type: 'Codex',
      workfolder: '/workspace',
    })
    assert.equal(typeof fixture.store.focusExecution, 'function')

    fixture.store.focusExecution({
      root_session_id: 'root-session', session_id: 'root-session', turn_id: 'turn-1',
      task_id: 'task-a', actor: 'agent',
    })
    current = new Date('2026-08-14T02:00:00.000Z')
    fixture.store.focusExecution({
      root_session_id: 'root-session', session_id: 'root-session', turn_id: 'turn-1',
      task_id: 'task-b', actor: 'agent',
    })
    current = new Date('2026-08-14T03:00:00.000Z')
    fixture.store.focusExecution({
      root_session_id: 'root-session', session_id: 'root-session', turn_id: 'turn-1',
      task_id: 'task-a', actor: 'agent',
    })

    const executions = fixture.store.listExecutions({
      root_session_id: 'root-session', session_id: 'root-session',
    })
    assert.deepEqual(executions.map(({ task_id }) => task_id), ['task-a', 'task-b', 'task-a'])
    assert.deepEqual(executions.map(({ status }) => status), ['completed', 'completed', 'active'])
    assert.deepEqual(executions.map(({ started_at, ended_at }) => ({ started_at, ended_at })), [
      { started_at: '2026-08-14T01:00:00.000Z', ended_at: '2026-08-14T02:00:00.000Z' },
      { started_at: '2026-08-14T02:00:00.000Z', ended_at: '2026-08-14T03:00:00.000Z' },
      { started_at: '2026-08-14T03:00:00.000Z', ended_at: null },
    ])
    assert.equal(new Set(executions.map(({ external_key }) => external_key)).size, 3)
  } finally {
    await fixture.cleanup()
  }
})

test('subagent start and stop preserve parent context and replay idempotently', async () => {
  let current = new Date('2026-08-14T01:00:00.000Z')
  const fixture = await temporaryStore({ clock: () => current })
  try {
    const parent = fixture.store.turnStart({
      external_key: 'codex:turn:root-session:turn-1:0',
      root_session_id: 'root-session',
      session_id: 'root-session',
      turn_id: 'turn-1',
      agent_type: 'Codex',
      workfolder: '/workspace',
    }).execution
    assert.equal(typeof fixture.store.subagentStart, 'function')
    const startInput = {
      external_key: 'codex:subagent:child-session',
      root_session_id: 'root-session',
      session_id: 'child-session',
      parent_session_id: 'root-session',
      turn_id: 'turn-1',
      agent_id: 'child-session',
      agent_type: 'worker',
      agent_path: '/root/worker-a',
      transcript_path: '/sessions/child-session.jsonl',
      workfolder: '/workspace',
    }

    const started = fixture.store.subagentStart(startInput)
    assert.equal(started.changed, true)
    assert.equal(started.execution.kind, 'subagent')
    assert.equal(started.execution.parent_execution_id, parent.id)
    assert.equal(started.execution.task_id, null)
    assert.equal(started.execution.classification, 'unknown')
    assert.equal(fixture.store.subagentStart(startInput).changed, false)

    current = new Date('2026-08-14T02:00:00.000Z')
    const stopped = fixture.store.subagentStop({
      external_key: startInput.external_key,
      session_id: 'child-thread-id',
      agent_type: 'explorer',
      agent_path: '/root/researcher',
      transcript_path: '/sessions/child-thread-id.jsonl',
      workfolder: '/workspace',
      worktree: '/workspace/.worktree/research',
      branch: 'research',
      interrupted: true,
    })
    assert.equal(stopped.changed, true)
    assert.equal(stopped.execution.status, 'interrupted')
    assert.equal(stopped.execution.ended_at, '2026-08-14T02:00:00.000Z')
    assert.equal(stopped.execution.session_id, 'child-thread-id')
    assert.equal(stopped.execution.agent_type, 'explorer')
    assert.equal(stopped.execution.agent_path, '/root/researcher')
    assert.equal(stopped.execution.transcript_path, '/sessions/child-thread-id.jsonl')
    assert.equal(stopped.execution.worktree, '/workspace/.worktree/research')
    assert.equal(stopped.execution.branch, 'research')
    assert.equal(fixture.store.subagentStop({
      external_key: startInput.external_key,
      interrupted: true,
    }).changed, false)
  } finally {
    await fixture.cleanup()
  }
})

test('subagent agent path binds only a unique agent key in the active root tree', async () => {
  const fixture = await temporaryStore({
    clock: () => new Date('2026-08-14T01:00:00.000Z'),
  })
  try {
    fixture.store.upsert(taskInput({ id: 'root', title: 'Root' }))
    fixture.store.upsert(taskInput({
      id: 'child-a', parent_id: 'root', title: 'Child A', agent_key: 'researcher',
    }))
    fixture.store.upsert(taskInput({ id: 'other-root', title: 'Other root' }))
    fixture.store.upsert(taskInput({
      id: 'other-child', parent_id: 'other-root', title: 'Other child', agent_key: 'researcher',
    }))
    fixture.store.turnStart({
      external_key: 'codex:turn:root-session:turn-1:0',
      root_session_id: 'root-session', session_id: 'root-session', turn_id: 'turn-1',
      agent_type: 'Codex', workfolder: '/workspace',
    })
    fixture.store.focusExecution({
      root_session_id: 'root-session', session_id: 'root-session', turn_id: 'turn-1',
      task_id: 'root',
    })

    const bound = fixture.store.subagentStart({
      external_key: 'codex:subagent:root-session:researcher-1',
      root_session_id: 'root-session', session_id: 'researcher-1',
      parent_session_id: 'root-session', turn_id: 'turn-1',
      agent_id: 'researcher-1', agent_type: 'explorer', agent_path: '/root/researcher',
      workfolder: '/workspace',
    })
    assert.equal(bound.execution.task_id, 'child-a')
    assert.equal(bound.execution.classification, 'work')

    fixture.store.subagentStart({
      external_key: 'codex:subagent:root-session:researcher-late',
      root_session_id: 'root-session', session_id: 'researcher-late',
      parent_session_id: 'root-session', turn_id: 'turn-1',
      agent_id: 'researcher-late', agent_type: 'explorer', workfolder: '/workspace',
    })
    const boundOnStop = fixture.store.subagentStop({
      external_key: 'codex:subagent:root-session:researcher-late',
      agent_path: '/root/researcher',
    })
    assert.equal(boundOnStop.execution.task_id, 'child-a')
    assert.equal(boundOnStop.execution.classification, 'work')

    fixture.store.upsert(taskInput({
      id: 'child-b', parent_id: 'root', title: 'Child B', agent_key: 'duplicate',
    }))
    fixture.store.upsert(taskInput({
      id: 'child-c', parent_id: 'root', title: 'Child C', agent_key: 'duplicate',
    }))
    const ambiguous = fixture.store.subagentStart({
      external_key: 'codex:subagent:root-session:duplicate-1',
      root_session_id: 'root-session', session_id: 'duplicate-1',
      parent_session_id: 'root-session', turn_id: 'turn-1',
      agent_id: 'duplicate-1', agent_type: 'worker', agent_path: '/root/duplicate',
      workfolder: '/workspace',
    })
    assert.equal(ambiguous.execution.task_id, null)
    assert.equal(ambiguous.execution.classification, 'unknown')
  } finally {
    await fixture.cleanup()
  }
})

test('tool use advances active execution and records privacy-bounded plan observations', async () => {
  let current = new Date('2026-08-14T01:00:00.000Z')
  const fixture = await temporaryStore({ clock: () => current })
  try {
    fixture.store.turnStart({
      external_key: 'codex:turn:root-session:turn-1:0',
      root_session_id: 'root-session',
      session_id: 'root-session',
      turn_id: 'turn-1',
      agent_type: 'Codex',
      workfolder: '/workspace',
    })
    assert.equal(typeof fixture.store.toolUse, 'function')

    current = new Date('2026-08-14T02:00:00.000Z')
    const observed = fixture.store.toolUse({
      external_key: 'codex:tool:use-1',
      root_session_id: 'root-session',
      session_id: 'root-session',
      turn_id: 'turn-1',
      tool_name: 'update_plan',
      plan: {
        explanation: 'Refined scope',
        plan: [
          { step: 'Implement storage', status: 'in_progress' },
          { step: 'Verify UI', status: 'pending' },
        ],
      },
      tool_response: 'must-not-be-stored',
    })
    assert.equal(observed.changed, true)
    assert.equal(observed.execution.last_seen_at, '2026-08-14T02:00:00.000Z')
    assert.equal(observed.observation.external_key, 'codex:tool:use-1')
    assert.equal(observed.observation.reconciled_at, null)
    assert.deepEqual(JSON.parse(observed.observation.plan_json), {
      explanation: 'Refined scope',
      plan: [
        { step: 'Implement storage', status: 'in_progress' },
        { step: 'Verify UI', status: 'pending' },
      ],
    })
    assert.equal(observed.observation.plan_json.includes('must-not-be-stored'), false)

    const replayed = fixture.store.toolUse({
      external_key: 'codex:tool:use-1',
      root_session_id: 'root-session',
      session_id: 'root-session',
      turn_id: 'turn-1',
      tool_name: 'update_plan',
      plan: observed.observation.plan_json,
    })
    assert.equal(replayed.changed, false)
    assert.equal(fixture.store.listPlanObservations({
      session_id: 'root-session', turn_id: 'turn-1', pending: true,
    }).length, 1)

    const stale = fixture.store.toolUse({
      external_key: 'codex:tool:use-stale',
      root_session_id: 'root-session',
      session_id: 'root-session',
      turn_id: 'turn-1',
      tool_name: 'shell',
      occurred_at: '2026-08-14T01:30:00.000Z',
    })
    assert.equal(stale.changed, false)
    assert.equal(stale.execution.last_seen_at, '2026-08-14T02:00:00.000Z')
  } finally {
    await fixture.cleanup()
  }
})

test('execution assignment detects conflicts and non-work classification leaves the inbox', async () => {
  const fixture = await temporaryStore({
    clock: () => new Date('2026-08-14T01:00:00.000Z'),
  })
  try {
    fixture.store.upsert(taskInput({ id: 'root', title: 'Root' }))
    const started = fixture.store.turnStart({
      external_key: 'codex:turn:root-session:turn-1:0',
      root_session_id: 'root-session',
      session_id: 'root-session',
      turn_id: 'turn-1',
      agent_type: 'Codex',
      workfolder: '/workspace',
    }).execution
    assert.equal(typeof fixture.store.assignExecution, 'function')

    const assigned = fixture.store.assignExecution({
      id: started.id,
      task_id: 'root',
      expected_task_id: null,
      actor: 'user',
    })
    assert.equal(assigned.changed, true)
    assert.equal(assigned.execution.task_id, 'root')
    assert.equal(assigned.execution.classification, 'work')
    assert.throws(
      () => fixture.store.assignExecution({
        id: started.id,
        task_id: null,
        expected_task_id: null,
        actor: 'user',
      }),
      (error) => error.code === 'EXECUTION_ASSIGNMENT_CONFLICT'
        && error.details.actual_task_id === 'root',
    )

    const classified = fixture.store.classifyExecution({
      id: started.id,
      classification: 'non_work',
      expected_classification: 'work',
      expected_task_id: 'root',
      actor: 'user',
    })
    assert.equal(classified.execution.task_id, null)
    assert.equal(classified.execution.classification, 'non_work')
    assert.equal(fixture.store.listExecutions({ unassigned: true }).length, 0)
    assert.deepEqual(
      fixture.store.show('root').events.map(({ event_type }) => event_type),
      ['created', 'execution_bound', 'execution_unbound'],
    )
  } finally {
    await fixture.cleanup()
  }
})

test('session end closes every active execution in the root session and replays safely', async () => {
  let current = new Date('2026-08-14T01:00:00.000Z')
  const fixture = await temporaryStore({ clock: () => current })
  try {
    fixture.store.turnStart({
      external_key: 'codex:turn:root-session:turn-1:0',
      root_session_id: 'root-session',
      session_id: 'root-session',
      turn_id: 'turn-1',
      workfolder: '/workspace',
    })
    fixture.store.subagentStart({
      external_key: 'codex:subagent:child-session',
      root_session_id: 'root-session',
      session_id: 'child-session',
      parent_session_id: 'root-session',
      turn_id: 'turn-1',
      agent_id: 'child-session',
      workfolder: '/workspace',
    })
    fixture.store.turnStart({
      external_key: 'codex:turn:other-session:turn-1:0',
      root_session_id: 'other-session',
      session_id: 'other-session',
      turn_id: 'turn-1',
      workfolder: '/other',
    })
    assert.equal(typeof fixture.store.sessionEnd, 'function')

    current = new Date('2026-08-14T02:00:00.000Z')
    const ended = fixture.store.sessionEnd({
      root_session_id: 'root-session', interrupted: true,
    })
    assert.equal(ended.changed, true)
    assert.deepEqual(ended.executions.map(({ status }) => status), ['interrupted', 'interrupted'])
    assert.ok(ended.executions.every(({ ended_at }) => ended_at === '2026-08-14T02:00:00.000Z'))
    assert.equal(fixture.store.sessionEnd({
      root_session_id: 'root-session', interrupted: true,
    }).changed, false)
    assert.equal(
      fixture.store.listExecutions({ root_session_id: 'other-session' })[0].status,
      'active',
    )
  } finally {
    await fixture.cleanup()
  }
})

test('session context summarizes active, unassigned, and pending plan state without creating rows', async () => {
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
      external_key: 'codex:tool:use-1',
      root_session_id: 'root-session',
      session_id: 'root-session',
      turn_id: 'turn-1',
      tool_name: 'update_plan',
      plan: { plan: [{ step: 'Implement', status: 'in_progress' }] },
    })
    assert.equal(typeof fixture.store.sessionContext, 'function')

    const before = fixture.store.sessionContext('root-session')
    assert.deepEqual(before, {
      root_session_id: 'root-session',
      execution_count: 1,
      active_execution_count: 1,
      unassigned_execution_count: 1,
      pending_plan_observation_count: 1,
      active_executions: before.active_executions,
      unassigned_executions: before.unassigned_executions,
      pending_plan_observations: before.pending_plan_observations,
    })
    assert.equal(before.active_executions[0].turn_id, 'turn-1')
    assert.equal(before.unassigned_executions[0].classification, 'unknown')
    assert.equal(before.pending_plan_observations[0].external_key, 'codex:tool:use-1')

    const registered = fixture.store.sessionStart({ root_session_id: 'root-session' })
    assert.equal(registered.changed, false)
    assert.equal(registered.context.execution_count, 1)
    assert.equal(fixture.store.listExecutions({ root_session_id: 'root-session' }).length, 1)
  } finally {
    await fixture.cleanup()
  }
})
