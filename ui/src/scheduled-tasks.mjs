import { escapeHtml } from './dashboard-state.mjs'
import { runStatusPresentation } from './scheduled-run-review.mjs'

const DASHBOARD_VIEWS = ['tasks', 'scheduled']
const SCHEDULE_FILTERS = ['all', 'active', 'paused']
const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日']

function isActive(schedule) {
  return schedule?.enabled === true || schedule?.enabled === 1
}

function hasActiveRun(schedule) {
  return ['queued', 'claimed', 'running'].includes(schedule?.current_execution?.status)
}

function safeDateValue(value, fallback = Number.POSITIVE_INFINITY) {
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? timestamp : fallback
}

function compareText(left, right) {
  return String(left ?? '').localeCompare(String(right ?? ''), 'zh-CN')
}

function pad(value) {
  return String(value).padStart(2, '0')
}

function compactTime(value) {
  if (!value) return '未安排'
  const date = new Date(value)
  if (Number.isNaN(date.valueOf())) return '时间未知'
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date)
}

function relativeTime(value, now = Date.now()) {
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return '—'
  const delta = timestamp - now
  const absolute = Math.abs(delta)
  const formatter = new Intl.RelativeTimeFormat('zh-CN', { numeric: 'auto' })
  if (absolute < 60_000) return formatter.format(Math.round(delta / 1_000), 'second')
  if (absolute < 3_600_000) return formatter.format(Math.round(delta / 60_000), 'minute')
  if (absolute < 86_400_000) return formatter.format(Math.round(delta / 3_600_000), 'hour')
  return formatter.format(Math.round(delta / 86_400_000), 'day')
}

export function cadenceSummary(cadence) {
  const value = cadence && typeof cadence === 'object' && !Array.isArray(cadence) ? cadence : {}
  switch (value.kind) {
    case 'once': return `一次 · ${compactTime(value.at)}`
    case 'hourly': return `每小时 ${pad(value.minute ?? 0)} 分`
    case 'daily': return `每天 ${pad(value.hour ?? 0)}:${pad(value.minute ?? 0)}`
    case 'weekly': {
      const weekdays = Array.isArray(value.weekdays)
        ? value.weekdays.map((day) => WEEKDAYS[Number(day) - 1]).filter(Boolean).join('、')
        : ''
      return `每周${weekdays || '—'} ${pad(value.hour ?? 0)}:${pad(value.minute ?? 0)}`
    }
    case 'monthly': return `每月 ${value.day ?? '—'} 日 ${pad(value.hour ?? 0)}:${pad(value.minute ?? 0)}`
    default: return '计划待解析'
  }
}

export function sortScheduledTasks(jobs = []) {
  return [...(Array.isArray(jobs) ? jobs : [])].sort((left, right) => {
    const leftUnread = Number.isSafeInteger(left?.unread_run_count) && left.unread_run_count > 0
    const rightUnread = Number.isSafeInteger(right?.unread_run_count) && right.unread_run_count > 0
    if (leftUnread !== rightUnread) return leftUnread ? -1 : 1
    const leftActive = isActive(left)
    const rightActive = isActive(right)
    if (leftActive !== rightActive) return leftActive ? -1 : 1
    if (leftActive) {
      const leftNext = safeDateValue(left.next_run_at)
      const rightNext = safeDateValue(right.next_run_at)
      if (leftNext !== rightNext) return leftNext < rightNext ? -1 : 1
    } else {
      const updated = safeDateValue(right.updated_at, 0) - safeDateValue(left.updated_at, 0)
      if (updated !== 0) return updated
    }
    return compareText(left.title, right.title) || compareText(left.id, right.id)
  })
}

export function filterScheduledTasks(jobs = [], { query = '', status = 'all' } = {}) {
  const needle = String(query ?? '').trim().toLocaleLowerCase()
  const selected = SCHEDULE_FILTERS.includes(status) ? status : 'all'
  return sortScheduledTasks(jobs).filter((schedule) => {
    if (selected === 'active' && !isActive(schedule)) return false
    if (selected === 'paused' && isActive(schedule)) return false
    if (!needle) return true
    return [schedule.title, schedule.workspace, cadenceSummary(schedule.cadence)]
      .some((value) => String(value ?? '').toLocaleLowerCase().includes(needle))
  })
}

