import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, test, vi } from 'vitest'

import { createDashboardApi, DashboardApiError, type DashboardApi } from '@/lib/api/dashboard-api'
import type { DashboardSnapshot, TaskRecord } from '@/lib/api/types'
import { queryKeys } from '@/lib/query/keys'
import { TasksView, filterTaskSnapshot, taskStatusCounts } from './tasks-view'

const ganttProps = vi.hoisted(() => vi.fn())

vi.mock('./task-gantt', () => ({
  TaskGantt: (props: Record<string, unknown>) => {
    ganttProps(props)
    const snapshot = props.snapshot as DashboardSnapshot
    return (
      <div data-testid="task-gantt">
        {snapshot.tasks.map((task) => <span key={task.id}>{task.title}</span>)}
        <button type="button" onClick={() => (props.onTaskSelect as (id: string) => void)('main')}>Select main</button>
      </div>
    )
  },
}))

function task(overrides: Partial<TaskRecord> & Pick<TaskRecord, 'id' | 'title'>): TaskRecord {
  const { id, title, ...rest } = overrides
  return {
    id, title, parent_id: 'project:recorder', project_id: 'recorder', entity_type: 'main_task',
    description: null, lifecycle: 'in_progress', status: 'active', rollup_state: 'in_progress',
    sort_order: 0, revision: 1, archived_at: null, progress: null, agent: 'Codex',
    next_action: null, planned: null, actual: null, actual_segments: [], actual_segment_count: 0,
    start: null, end: null, last_activity: '2026-08-28T10:00:00.000Z',
    updated_at: '2026-08-28T10:00:00.000Z', session_id: 'session-a',
    session_source: 'codex', resume_available: true, workspace: '/project', workfolder: '/project',
    worktree: '/project', branch: 'main', execution_count: 1, active_execution_count: 1,
    running_execution_count: 1, idle_execution_count: 0, stale_execution_count: 0,
    active_agent_count: 1, live_state: 'running', blocked_count: 0, ...rest,
  }
}

const tasks = [
  task({ id: 'project:recorder', title: 'Recorder', parent_id: null, entity_type: 'project' }),
  task({ id: 'main', title: 'React migration' }),
  task({ id: 'child', title: 'Toolbar polish', parent_id: 'main', entity_type: 'subtask', status: 'done', lifecycle: 'done', rollup_state: 'done' }),
  task({ id: 'other', title: 'Server cleanup', status: 'blocked', lifecycle: 'blocked', rollup_state: 'blocked' }),
]

const snapshot: DashboardSnapshot = {
  server_instance_id: 'server-a', revision: 2, schema_version: 3,
  generated_at: '2026-08-28T12:00:00.000Z', home_directory: '/Users/me', tasks,
  projects: [], warnings: [], project_inbox: [], project_inbox_count: 0,
  attribution_inbox_count: 0, unassigned_execution_count: 0,
}

function apiMock(): DashboardApi {
  return {
    ...createDashboardApi({
      fetchImpl: vi.fn(async () => new Response('{}', {
        headers: { 'Content-Type': 'application/json' },
      })),
    }),
    meta: vi.fn(), snapshot: vi.fn(),
    task: vi.fn(async (id) => ({ task: tasks.find((item) => item.id === id) as TaskRecord, children: [] })),
    events: vi.fn(async () => []), executions: vi.fn(async () => []),
    updateTask: vi.fn(async (id, _revision, patch) => ({
      task: { ...(tasks.find((item) => item.id === id) as TaskRecord), ...patch },
    })),
    resumeTask: vi.fn(async () => ({ ok: true })), archiveTask: vi.fn(async (id) => ({ task: tasks.find((item) => item.id === id) as TaskRecord })),
    restoreTask: vi.fn(async (id) => ({ task: tasks.find((item) => item.id === id) as TaskRecord })),
    updateExecutionAssignments: vi.fn(), assignSourceSessionProject: vi.fn(),
  }
}

function renderView(api = apiMock()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  queryClient.setQueryData(queryKeys.snapshot, snapshot)
  render(
    <QueryClientProvider client={queryClient}>
      <TasksView api={api} snapshot={snapshot} />
    </QueryClientProvider>,
  )
  return { api, queryClient }
}

beforeEach(() => {
  ganttProps.mockClear()
  window.localStorage.clear()
})

