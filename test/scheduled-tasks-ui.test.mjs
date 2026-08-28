import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  createScheduledTasksView,
  filterScheduledTasks,
  nextDashboardView,
  scheduledTasksMarkup,
  sortScheduledTasks,
  viewSwitchMarkup,
} from '../ui/src/scheduled-tasks.mjs'

const ETAG = 'a'.repeat(64)

test('mobile Scheduled controls retain compact visuals with 44px hit targets', async () => {
  const css = await readFile(new URL('../ui/src/dashboard.css', import.meta.url), 'utf8')
  assert.match(css, /\.scheduled-create\{min-height:44px\}/)
  assert.match(css, /\.scheduled-search input\{min-height:44px\}/)
  assert.match(css, /\.scheduled-filter\{height:44px;flex:1\}/)
  assert.match(css, /\.scheduled-task-actions button\{width:44px;height:44px\}/)
})

const schedules = [
  {
    id: 'paused-later', title: 'Paused archive', workspace: '/workspace/archive',
    cadence: { kind: 'weekly', weekdays: [1, 3], hour: 9, minute: 15 },
    enabled: false, etag: ETAG, sync_state: 'synced', sync_error_code: null,
    next_run_at: null, updated_at: '2026-08-25T08:00:00.000Z',
  },
  {
    id: 'active-no-date', title: 'Background review', workspace: '/workspace/review',
    cadence: { kind: 'hourly', minute: 30 },
    enabled: true, etag: ETAG, sync_state: 'error', sync_error_code: 'LAUNCHD_UNAVAILABLE',
    next_run_at: null, updated_at: '2026-08-24T08:00:00.000Z',
  },
  {
    id: 'active-next', title: 'Roadmap digest', workspace: '/workspace/roadmap',
    cadence: { kind: 'daily', hour: 9, minute: 0 },
    enabled: 1, etag: ETAG, sync_state: 'synced', sync_error_code: null,
    next_run_at: '2026-08-26T01:00:00.000Z', updated_at: '2026-08-24T09:00:00.000Z',
    unread_run_count: 2,
    last_run: { id: 'run-latest', status: 'succeeded', finished_at: '2026-08-25T07:30:00.000Z', reviewed_at: null },
    current_execution: {
      kind: 'run', id: 'run-latest', status: 'succeeded', started_at: '2026-08-25T07:28:00.000Z',
      finished_at: '2026-08-25T07:30:00.000Z', error_code: null, output_count: 2,
    },
  },
]

test('Scheduled filtering searches safe summary fields and sorts active next runs before paused updates', () => {
  assert.deepEqual(
    filterScheduledTasks(schedules, { query: 'road', status: 'all' }).map(({ id }) => id),
    ['active-next'],
  )
  assert.deepEqual(
    filterScheduledTasks(schedules, { query: '', status: 'paused' }).map(({ id }) => id),
    ['paused-later'],
  )
  assert.deepEqual(sortScheduledTasks(schedules).map(({ id }) => id), [
    'active-next', 'active-no-date', 'paused-later',
  ])
  assert.deepEqual(sortScheduledTasks([
    ...schedules,
    { ...schedules[1], id: 'active-no-date-alpha', title: 'Alpha review' },
  ]).map(({ id }) => id), [
    'active-next', 'active-no-date-alpha', 'active-no-date', 'paused-later',
  ])
  assert.equal(sortScheduledTasks([
    schedules[1],
    { ...schedules[0], id: 'paused-unread', unread_run_count: 1 },
  ])[0].id, 'paused-unread')
})