function icon(name) {
  const paths = {
    edit: '<path d="M4 14h3l7.2-7.2a1.7 1.7 0 0 0-2.4-2.4L4.6 11.6 4 14Z"></path><path d="m10.8 5.4 2.4 2.4"></path>',
    run: '<path d="m6 4 8 5-8 5V4Z"></path>',
    pause: '<path d="M6.5 4.5v9M11.5 4.5v9"></path>',
    resume: '<path d="m6 4 8 5-8 5V4Z"></path>',
  }
  return `<svg viewBox="0 0 18 18" aria-hidden="true">${paths[name] ?? ''}</svg>`
}

function executionPresentation(schedule, busyAction, now) {
  if (busyAction === 'run') return { label: '正在创建', tone: 'running', meta: '写入执行记录', loading: true }
  const execution = schedule.current_execution
  if (!execution) return { label: '尚未运行', tone: 'idle', meta: '查看执行记录', loading: false }
  const status = runStatusPresentation(execution.status)
  const timestamp = execution.finished_at ?? execution.started_at ?? execution.created_at
  const outputs = Number.isSafeInteger(execution.output_count) && execution.output_count > 0 ? `${execution.output_count} outputs` : null
  const error = execution.error_code ?? null
  return {
    label: status.label,
    tone: status.tone,
    meta: [outputs ?? error, relativeTime(timestamp, now)].filter(Boolean).join(' · '),
    loading: ['queued', 'running'].includes(execution.status),
  }
}

function scheduleRow(schedule, busyIds, busyActions, now) {
  const active = isActive(schedule)
  const busy = busyIds.has(schedule.id)
  const runActive = hasActiveRun(schedule)
  const action = active ? 'pause' : 'resume'
  const actionLabel = active ? '暂停 Schedule' : '启用 Schedule'
  const unread = Number.isSafeInteger(schedule.unread_run_count) && schedule.unread_run_count > 0
    ? schedule.unread_run_count
    : 0
  const busyAction = busyActions.get(schedule.id) ?? null
  const execution = executionPresentation(schedule, busyAction, now)
  const runLabel = runActive ? '已有 Run 正在执行' : '立即运行'
  const runDisabled = busy || runActive
  return `<li class="scheduled-task-row${active ? '' : ' is-paused'}" data-scheduled-row="${escapeHtml(schedule.id)}">
    <div class="scheduled-task-main"><div class="scheduled-title-line"><h2>${escapeHtml(schedule.title || 'Untitled schedule')}</h2>${active ? '' : '<span class="scheduled-paused-label">已暂停</span>'}</div><p class="scheduled-cadence">${escapeHtml(cadenceSummary(schedule.cadence))}</p><code class="scheduled-workspace">${escapeHtml(schedule.workspace || 'Workspace 未知')}</code></div>
    <button class="scheduled-execution is-${escapeHtml(execution.tone)}" type="button" data-scheduled-action="review" data-scheduled-id="${escapeHtml(schedule.id)}" aria-label="查看 ${escapeHtml(schedule.title || 'Schedule')} 的执行记录"><span class="scheduled-execution-indicator${execution.loading ? ' is-loading' : ''}" aria-hidden="true"></span><span class="scheduled-execution-copy"><strong>${escapeHtml(execution.label)}</strong><small>${escapeHtml(execution.meta || '查看执行记录')}</small></span>${unread ? `<span class="scheduled-execution-unread" aria-label="${unread} 条未读记录">${unread}</span>` : ''}</button>
    <div class="scheduled-next-run"><span>下次运行</span><time datetime="${escapeHtml(schedule.next_run_at || '')}">${escapeHtml(active ? compactTime(schedule.next_run_at) : '—')}</time></div>
    <div class="scheduled-task-actions" aria-label="${escapeHtml(schedule.title || 'Schedule')} 操作"><button type="button" data-scheduled-action="edit" data-scheduled-id="${escapeHtml(schedule.id)}" aria-label="编辑 Schedule" title="编辑"${busy ? ' disabled' : ''}>${icon('edit')}</button><button class="scheduled-run-now" type="button" data-scheduled-action="run" data-scheduled-id="${escapeHtml(schedule.id)}" aria-label="${runLabel}" title="${runLabel}" aria-busy="${busyAction === 'run'}"${runDisabled ? ' disabled' : ''}>${busyAction === 'run' ? '<span class="scheduled-action-spinner" aria-hidden="true"></span>' : icon('run')}</button><button type="button" data-scheduled-action="${action}" data-scheduled-id="${escapeHtml(schedule.id)}" aria-label="${actionLabel}" title="${actionLabel}"${busy ? ' disabled' : ''}>${icon(action)}</button></div>
  </li>`
}

