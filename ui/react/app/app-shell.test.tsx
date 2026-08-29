import { QueryClient } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { createDashboardApi, type DashboardApi } from '@/lib/api/dashboard-api'
import type { DashboardMeta, DashboardSnapshot, RunRecord, ScheduleRecord, TaskRecord } from '@/lib/api/types'
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

const schedule: ScheduleRecord = {
  id: 'schedule-a', title: 'Codex update report', workspace: '/Users/me/notes', agent: 'codex',
  cadence: { kind: 'daily', hour: 9, minute: 0, timezone_mode: 'system' },
  timezone_mode: 'system', thread_mode: 'new', sandbox_mode: 'read-only', model: 'gpt-5.6',
  reasoning_effort: 'low', timeout_seconds: 7200, enabled: true, etag: 'a'.repeat(64),
  source_path: '/Users/me/schedules/codex-update-report.md', schedule_generation: 1,
  sync_state: 'synced', sync_error_code: null, next_run_at: '2026-08-29T01:00:00.000Z',
  last_run_at: null, unread_run_count: 0, last_run: null, current_execution: null,
  created_at: '2026-08-28T01:00:00.000Z', updated_at: '2026-08-28T01:00:00.000Z',
}

const run: RunRecord = {
  id: 'run-a', job_id: schedule.id, definition_etag: schedule.etag, runtime_id: 'codex',
  interactive: false, turn_revision: null, trigger: 'manual', status: 'succeeded',
  thread_id: '019fcfae-8d5b-7640-aec8-83a114810589', scheduled_for: null,
  claimed_at: '2026-08-28T02:00:00.000Z', started_at: '2026-08-28T02:00:01.000Z',
  heartbeat_at: '2026-08-28T02:00:03.000Z', finished_at: '2026-08-28T02:01:00.000Z',
  exit_code: 0, error_code: null, final_message: 'Report completed.',
  file_changes: [{ path: 'report.md', kind: 'update' }], has_stdout_log: true,
  has_stderr_log: false, reviewed_at: null, created_at: '2026-08-28T02:00:00.000Z',
  updated_at: '2026-08-28T02:01:00.000Z',
}

class FakeRunEventSource {
  static instances: FakeRunEventSource[] = []

  readonly url: string
  readonly listeners = new Map<string, EventListener[]>()
  closed = false

  constructor(url: string) {
    this.url = url
    FakeRunEventSource.instances.push(this)
  }

  addEventListener(type: string, listener: EventListener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }

  dispatch(type: string, data?: object, lastEventId = '') {
    const event = data
      ? new MessageEvent(type, { data: JSON.stringify(data), lastEventId })
      : new Event(type)
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }

  close() { this.closed = true }
}

function dashboardApi(runRecord: RunRecord = run): DashboardApi {
  return {
    ...createDashboardApi({
      fetchImpl: vi.fn(async () => new Response('{}', {
        headers: { 'Content-Type': 'application/json' },
      })),
    }),
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
    schedules: vi.fn(async () => ({
      capability: { supported: true, backend: 'internal' }, jobs: [schedule], invalid: [],
    })),
    runScheduleNow: vi.fn(async () => ({ dispatched: true })),
    pauseSchedule: vi.fn(async () => ({ job: { ...schedule, enabled: false } })),
    resumeSchedule: vi.fn(async () => ({ job: { ...schedule, enabled: true } })),
    schedule: vi.fn(async () => ({ job: { ...schedule, prompt: 'Create report.' } })),
    scheduleRuns: vi.fn(async () => ({ runs: [runRecord], dispatches: [] })),
    scheduledRun: vi.fn(async () => ({ run: runRecord })),
    scheduledRunLog: vi.fn(async () => ({ stream: 'stdout' as const, content: 'completed\n' })),
    markScheduledRunReviewed: vi.fn(async () => ({
      run: { ...runRecord, reviewed_at: '2026-08-28T03:00:00.000Z' }, changed: true,
    })),
    resumeScheduledRun: vi.fn(async () => ({ ok: true, run_id: runRecord.id })),
    steerRun: vi.fn(async (_id, input) => ({
      accepted: true, run_id: runRecord.id, turn_revision: input.expected_turn_revision,
    })),
    stopRun: vi.fn(async (_id, input) => ({
      accepted: true, run_id: runRecord.id, turn_revision: input.expected_turn_revision,
    })),
  }
}