test('Scheduled markup presents a compact execution control plane without sync rails or Runs buttons', () => {
  const list = scheduledTasksMarkup({
    jobs: [{
      ...schedules[2], title: 'Roadmap <script>alert(1)</script>', workspace: '/workspace/<unsafe>',
    }, schedules[1], schedules[0]],
    invalid: [{
      source_path: '/schedules/broken.md',
      error_code: 'SCHEDULE_DEFINITION_YAML_INVALID',
      message: 'line 4 is invalid <unsafe>',
    }],
    filters: { query: '', status: 'all' },
  })
  assert.match(list, /data-scheduled-search/)
  assert.match(list, /data-scheduled-filter="active"/)
  assert.match(list, /Roadmap &lt;script&gt;alert\(1\)&lt;\/script&gt;/)
  assert.match(list, /\/workspace\/&lt;unsafe&gt;/)
  assert.match(list, /data-scheduled-action="edit"/)
  assert.match(list, /data-scheduled-action="review"/)
  assert.match(list, /2 outputs/)
  assert.match(list, /已成功/)
  assert.match(list, /data-scheduled-action="run"/)
  assert.match(list, /data-scheduled-action="pause"/)
  assert.match(list, /data-scheduled-action="resume"/)
  assert.doesNotMatch(list, />Runs(?:\s|<)/)
  assert.doesNotMatch(list, />Active(?:\s|<)/i)
  assert.doesNotMatch(list, /已同步/)
  assert.doesNotMatch(list, /scheduled-sync|scheduled-state-dot/)
  assert.doesNotMatch(list, /<script>/)
  assert.doesNotMatch(list, /Automation control plane/)
  assert.match(list, /1 个 definition 未启用/)
  assert.match(list, /\/schedules\/broken\.md/)
  assert.match(list, /SCHEDULE_DEFINITION_YAML_INVALID/)
  assert.doesNotMatch(list, /line 4 is invalid <unsafe>/)

  assert.match(scheduledTasksMarkup({ state: 'loading' }), /正在读取 Scheduled Tasks/)
  const error = scheduledTasksMarkup({ state: 'error', message: 'offline' })
  assert.match(error, /offline/)
  assert.match(error, /data-scheduled-action="create" disabled/)
  assert.match(error, /data-scheduled-search[^>]*disabled/)
  assert.match(scheduledTasksMarkup({ capability: { supported: false, backend: 'unsupported' } }), /当前环境不支持 Scheduled Tasks/)
  assert.match(scheduledTasksMarkup({ jobs: [] }), /还没有 Scheduled Task/)
})

test('Scheduled markup exposes queued, running, failed Run, and busy states without request alerts', () => {
  const states = [
    { status: 'queued', requested_at: '2026-08-26T01:00:00.000Z' },
    { status: 'running', started_at: '2026-08-26T01:00:00.000Z' },
    { status: 'failed', started_at: '2026-08-26T01:00:00.000Z', error_code: 'RUN_SPAWN_FAILED' },
  ]
  const markup = scheduledTasksMarkup({
    jobs: [
      ...states.map((current_execution, index) => ({ ...schedules[2], id: `state-${index}`, current_execution })),
      { ...schedules[2], id: 'state-busy' },
    ],
    busyIds: new Set(['state-busy']),
    busyActions: new Map([['state-busy', 'run']]),
  })
  assert.match(markup, /排队中/)
  assert.match(markup, /运行中/)
  assert.match(markup, /失败/)
  assert.match(markup, /RUN_SPAWN_FAILED/)
  assert.match(markup, /data-scheduled-id="state-busy"[^>]*aria-busy="true"/)
  assert.match(markup, /data-scheduled-id="state-0"[^>]*aria-label="已有 Run 正在执行"[^>]*disabled/)
  assert.match(markup, /data-scheduled-id="state-1"[^>]*aria-label="已有 Run 正在执行"[^>]*disabled/)
  assert.doesNotMatch(markup, /已请求运行/)
})

test('Scheduled view rejects Run Now locally while its durable Run is active', async () => {
  const listeners = new Map()
  const element = {
    hidden: true,
    innerHTML: '',
    addEventListener: (type, listener) => listeners.set(type, listener),
    removeEventListener: (type) => listeners.delete(type),
  }
  let runCalls = 0
  const view = createScheduledTasksView({
    element,
    api: {
      schedules: async () => ({
        jobs: [{
          ...schedules[2],
          current_execution: {
            kind: 'run', id: 'run-active', status: 'running',
            started_at: '2026-08-26T01:00:00.000Z',
          },
        }],
        capability: { supported: true, backend: 'taskd-clock' },
      }),
      runScheduleNow: async () => { runCalls += 1 },
    },
  })

  await view.show()
  listeners.get('click')({ target: {
    dataset: { scheduledAction: 'run', scheduledId: 'active-next' },
    closest() { return this },
  } })
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(runCalls, 0)
  assert.doesNotMatch(element.innerHTML, /Schedule already has an active Run/)
  view.destroy()
})