function invalidDefinitionsMarkup(records) {
  const invalid = Array.isArray(records) ? records : []
  if (invalid.length === 0) return ''
  const items = invalid.map((record) => `<li><code>${escapeHtml(record?.source_path || 'Unknown file')}</code><span><strong>${escapeHtml(record?.error_code || 'SCHEDULE_DEFINITION_INVALID')}</strong>${record?.message ? ` · ${escapeHtml(record.message)}` : ''}</span></li>`).join('')
  return `<section class="scheduled-definition-errors" role="alert" aria-labelledby="scheduled-definition-errors-title"><div><strong id="scheduled-definition-errors-title">${invalid.length} 个 definition 未启用</strong><span>修复 Markdown 后会自动重新读取。</span></div><ol>${items}</ol></section>`
}

function contentMarkup({ state, capability, jobs, filters, message, busyIds, busyActions, now }) {
  if (capability?.supported === false) {
    return `<div class="scheduled-state-panel is-unsupported" role="status"><strong>当前环境不支持 Scheduled Tasks</strong><span>${escapeHtml(capability.backend ? `Backend · ${capability.backend}` : 'Scheduler capability 暂不可用')}</span></div>`
  }
  if (state === 'loading') {
    return '<div class="scheduled-state-panel" role="status" aria-busy="true"><strong>正在读取 Scheduled Tasks…</strong><span>正在同步本机 scheduler 状态</span></div>'
  }
  if (state === 'error') {
    return `<div class="scheduled-state-panel is-error" role="alert"><strong>Scheduled Tasks 暂不可用</strong><span>${escapeHtml(message || '请检查 taskd 连接后重试')}</span></div>`
  }
  const filtered = filterScheduledTasks(jobs, filters)
  if (jobs.length === 0) {
    return '<div class="scheduled-state-panel"><strong>还没有 Scheduled Task</strong><span>创建一个本机 Codex 工作计划。电脑需处于唤醒状态；错过的计划最多补跑一次。</span></div>'
  }
  if (filtered.length === 0) {
    return '<div class="scheduled-state-panel"><strong>没有匹配的 Scheduled Task</strong><span>调整搜索或状态筛选。</span></div>'
  }
  return `<ol class="scheduled-task-list">${filtered.map((schedule) => scheduleRow(schedule, busyIds, busyActions, now)).join('')}</ol>`
}

