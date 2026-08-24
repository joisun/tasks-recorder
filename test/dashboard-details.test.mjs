import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { createDashboardApi, DashboardApiError } from '../ui/src/dashboard-api.mjs'
import {
  DETAIL_TABS,
  conflictViewState,
  detailsSheetMarkup,
  eventPresentation,
  executionPresentation,
  focusTrapTarget,
  restoreFocusTarget,
  taskActionVisibility,
  taskDraft,
  taskPatch,
} from '../ui/src/task-details-sheet.mjs'
import { findFocusTarget, focusDescriptor } from '../ui/src/focus-state.mjs'

function jsonResponse(body, { status = 200 } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

test('dashboard API maps details reads and optimistic task mutations', async () => {
  const calls = []
  const api = createDashboardApi({
    fetchImpl: async (url, options = {}) => {
      calls.push({
        url,
        method: options.method ?? 'GET',
        body: options.body ? JSON.parse(options.body) : null,
      })
      if (url.endsWith('/events')) return jsonResponse({ events: [{ id: 'event-1' }] })
      if (url.includes('/executions?')) return jsonResponse({ executions: [{ id: 'execution-1' }] })
      return jsonResponse({ task: { id: 'task-a' }, ok: true })
    },
  })

  assert.deepEqual(await api.task('task-a'), { task: { id: 'task-a' }, ok: true })
  assert.deepEqual(await api.events('task-a'), [{ id: 'event-1' }])
  assert.deepEqual(await api.executions({ task_id: 'task-a', status: 'active' }), [{ id: 'execution-1' }])
  await api.updateTask('task-a', 4, { title: 'Renamed' })
  await api.archiveTask('task-a', 5)
  await api.deleteTask('task-a', 6)
  await api.restoreTask('task-a', 7)
  await api.createChild('child-a', {
    title: 'Child', parent_id: 'task-a', project: 'Recorder',
    session_id: 'session-a', workfolder: '/workspace',
  })
  await api.settings()
  await api.updateSettings({ resume_terminal: 'otty' })
  await api.resumeTask('task-a')

  assert.deepEqual(calls, [
    { url: '/api/v1/tasks/task-a', method: 'GET', body: null },
    { url: '/api/v1/tasks/task-a/events', method: 'GET', body: null },
    { url: '/api/v1/executions?task_id=task-a&status=active', method: 'GET', body: null },
    {
      url: '/api/v1/tasks/task-a', method: 'PATCH',
      body: { expected_revision: 4, patch: { title: 'Renamed' }, actor: 'user' },
    },
    {
      url: '/api/v1/tasks/task-a/archive', method: 'POST',
      body: { expected_revision: 5, actor: 'user' },
    },
    {
      url: '/api/v1/tasks/task-a/delete', method: 'POST',
      body: { expected_revision: 6, actor: 'user' },
    },
    {
      url: '/api/v1/tasks/task-a/restore', method: 'POST',
      body: { expected_revision: 7, actor: 'user' },
    },
    {
      url: '/api/v1/tasks/child-a', method: 'PUT',
      body: {
        title: 'Child', parent_id: 'task-a', project: 'Recorder', status: 'planned',
        session_id: 'session-a', workfolder: '/workspace', actor: 'user',
      },
    },
    { url: '/api/v1/settings', method: 'GET', body: null },
    { url: '/api/v1/settings', method: 'PATCH', body: { resume_terminal: 'otty' } },
    { url: '/api/v1/tasks/task-a/resume', method: 'POST', body: {} },
  ])
})

test('dashboard API preserves server conflict code, details, and latest task', async () => {
  const api = createDashboardApi({
    fetchImpl: async () => jsonResponse({
      ok: false,
      error: {
        code: 'TASK_VERSION_CONFLICT',
        message: 'task changed',
        details: { actual_revision: 8, task: { id: 'task-a', revision: 8, title: 'Server title' } },
      },
    }, { status: 409 }),
  })

  await assert.rejects(
    api.updateTask('task-a', 7, { title: 'Local title' }),
    (error) => {
      assert.ok(error instanceof DashboardApiError)
      assert.equal(error.code, 'TASK_VERSION_CONFLICT')
      assert.equal(error.details.actual_revision, 8)
      assert.equal(error.details.task.title, 'Server title')
      return true
    },
  )
})

test('details model builds tabs, minimal patches, and lifecycle actions', () => {
  assert.deepEqual(DETAIL_TABS.map(({ id }) => id), ['summary', 'executions', 'activity'])
  const task = {
    id: 'task-a', parent_id: null, title: 'Original', description: null, status: 'active',
    next_action: 'Verify', due_date: null, sort_order: 2, revision: 7,
    archived_at: null, deleted_at: null,
  }
  const draft = taskDraft(task)
  assert.deepEqual(draft, {
    title: 'Original', description: '', status: 'active', next_action: 'Verify',
    due_date: '', parent_id: '', sort_order: '2',
  })
  assert.deepEqual(taskPatch(task, {
    ...draft,
    title: '  Renamed  ',
    description: 'Details',
    next_action: '',
    due_date: '2026-08-20',
    sort_order: '3',
  }), {
    title: 'Renamed', description: 'Details', next_action: null,
    due_date: '2026-08-20', sort_order: 3,
  })
  assert.throws(() => taskPatch(task, { ...draft, title: '  ' }), /title/)

  assert.deepEqual(taskActionVisibility(task), {
    addChild: true, cancel: true, archive: false, delete: true, restore: false,
  })
  assert.deepEqual(taskActionVisibility({ ...task, status: 'done' }), {
    addChild: false, cancel: false, archive: true, delete: true, restore: false,
  })
  assert.deepEqual(taskActionVisibility({
    ...task, status: 'done', archived_at: '2026-08-14T10:00:00.000Z',
  }), {
    addChild: false, cancel: false, archive: false, delete: true, restore: true,
  })
  assert.deepEqual(taskActionVisibility({
    ...task, deleted_at: '2026-08-14T10:00:00.000Z',
  }), {
    addChild: false, cancel: false, archive: false, delete: false, restore: true,
  })
})

test('conflict state keeps local draft while adopting the newest server revision', () => {
  const draft = { title: 'Local edit', description: 'Unsaved' }
  const latestTask = { id: 'task-a', title: 'Server edit', revision: 9 }
  assert.deepEqual(conflictViewState({ draft, latestTask }), {
    draft,
    task: latestTask,
    message: '任务已在其他位置更新；你的输入已保留，请检查后重新保存。',
  })
})

test('execution and activity presentations retain identity without rendering raw JSON', () => {
  const execution = executionPresentation({
    id: 'execution-1', kind: 'subagent', agent_type: 'explorer', agent_path: '/root/researcher',
    session_id: '019fa297-4567-7bf0-a69a-84fd23b3aaab', turn_id: 'turn-1',
    status: 'completed', started_at: '2026-08-14T01:00:00.000Z',
    ended_at: '2026-08-14T02:00:00.000Z', workfolder: '/workspace',
    worktree: '/workspace/.worktree/research', branch: 'research',
  })
  assert.equal(execution.sessionId, '019fa297-4567-7bf0-a69a-84fd23b3aaab')
  assert.equal(execution.agent, 'explorer · /root/researcher')
  assert.equal(execution.context, '/workspace/.worktree/research · research')

  const event = eventPresentation({
    id: 'event-1', event_type: 'renamed', actor: 'user',
    before_json: '{"title":"Before"}', after_json: '{"title":"After"}',
    created_at: '2026-08-14T02:00:00.000Z',
  })
  assert.equal(event.label, '重命名任务')
  assert.equal(event.detail, 'Before → After')
  assert.equal('before_json' in event, false)
  assert.equal('after_json' in event, false)
})

test('focus trap wraps only at the sheet boundaries', () => {
  assert.equal(focusTrapTarget({ current: 0, count: 4, shiftKey: true }), 3)
  assert.equal(focusTrapTarget({ current: 3, count: 4, shiftKey: false }), 0)
  assert.equal(focusTrapTarget({ current: 1, count: 4, shiftKey: false }), null)
  assert.equal(focusTrapTarget({ current: 0, count: 0, shiftKey: false }), null)
})

test('details sheet markup exposes editable summary and complete execution identity', () => {
  const html = detailsSheetMarkup({
    task: {
      id: 'task-a', title: 'Task <A>', description: null, status: 'active', next_action: null,
      due_date: null, parent_id: null, sort_order: 0, revision: 3,
      archived_at: null, deleted_at: null,
    },
    draft: {
      title: 'Task <A>', description: '', status: 'active', next_action: '', due_date: '',
      parent_id: '', sort_order: '0',
    },
    activeTab: 'summary',
    executions: [{
      id: 'execution-a', kind: 'main', agent_type: 'Codex', agent_path: null,
      session_id: '019fa297-4567-7bf0-a69a-84fd23b3aaab', turn_id: 'turn-a',
      status: 'active', workfolder: '/workspace', worktree: null, branch: 'main',
      started_at: '2026-08-14T01:00:00.000Z', ended_at: null,
    }],
    events: [{
      id: 'event-a', event_type: 'renamed', actor: 'user',
      before_json: '{"title":"Before"}', after_json: '{"title":"After"}',
      created_at: '2026-08-14T02:00:00.000Z',
    }],
    tasks: [{ id: 'task-b', title: 'Parent option' }],
  })

  assert.match(html, /role="tablist"/)
  assert.match(html, /<form[^>]+data-details-form/)
  assert.match(html, /<textarea name="next_action"[^>]*maxlength="1000"/)
  assert.match(html, /Task &lt;A&gt;/)
  assert.match(html, /019fa297-4567-7bf0-a69a-84fd23b3aaab/)
  assert.match(html, /data-details-action="add-child"/)
  assert.doesNotMatch(html, /before_json|after_json/)
})

test('details parent choices exclude Project rows, cross-Project tasks, and Subtasks', () => {
  const task = {
    id: 'task-a', project_id: 'project-a', entity_type: 'subtask', title: 'Task A',
    description: null, status: 'active', next_action: null, due_date: null,
    parent_id: 'main-a', sort_order: 0, revision: 1, archived_at: null, deleted_at: null,
  }
  const html = detailsSheetMarkup({
    task,
    tasks: [
      { id: 'project:project-a', project_id: 'project-a', entity_type: 'project', title: 'Project A' },
      { id: 'main-a', project_id: 'project-a', entity_type: 'main_task', title: 'Main A' },
      { id: 'child-a', project_id: 'project-a', entity_type: 'subtask', title: 'Child A' },
      { id: 'main-b', project_id: 'project-b', entity_type: 'main_task', title: 'Main B' },
    ],
  })
  assert.match(html, /value="main-a"/)
  assert.doesNotMatch(html, /value="project:project-a"|value="child-a"|value="main-b"/)
})

test('details sheet pins each child to a stable grid row when the message is hidden', async () => {
  const css = await readFile(new URL('../ui/src/dashboard.css', import.meta.url), 'utf8')

  assert.match(css, /\.details-header\{[^}]*grid-row:1/)
  assert.match(css, /\.details-tabs\{[^}]*grid-row:2/)
  assert.match(css, /\.details-message\{[^}]*grid-row:3/)
  assert.match(css, /\.details-body\{[^}]*grid-row:4/)
  assert.match(css, /\.details-actions\{[^}]*grid-row:5/)
})

test('focus restoration resolves a replacement task trigger after Gantt redraw', () => {
  const detached = { isConnected: false }
  const replacement = { id: 'replacement' }
  const fallback = { id: 'fallback' }

  assert.equal(restoreFocusTarget({
    returnFocus: detached,
    taskId: 'task-a',
    findTaskTrigger: (id) => id === 'task-a' ? replacement : null,
    fallback,
  }), replacement)
  assert.equal(restoreFocusTarget({
    returnFocus: null,
    taskId: 'missing',
    findTaskTrigger: () => null,
    fallback,
  }), fallback)
})

test('async renders recover the equivalent control from a stable focus descriptor', () => {
  const control = {
    hasAttribute: (attribute) => attribute === 'data-details-close',
    getAttribute: () => '',
  }
  const replacement = {
    hasAttribute: (attribute) => attribute === 'data-details-close',
    getAttribute: () => '',
  }
  const fallback = { id: 'fallback' }
  const root = {
    querySelectorAll: () => [replacement],
    querySelector: () => fallback,
  }

  const descriptor = focusDescriptor(control)
  assert.deepEqual(descriptor, { attribute: 'data-details-close', value: '' })
  assert.equal(findFocusTarget(root, descriptor, '[data-details-close]'), replacement)
  assert.equal(findFocusTarget(root, null, '[data-details-close]'), fallback)
})