test('client filters keep ancestors and never mutate server state', async () => {
  const blocked = filterTaskSnapshot(snapshot, { query: 'server', status: 'blocked' })

  expect(blocked.tasks.map(({ id }) => id)).toEqual(['project:recorder', 'other'])

  const { api } = renderView()
  const user = userEvent.setup()
  await user.type(screen.getByRole('searchbox', { name: '搜索任务' }), 'server')

  const latest = ganttProps.mock.lastCall?.[0].snapshot as DashboardSnapshot
  expect(latest.tasks.map(({ id }) => id)).toEqual(['project:recorder', 'other'])
  expect(api.updateTask).not.toHaveBeenCalled()
  expect(api.archiveTask).not.toHaveBeenCalled()
})

test('current status counts exclude completed work and history groups terminal states', () => {
  expect(taskStatusCounts(snapshot)).toEqual({
    all: 2,
    blocked: 1,
    active: 1,
    waiting: 0,
    planned: 0,
    history: 1,
  })
  expect(filterTaskSnapshot(snapshot, { status: 'all' }).tasks.map(({ id }) => id))
    .toEqual(['project:recorder', 'main', 'child', 'other'])
  expect(filterTaskSnapshot(snapshot, { status: 'history' }).tasks.map(({ id }) => id))
    .toEqual(['project:recorder', 'main', 'child'])
})

test('collapse and expand controls preserve the selected task details', async () => {
  renderView()
  const user = userEvent.setup()

  await user.click(screen.getByRole('button', { name: 'Select main' }))
  expect(await screen.findByRole('dialog', { name: 'React migration' })).toBeInTheDocument()

  await user.click(screen.getByRole('button', { name: '全部折叠' }))
  expect(screen.getByRole('dialog', { name: 'React migration' })).toBeInTheDocument()
  expect(ganttProps.mock.lastCall?.[0].openIds).toEqual(new Set())
})

test('does not archive completed tasks merely by rendering them', () => {
  const api = apiMock()
  renderView(api)

  expect(api.archiveTask).not.toHaveBeenCalled()
})

test('status mutation is optimistic, revisioned, and rolls back on conflict', async () => {
  let rejectMutation: (error: unknown) => void = () => undefined
  const api = apiMock()
  vi.mocked(api.updateTask).mockImplementation(() => new Promise((_resolve, reject) => {
    rejectMutation = reject
  }))
  const { queryClient } = renderView(api)
  const user = userEvent.setup()

  await user.click(screen.getByRole('button', { name: 'Select main' }))
  await screen.findByRole('dialog', { name: 'React migration' })
  await user.click(screen.getByRole('button', { name: /修改任务状态/ }))
  await user.click(await screen.findByRole('option', { name: '已完成' }))

  expect(api.updateTask).toHaveBeenCalledWith('main', 1, { status: 'done' })
  expect(queryClient.getQueryData<DashboardSnapshot>(queryKeys.snapshot)?.tasks.find(({ id }) => id === 'main')?.status).toBe('done')

  rejectMutation(new DashboardApiError('conflict', { code: 'TASK_VERSION_CONFLICT', status: 409 }))
  expect(await screen.findByText('任务已在其他位置更新，已恢复最新数据。请检查后重试。')).toBeInTheDocument()
  expect(queryClient.getQueryData<DashboardSnapshot>(queryKeys.snapshot)?.tasks.find(({ id }) => id === 'main')?.status).toBe('active')
  await waitFor(() => expect(queryClient.getQueryState(queryKeys.snapshot)?.isInvalidated).toBe(true))
})

test('resume is available only when the task has a session context', async () => {
  const api = apiMock()
  renderView(api)
  const user = userEvent.setup()

  await user.click(screen.getByRole('button', { name: 'Select main' }))
  await user.click(await screen.findByRole('button', { name: '在终端恢复' }))

  expect(api.resumeTask).toHaveBeenCalledWith('main')
})

test('Timeline label control updates the renderer and persists the preference', async () => {
  renderView()
  const user = userEvent.setup()

  expect(ganttProps.mock.lastCall?.[0].labelsVisible).toBe(true)
  await user.click(screen.getByRole('button', { name: '隐藏 Timeline 标签' }))

  expect(ganttProps.mock.lastCall?.[0].labelsVisible).toBe(false)
  expect(window.localStorage.getItem('dashboard-show-timeline-labels')).toBe('false')
  expect(screen.getByRole('button', { name: '显示 Timeline 标签' })).toHaveAttribute('aria-pressed', 'false')
})

test('restores the saved Timeline label preference', () => {
  window.localStorage.setItem('dashboard-show-timeline-labels', 'false')

  renderView()

  expect(ganttProps.mock.lastCall?.[0].labelsVisible).toBe(false)
  expect(screen.getByRole('button', { name: '显示 Timeline 标签' })).toBeInTheDocument()
})