export function scheduledTasksMarkup({
  state = 'ready',
  capability = null,
  jobs = [],
  invalid = [],
  filters = {},
  message = '',
  busyIds = new Set(),
  busyActions = new Map(),
  now = Date.now(),
} = {}) {
  const normalizedFilters = {
    query: String(filters.query ?? ''),
    status: SCHEDULE_FILTERS.includes(filters.status) ? filters.status : 'all',
  }
  const normalizedJobs = Array.isArray(jobs) ? jobs : []
  const activeCount = normalizedJobs.filter(isActive).length
  const unreadCount = normalizedJobs.reduce((total, job) => total + (Number.isSafeInteger(job.unread_run_count) ? Math.max(0, job.unread_run_count) : 0), 0)
  const controlsDisabled = state !== 'ready' || capability?.supported === false
  const filterMarkup = SCHEDULE_FILTERS.map((key) => {
    const labels = { all: '全部', active: '启用', paused: '暂停' }
    return `<button type="button" class="scheduled-filter${normalizedFilters.status === key ? ' is-active' : ''}" data-scheduled-filter="${key}" aria-pressed="${normalizedFilters.status === key}"${controlsDisabled ? ' disabled' : ''}>${labels[key]}</button>`
  }).join('')
  return `<section class="scheduled-tasks-shell" aria-labelledby="scheduled-tasks-title" aria-busy="${state === 'loading'}">
    <header class="scheduled-tasks-header"><div><h1 id="scheduled-tasks-title">Scheduled</h1><p>${normalizedJobs.length} 个计划 · ${activeCount} 个启用${unreadCount ? ` · ${unreadCount} 条未读记录` : ''}</p></div><button class="scheduled-create" type="button" data-scheduled-action="create"${controlsDisabled ? ' disabled' : ''}>新建计划</button></header>
    <div class="scheduled-toolbar"><label class="scheduled-search"><span class="sr-only">搜索 Scheduled Tasks</span><input type="search" value="${escapeHtml(normalizedFilters.query)}" data-scheduled-search placeholder="搜索标题、Workspace 或 cadence"${controlsDisabled ? ' disabled' : ''}></label><div class="scheduled-filters" role="group" aria-label="Scheduled 状态筛选">${filterMarkup}</div></div>
    ${invalidDefinitionsMarkup(invalid)}
    ${message && state !== 'error' ? `<div class="scheduled-action-error" role="alert">${escapeHtml(message)}</div>` : ''}
    <div class="scheduled-list-region">${contentMarkup({ state, capability, jobs: normalizedJobs, filters: normalizedFilters, message, busyIds, busyActions, now })}</div>
  </section>`
}

export function viewSwitchMarkup(activeView = 'tasks') {
  const selected = DASHBOARD_VIEWS.includes(activeView) ? activeView : 'tasks'
  return `<div class="global-view-tabs" role="tablist" aria-label="Dashboard 视图"><button class="global-view-tab${selected === 'tasks' ? ' is-active' : ''}" id="dashboard-view-tasks" type="button" role="tab" aria-selected="${selected === 'tasks'}" aria-controls="gantt_here" tabindex="${selected === 'tasks' ? '0' : '-1'}" data-dashboard-view-tab="tasks">Tasks</button><button class="global-view-tab${selected === 'scheduled' ? ' is-active' : ''}" id="dashboard-view-scheduled" type="button" role="tab" aria-selected="${selected === 'scheduled'}" aria-controls="scheduled-tasks-panel" tabindex="${selected === 'scheduled' ? '0' : '-1'}" data-dashboard-view-tab="scheduled">Scheduled</button></div>`
}

export function nextDashboardView(current, key) {
  const index = Math.max(0, DASHBOARD_VIEWS.indexOf(current))
  if (key === 'Home') return DASHBOARD_VIEWS[0]
  if (key === 'End') return DASHBOARD_VIEWS.at(-1)
  if (key === 'ArrowRight') return DASHBOARD_VIEWS[(index + 1) % DASHBOARD_VIEWS.length]
  if (key === 'ArrowLeft') return DASHBOARD_VIEWS[(index - 1 + DASHBOARD_VIEWS.length) % DASHBOARD_VIEWS.length]
  return DASHBOARD_VIEWS[index]
}

