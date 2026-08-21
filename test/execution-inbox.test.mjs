import assert from 'node:assert/strict'
import test from 'node:test'

import { createDashboardApi } from '../ui/src/dashboard-api.mjs'
import {
  batchAssignmentPayload,
  filterInboxExecutions,
  inboxButtonLabel,
  inboxExecutionPresentation,
  inboxMarkup,
  inboxMutationMessage,
  reconcileInboxSelection,
} from '../ui/src/execution-inbox.mjs'

const executions = [
  {
    id: 'execution-a', root_session_id: 'session-a', session_id: 'session-a',
    agent_type: 'Codex', agent_path: null, task_id: null, classification: 'unknown',
    status: 'active', started_at: '2026-08-14T02:00:00.000Z',
    workfolder: '/workspace/a', worktree: '/workspace/a/.worktree/feature', branch: 'feature',
  },
  {
    id: 'execution-b', root_session_id: 'session-b', session_id: 'child-b',
    agent_type: 'worker', agent_path: '/root/researcher', task_id: null,
    classification: 'unknown', status: 'completed',
    started_at: '2026-08-13T02:00:00.000Z', workfolder: '/workspace/b',
    worktree: '/workspace/b', branch: 'main',
  },
]

test('inbox filters root session, time, status, and agent path without losing identity', () => {
  assert.deepEqual(filterInboxExecutions(executions, { query: 'researcher' }).map(({ id }) => id), [
    'execution-b',
  ])
  assert.deepEqual(filterInboxExecutions(executions, { rootSessionId: 'session-a' }).map(({ id }) => id), [
    'execution-a',
  ])
  assert.deepEqual(filterInboxExecutions(executions, { status: 'active' }).map(({ id }) => id), [
    'execution-a',
  ])
  assert.deepEqual(filterInboxExecutions(executions, {
    startedAfter: '2026-08-14T00:00:00.000Z',
  }).map(({ id }) => id), ['execution-a'])

  const presentation = inboxExecutionPresentation(executions[0])
  assert.equal(presentation.sessionId, 'session-a')
  assert.equal(presentation.context, '/workspace/a/.worktree/feature · feature')
})

test('inbox selection keeps only executions still unassigned after SSE refresh', () => {
  assert.deepEqual(
    [...reconcileInboxSelection(new Set(['execution-a', 'gone']), executions)],
    ['execution-a'],
  )
  assert.equal(inboxButtonLabel(3), '任务 3')
  assert.equal(inboxButtonLabel(0), '任务')
})

test('batch payload includes both optimistic assignment dimensions', () => {
  assert.deepEqual(batchAssignmentPayload({
    executions,
    selectedIds: new Set(['execution-a', 'execution-b']),
    taskId: 'task-a',
  }), {
    actor: 'user',
    changes: [
      {
        id: 'execution-a', expected_task_id: null, expected_classification: 'unknown',
        task_id: 'task-a', classification: 'work',
      },
      {
        id: 'execution-b', expected_task_id: null, expected_classification: 'unknown',
        task_id: 'task-a', classification: 'work',
      },
    ],
  })
  assert.deepEqual(batchAssignmentPayload({
    executions,
    selectedIds: new Set(['execution-a']),
    classification: 'non_work',
  }).changes[0], {
    id: 'execution-a', expected_task_id: null, expected_classification: 'unknown',
    task_id: null, classification: 'non_work',
  })
  assert.throws(() => batchAssignmentPayload({ executions, selectedIds: new Set() }), /execution/)
})

test('dashboard API sends one atomic execution batch request', async () => {
  const calls = []
  const api = createDashboardApi({
    fetchImpl: async (url, options) => {
      calls.push({ url, method: options.method, body: JSON.parse(options.body) })
      return new Response(JSON.stringify({ ok: true, executions: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    },
  })
  const payload = batchAssignmentPayload({
    executions,
    selectedIds: new Set(['execution-a']),
    taskId: 'task-a',
  })

  await api.updateExecutionAssignments(payload)

  assert.deepEqual(calls, [{
    url: '/api/v1/executions/tasks', method: 'PATCH', body: payload,
  }])
})

test('inbox markup exposes filters, selection, assignment and non-work controls', () => {
  const html = inboxMarkup({
    executions,
    filtered: executions,
    selection: new Set(['execution-a']),
    tasks: [
      { id: 'root', parent_id: null, title: 'Root' },
      { id: 'child', parent_id: 'root', title: 'Child' },
    ],
    filters: { query: '', rootSessionId: '', status: '', startedAfter: '' },
  })

  assert.match(html, /role="dialog"/)
  assert.match(html, /data-inbox-filter="query"/)
  assert.match(html, /data-inbox-select="execution-a"[^>]*checked/)
  assert.match(html, /session-a/)
  assert.match(html, /value="child"/)
  assert.match(html, /data-inbox-action="assign"/)
  assert.match(html, /data-inbox-action="non-work"/)
})

test('inbox conflict message is actionable without hiding server detail', () => {
  assert.equal(inboxMutationMessage({
    code: 'EXECUTION_BATCH_CONFLICT',
    details: { conflicts: [{ id: 'execution-a' }, { id: 'execution-b' }] },
  }), '2 个 Execution 已在其他位置更新；列表已刷新，请重新选择。')
})