test('global Tasks and Scheduled tabs use roving keyboard order', () => {
  const markup = viewSwitchMarkup('scheduled')
  assert.match(markup, /role="tablist"/)
  assert.match(markup, /data-dashboard-view-tab="tasks"/)
  assert.match(markup, /id="dashboard-view-scheduled"[^>]*aria-selected="true"[^>]*tabindex="0"[^>]*data-dashboard-view-tab="scheduled"/)
  assert.equal(nextDashboardView('tasks', 'ArrowRight'), 'scheduled')
  assert.equal(nextDashboardView('scheduled', 'ArrowLeft'), 'tasks')
  assert.equal(nextDashboardView('scheduled', 'Home'), 'tasks')
  assert.equal(nextDashboardView('tasks', 'End'), 'scheduled')
})

test('Scheduled view exposes bounded show, hide, refresh, and destroy lifecycle', async () => {
  const listeners = new Map()
  const element = {
    hidden: true,
    innerHTML: '',
    addEventListener: (type, listener) => listeners.set(type, listener),
    removeEventListener: (type) => listeners.delete(type),
  }
  let reads = 0
  const interactions = []
  const view = createScheduledTasksView({
    element,
    api: {
      schedules: async () => {
        reads += 1
        return { jobs: schedules, capability: { supported: true, backend: 'launchd' } }
      },
    },
    onCreate: (trigger) => interactions.push(['create', trigger]),
    onEdit: (job, trigger) => interactions.push(['edit', job.id, trigger]),
  })

  await view.show()
  assert.equal(view.isVisible(), true)
  assert.equal(element.hidden, false)
  assert.equal(reads, 1)
  assert.match(element.innerHTML, /Roadmap digest/)
  const createTrigger = {
    dataset: { scheduledAction: 'create' },
    closest() { return this },
  }
  listeners.get('click')({ target: createTrigger })
  const editTrigger = {
    dataset: { scheduledAction: 'edit', scheduledId: 'active-next' },
    closest() { return this },
  }
  listeners.get('click')({ target: editTrigger })
  assert.deepEqual(interactions, [
    ['create', createTrigger],
    ['edit', 'active-next', editTrigger],
  ])
  view.hide()
  assert.equal(view.isVisible(), false)
  assert.equal(element.hidden, true)
  view.destroy()
  assert.equal(listeners.size, 0)
  assert.equal(element.innerHTML, '')
})

test('Run now settles from the refreshed execution read model instead of emitting a synthetic success alert', async () => {
  const listeners = new Map()
  const element = {
    hidden: true,
    innerHTML: '',
    addEventListener: (type, listener) => listeners.set(type, listener),
    removeEventListener: (type) => listeners.delete(type),
  }
  let reads = 0
  let runCalls = 0
  const messages = []
  const view = createScheduledTasksView({
    element,
    api: {
      schedules: async () => {
        reads += 1
        return {
          jobs: [{
            ...schedules[2],
            current_execution: reads > 1 ? {
              kind: 'run', id: 'run-1', status: 'failed',
              started_at: '2026-08-26T01:00:00.000Z',
              finished_at: '2026-08-26T01:00:01.000Z',
              error_code: 'RUN_SPAWN_FAILED', output_count: 0,
            } : null,
          }],
          capability: { supported: true, backend: 'taskd-clock' },
        }
      },
      runScheduleNow: async () => { runCalls += 1; return { run: { id: 'run-1', status: 'queued' } } },
    },
    onMessage: (message) => messages.push(message),
  })
  await view.show()
  listeners.get('click')({ target: {
    dataset: { scheduledAction: 'run', scheduledId: 'active-next' },
    closest() { return this },
  } })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(runCalls, 1)
  assert.match(element.innerHTML, /失败/)
  assert.match(element.innerHTML, /RUN_SPAWN_FAILED/)
  assert.doesNotMatch(element.innerHTML, /已请求运行/)
  assert.deepEqual(messages, [])
  view.destroy()
})
