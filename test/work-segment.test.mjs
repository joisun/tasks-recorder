import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import { createSchemaV3 } from '../mcp/src/schema-v3.mjs'
import { createWorkStore } from '../mcp/src/work-store.mjs'

function fixture() {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  createSchemaV3(db)
  db.exec(`
    INSERT INTO projects (id, name, created_at, updated_at)
    VALUES
      ('project-a', 'Project A', '2026-08-19T00:00:00.000Z', '2026-08-19T00:00:00.000Z'),
      ('project-b', 'Project B', '2026-08-19T00:00:00.000Z', '2026-08-19T00:00:00.000Z');
    INSERT INTO tasks (
      id, project_id, title, lifecycle, created_at, updated_at
    ) VALUES
      ('task-a', 'project-a', 'Task A', 'in_progress',
       '2026-08-19T00:00:00.000Z', '2026-08-19T00:00:00.000Z'),
      ('task-b', 'project-a', 'Task B', 'in_progress',
       '2026-08-19T00:00:00.000Z', '2026-08-19T00:00:00.000Z');
  `)
  const store = createWorkStore({
    db,
    clock: () => new Date('2026-08-19T00:00:00.000Z'),
  })
  return { db, store }
}

test('explicit Project Inbox assignment is conflict guarded and never guesses from branch', () => {
  const { db, store } = fixture()
  try {
    store.startExecution(startInput({ id: 'unresolved', project_id: null, branch: 'main' }))
    const sourceSession = db.prepare(`
      SELECT * FROM source_sessions WHERE external_session_id = 'session-1'
    `).get()
    assert.equal(sourceSession.project_id, null)

    const assigned = store.assignSourceSessionProject({
      source_session_id: sourceSession.id,
      expected_project_id: null,
      project_id: 'project-b',
    })
    assert.equal(assigned.changed, true)
    assert.equal(assigned.source_session.project_id, 'project-b')

    const replayed = store.assignSourceSessionProject({
      source_session_id: sourceSession.id,
      expected_project_id: 'project-b',
      project_id: 'project-b',
    })
    assert.equal(replayed.changed, false)

    assert.throws(() => store.assignSourceSessionProject({
      source_session_id: sourceSession.id,
      expected_project_id: null,
      project_id: 'project-a',
    }), (error) => error.code === 'SOURCE_SESSION_PROJECT_CONFLICT')
  } finally {
    db.close()
  }
})

function startInput(overrides = {}) {
  return {
    id: 'execution-1',
    source: 'codex',
    source_session_key: 'session-1',
    root_session_key: 'session-1',
    project_id: 'project-a',
    source_turn_key: 'turn-1',
    source_agent_key: 'main-agent',
    kind: 'main',
    workfolder: '/repo/a',
    git_common_dir: '/repo/a/.git',
    worktree: '/repo/a/.worktree/feature-a',
    branch: 'feature/a',
    started_at: '2026-08-19T01:00:00.000Z',
    ...overrides,
  }
}

test('observation and execution start replay without duplicating facts or open segments', () => {
  const { db, store } = fixture()
  try {
    const event = {
      source: 'codex',
      event_type: 'execution.started',
      external_event_id: 'codex:session-1:turn-1:start',
      observed_at: '2026-08-19T01:00:00.000Z',
      source_session_key: 'session-1',
      root_session_key: 'session-1',
      project_id: 'project-a',
      source_turn_key: 'turn-1',
      source_agent_key: 'main-agent',
      workfolder: '/repo/a',
      payload: { kind: 'main' },
    }
    const firstEvent = store.appendObservation(event)
    const replayedEvent = store.appendObservation(event)
    assert.equal(firstEvent.changed, true)
    assert.equal(replayedEvent.changed, false)
    assert.equal(replayedEvent.deduped, true)
    assert.equal(replayedEvent.observation.id, firstEvent.observation.id)

    const firstStart = store.startExecution(startInput())
    const replayedStart = store.startExecution(startInput())
    assert.equal(firstStart.changed, true)
    assert.equal(replayedStart.changed, false)
    assert.equal(replayedStart.execution.id, firstStart.execution.id)
    assert.equal(replayedStart.segment.id, firstStart.segment.id)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM observations').get().count, 1)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM source_sessions').get().count, 1)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM executions').get().count, 1)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM work_segments').get().count, 1)
  } finally {
    db.close()
  }
})

test('one execution preserves A to B to A as three attributed work segments', () => {
  const { db, store } = fixture()
  try {
    store.startExecution(startInput())
    store.focus({
      execution_id: 'execution-1',
      task_id: 'task-a',
      provenance: 'agent_explicit',
      rationale_code: 'selected_task',
      observed_at: '2026-08-19T01:00:00.000Z',
    })
    store.focus({
      execution_id: 'execution-1',
      task_id: 'task-b',
      provenance: 'agent_explicit',
      rationale_code: 'focus_changed',
      observed_at: '2026-08-19T02:00:00.000Z',
    })
    store.focus({
      execution_id: 'execution-1',
      task_id: 'task-a',
      provenance: 'agent_explicit',
      rationale_code: 'focus_changed',
      observed_at: '2026-08-19T03:00:00.000Z',
    })

    assert.deepEqual(store.listSegments({ execution_id: 'execution-1' }).map((segment) => ({
      task_id: segment.task_id,
      started_at: segment.started_at,
      ended_at: segment.ended_at,
    })), [
      {
        task_id: 'task-a',
        started_at: '2026-08-19T01:00:00.000Z',
        ended_at: '2026-08-19T02:00:00.000Z',
      },
      {
        task_id: 'task-b',
        started_at: '2026-08-19T02:00:00.000Z',
        ended_at: '2026-08-19T03:00:00.000Z',
      },
      {
        task_id: 'task-a',
        started_at: '2026-08-19T03:00:00.000Z',
        ended_at: null,
      },
    ])
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM executions').get().count, 1)
  } finally {
    db.close()
  }
})

test('ending execution closes facts without changing task lifecycle and stale remains derived', () => {
  const { db, store } = fixture()
  try {
    store.startExecution(startInput())
    store.focus({
      execution_id: 'execution-1',
      task_id: 'task-a',
      provenance: 'agent_explicit',
      rationale_code: 'selected_task',
      observed_at: '2026-08-19T01:00:00.000Z',
    })
    assert.equal(store.executionLiveState('execution-1', {
      now: '2026-08-19T03:00:00.000Z',
      stale_after_ms: 30 * 60_000,
    }), 'stale')
    assert.equal(db.prepare('SELECT ended_at FROM executions WHERE id = ?').get('execution-1').ended_at, null)

    const ended = store.endExecution({
      execution_id: 'execution-1',
      observed_at: '2026-08-19T04:00:00.000Z',
      end_reason: 'session_end',
    })
    assert.equal(ended.execution.ended_at, '2026-08-19T04:00:00.000Z')
    assert.equal(store.executionLiveState('execution-1'), 'ended')
    assert.equal(
      db.prepare('SELECT lifecycle FROM tasks WHERE id = ?').get('task-a').lifecycle,
      'in_progress',
    )
    assert.equal(
      db.prepare('SELECT close_reason FROM work_segments WHERE execution_id = ?').get('execution-1').close_reason,
      'execution_ended',
    )
  } finally {
    db.close()
  }
})
