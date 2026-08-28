import { QueryClient } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'

import type { DashboardApi } from '@/lib/api/dashboard-api'
import type { DashboardMeta, DashboardSnapshot, TaskRecord } from '@/lib/api/types'
import { AppProviders } from './app-providers'
import { DashboardApp } from './dashboard-app'

vi.mock('@/features/tasks/task-gantt', () => ({
  TaskGantt: () => <div data-testid="task-gantt" />,
}))

const meta: DashboardMeta = {
  service: 'tasks-recorder',
  service_version: '0.6.2',
  api_version: 'v1',
  capabilities: {
    runtime_registry: true,
    unified_runs: true,
    internal_scheduler: true,
  },
}

const task = {
  id: 'task-a',
  parent_id: 'project:recorder',
  project_id: 'recorder',
  entity_type: 'main_task',
  title: 'Task A',
  description: null,
  lifecycle: 'in_progress',
  status: 'active',
  rollup_state: 'in_progress',
  sort_order: 0,
  revision: 1,
  archived_at: null,
  progress: null,
  agent: 'Codex',
  next_action: null,
  planned: null,
  actual: null,
  actual_segments: [],
  actual_segment_count: 0,
  start: null,
  end: null,
  last_activity: '2026-08-28T04:00:00.000Z',
  updated_at: '2026-08-28T04:00:00.000Z',
  session_id: null,
  session_source: null,
  resume_available: false,
  workspace: '/Users/me/project',
  workfolder: '/Users/me/project',
  worktree: '/Users/me/project',
  branch: 'main',
  execution_count: 0,
  active_execution_count: 0,
  running_execution_count: 0,
  idle_execution_count: 0,
  stale_execution_count: 0,
  active_agent_count: 0,
  live_state: 'none',
  blocked_count: 0,
} satisfies TaskRecord

const snapshot: DashboardSnapshot = {
  server_instance_id: 'server-a',
  revision: 7,
  schema_version: 3,
  generated_at: '2026-08-28T04:00:00.000Z',
  home_directory: '/Users/me',
  tasks: [task, { ...task, id: 'task-b', title: 'Task B' }],
  projects: [],
  warnings: [],
  project_inbox: [],
  project_inbox_count: 0,
  attribution_inbox_count: 0,
  unassigned_execution_count: 0,
}

function dashboardApi(): DashboardApi {
  return {
    meta: vi.fn(async () => meta),
    snapshot: vi.fn(async () => snapshot),
    task: vi.fn(),
    events: vi.fn(async () => []),
    executions: vi.fn(async () => []),
    updateTask: vi.fn(),
    resumeTask: vi.fn(),
    archiveTask: vi.fn(),
    restoreTask: vi.fn(),
    updateExecutionAssignments: vi.fn(),
    assignSourceSessionProject: vi.fn(),
  }
}

function renderApp() {
  return render(
    <AppProviders
      api={dashboardApi()}
      queryClient={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      createEventSource={null}
    >
      <DashboardApp />
    </AppProviders>,
  )
}

beforeEach(() => {
  window.history.replaceState(null, '', '/')
})

test('renders the real app identity, task count, and concise connection state', async () => {
  renderApp()

  expect(screen.getByRole('heading', { name: 'Tasks Recorder' })).toBeInTheDocument()
  expect(await screen.findByText('2 个任务')).toBeInTheDocument()
  expect(screen.getByRole('status', { name: '实时连接已断开' })).toBeInTheDocument()
  expect(screen.queryByText(/loading|加载中/i)).not.toBeInTheDocument()
})

test('keeps Tasks URL-backed and exposes Scheduled as an honest migration state', async () => {
  renderApp()

  const tasks = screen.getByRole('button', { name: 'Tasks' })
  const scheduled = screen.getByRole('button', { name: 'Scheduled（迁移中）' })
  expect(tasks).toHaveAttribute('aria-current', 'page')
  expect(tasks).toHaveAttribute('tabindex', '0')
  expect(scheduled).toBeDisabled()
  await waitFor(() => expect(window.location.search).toBe('?view=tasks'))
})

test('global actions own a safe inset and never use edge-positioned inline styles', () => {
  renderApp()

  const actions = screen.getByTestId('global-actions')
  expect(actions).toHaveAttribute('data-safe-area', 'global-actions')
  expect(actions.style.position).toBe('')
  expect(actions.style.right).toBe('')
})