function renderApp(api = dashboardApi()) {
  return render(
    <AppProviders
      api={api}
      queryClient={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      createEventSource={null}
    >
      <DashboardApp />
    </AppProviders>,
  )
}

beforeEach(() => {
  window.history.replaceState(null, '', '/')
  FakeRunEventSource.instances = []
})

afterEach(() => vi.unstubAllGlobals())

test('renders the real app identity, task count, and concise connection state', async () => {
  renderApp()

  expect(screen.getByRole('heading', { name: 'Tasks Recorder' })).toBeInTheDocument()
  expect(await screen.findByText('2 个任务')).toBeInTheDocument()
  expect(screen.getByRole('status', { name: '实时连接已断开' })).toBeInTheDocument()
  expect(screen.queryByText(/loading|加载中/i)).not.toBeInTheDocument()
})

test('switches between URL-backed Tasks and Scheduled workspaces', async () => {
  const user = userEvent.setup()
  const api = dashboardApi()
  renderApp(api)

  const tasks = screen.getByRole('button', { name: 'Tasks' })
  const scheduled = screen.getByRole('button', { name: 'Scheduled' })
  expect(tasks).toHaveAttribute('aria-current', 'page')
  expect(tasks).toHaveAttribute('tabindex', '0')
  await waitFor(() => expect(window.location.search).toBe('?view=tasks'))

  await user.click(scheduled)
  expect(await screen.findByRole('heading', { name: 'Scheduled' })).toBeInTheDocument()
  expect(screen.getByText('Codex update report')).toBeInTheDocument()
  expect(scheduled).toHaveAttribute('aria-current', 'page')
  await waitFor(() => expect(window.location.search).toBe('?view=scheduled'))

  await user.click(screen.getByRole('button', { name: '立即运行' }))
  await waitFor(() => expect(api.runScheduleNow).toHaveBeenCalledWith('schedule-a', expect.any(String)))
  await user.click(screen.getByRole('button', { name: '暂停 Schedule' }))
  await waitFor(() => expect(api.pauseSchedule).toHaveBeenCalledWith('schedule-a', schedule.etag))

  await user.click(tasks)
  expect(await screen.findByTestId('task-gantt')).toBeInTheDocument()
  expect(tasks).toHaveAttribute('aria-current', 'page')
})

test('global actions own a safe inset and never use edge-positioned inline styles', () => {
  renderApp()

  const actions = screen.getByTestId('global-actions')
  expect(actions).toHaveAttribute('data-safe-area', 'global-actions')
  expect(actions.style.position).toBe('')
  expect(actions.style.right).toBe('')
})

test('opens Run Review and reads durable Run facts and logs', async () => {
  const user = userEvent.setup()
  const api = dashboardApi()
  renderApp(api)

  await user.click(screen.getByRole('button', { name: 'Scheduled' }))
  await user.click(await screen.findByRole('button', {
    name: '查看 Codex update report 的执行记录',
  }))

  expect(await screen.findByRole('heading', { name: 'Codex update report' })).toBeInTheDocument()
  expect(await screen.findByText('Report completed.')).toBeInTheDocument()
  expect(screen.getByText('report.md')).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'stdout' }))
  expect(await screen.findByText('completed', { selector: '.run-detail__log code' })).toBeInTheDocument()
  expect(api.scheduledRunLog).toHaveBeenCalledWith('run-a', { stream: 'stdout', tail: 32 * 1024 })
})

test('streams an interactive Run and steers the authoritative Turn without an optimistic bubble', async () => {
  const user = userEvent.setup()
  const activeRun: RunRecord = {
    ...run,
    interactive: true,
    turn_revision: null,
    status: 'running',
    thread_id: null,
    finished_at: null,
    exit_code: null,
    final_message: null,
    file_changes: [],
  }
  const terminalRun: RunRecord = {
    ...activeRun,
    interactive: false,
    turn_revision: null,
    status: 'canceled',
    thread_id: 'session-after-stop',
    finished_at: '2026-08-28T02:02:00.000Z',
    error_code: 'RUN_CANCELED',
    final_message: 'Stopped after review.',
  }
  const api = dashboardApi(activeRun)
  let detailReads = 0
  api.scheduledRun = vi.fn(async () => ({ run: detailReads++ === 0 ? activeRun : terminalRun }))
  vi.stubGlobal('EventSource', FakeRunEventSource)
  renderApp(api)

  await user.click(screen.getByRole('button', { name: 'Scheduled' }))
  await user.click(await screen.findByRole('button', {
    name: '查看 Codex update report 的执行记录',
  }))
  expect(await screen.findByRole('region', { name: 'Live Session' })).toBeInTheDocument()
  await waitFor(() => expect(FakeRunEventSource.instances).toHaveLength(1))
  const source = FakeRunEventSource.instances[0]
  expect(source.url).toBe('/api/v1/runs/run-a/events')

  source.dispatch('open')
  source.dispatch('run', {
    runId: run.id, sequence: 1, observedAt: '2026-08-28T02:00:02.000Z',
    type: 'turn_started', payload: { turn_revision: 2 },
  }, '1')
  source.dispatch('run', {
    runId: run.id, sequence: 2, observedAt: '2026-08-28T02:00:03.000Z',
    type: 'activity_started', payload: { item_id: 'tool-1', label: 'Read schema' },
  }, '2')
  source.dispatch('run', {
    runId: run.id, sequence: 3, observedAt: '2026-08-28T02:00:04.000Z',
    type: 'assistant_delta', payload: { item_id: 'message-1', delta: 'Checking **schema**' },
  }, '3')
  source.dispatch('run', {
    runId: run.id, sequence: 4, observedAt: '2026-08-28T02:00:05.000Z',
    type: 'assistant_delta', payload: { item_id: 'message-1', delta: '.' },
  }, '4')

  expect(await screen.findByText('Read schema')).toBeInTheDocument()
  expect(await screen.findByText('schema')).toBeInTheDocument()
  const composer = screen.getByRole('textbox', { name: '追加指令' })
  await user.type(composer, 'Inspect rollback too.')
  await user.click(screen.getByRole('button', { name: '发送' }))
  await waitFor(() => expect(api.steerRun).toHaveBeenCalledWith(run.id, {
    expected_turn_revision: 2,
    text: 'Inspect rollback too.',
  }))
  expect(composer).toHaveValue('')
  expect(screen.queryByText('Inspect rollback too.')).not.toBeInTheDocument()

  source.dispatch('run', {
    runId: run.id, sequence: 5, observedAt: '2026-08-28T02:00:06.000Z',
    type: 'status', payload: { state: 'canceled' },
  }, '5')
  expect(await screen.findByText('Stopped after review.')).toBeInTheDocument()
  expect(source.closed).toBe(true)
})