export function createScheduledTasksView({
  element,
  api,
  onCreate = () => undefined,
  onEdit = () => undefined,
  onReview = () => undefined,
  onMessage = () => undefined,
} = {}) {
  if (!element?.addEventListener) throw new TypeError('element is required')
  if (!api?.schedules) throw new TypeError('api.schedules is required')

  const state = {
    visible: false,
    destroyed: false,
    loading: false,
    error: null,
    message: '',
    jobs: [],
    invalid: [],
    capability: null,
    filters: { query: '', status: 'all' },
    busyIds: new Set(),
    busyActions: new Map(),
    relativeTimer: null,
  }

  function render() {
    if (state.destroyed) return
    element.innerHTML = scheduledTasksMarkup({
      state: state.loading ? 'loading' : (state.error ? 'error' : 'ready'),
      capability: state.capability,
      jobs: state.jobs,
      invalid: state.invalid,
      filters: state.filters,
      message: state.error?.message ?? state.message,
      busyIds: state.busyIds,
      busyActions: state.busyActions,
    })
  }

  async function refresh({ blocking = state.jobs.length === 0 } = {}) {
    if (state.destroyed) return
    state.loading = blocking
    state.error = null
    render()
    try {
      const result = await api.schedules()
      if (!result || typeof result !== 'object' || !Array.isArray(result.jobs)) {
        throw new TypeError('Schedule list response is invalid')
      }
      state.jobs = result.jobs
      state.invalid = Array.isArray(result.invalid) ? result.invalid : []
      state.capability = result.capability && typeof result.capability === 'object'
        ? result.capability
        : null
    } catch (error) {
      state.error = error instanceof Error ? error : new Error('无法读取 Scheduled Tasks')
      onMessage(state.error.message)
    } finally {
      state.loading = false
      render()
    }
  }

  async function mutate(action, job) {
    if (!job || state.busyIds.has(job.id) || (action === 'run' && hasActiveRun(job))) return
    state.busyIds.add(job.id)
    state.busyActions.set(job.id, action)
    state.message = ''
    render()
    try {
      if (action === 'pause') await api.pauseSchedule(job.id, job.etag)
      else if (action === 'resume') await api.resumeSchedule(job.id, job.etag)
      else await api.runScheduleNow(job.id)
      await refresh({ blocking: false })
    } catch (error) {
      state.message = error?.message ?? 'Scheduled Task 更新失败'
      onMessage(state.message)
    } finally {
      state.busyIds.delete(job.id)
      state.busyActions.delete(job.id)
      render()
    }
  }

  function onInput(event) {
    if (!event.target.matches?.('[data-scheduled-search]')) return
    state.filters.query = event.target.value
    render()
    const next = element.querySelector('[data-scheduled-search]')
    next?.focus({ preventScroll: true })
    next?.setSelectionRange?.(next.value.length, next.value.length)
  }

  function onClick(event) {
    const trigger = event.target.closest?.('[data-scheduled-action], [data-scheduled-filter]')
    if (!trigger || state.destroyed) return
    const filter = trigger.dataset.scheduledFilter
    if (filter) {
      state.filters.status = filter
      render()
      return
    }
    const action = trigger.dataset.scheduledAction
    if (action === 'create') {
      onCreate(trigger)
      return
    }
    const job = state.jobs.find(({ id }) => id === trigger.dataset.scheduledId)
    if (action === 'edit') {
      if (job) onEdit(job, trigger)
      return
    }
    if (action === 'review') {
      if (job) onReview(job, trigger)
      return
    }
    void mutate(action, job)
  }

  element.addEventListener('input', onInput)
  element.addEventListener('click', onClick)

  async function show() {
    state.visible = true
    element.hidden = false
    render()
    if (state.relativeTimer === null) state.relativeTimer = globalThis.setInterval(render, 30_000)
    await refresh()
  }

  function hide() {
    state.visible = false
    element.hidden = true
    if (state.relativeTimer !== null) globalThis.clearInterval(state.relativeTimer)
    state.relativeTimer = null
  }

  function destroy() {
    if (state.destroyed) return
    state.destroyed = true
    if (state.relativeTimer !== null) globalThis.clearInterval(state.relativeTimer)
    element.removeEventListener('input', onInput)
    element.removeEventListener('click', onClick)
    element.innerHTML = ''
  }

  render()
  return { show, hide, refresh, destroy, isVisible: () => state.visible }
}
