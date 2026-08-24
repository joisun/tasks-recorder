export function createTaskIndex(tasks) {
  const byId = new Map(tasks.map((task) => [task.id, task]))
  const childrenByParent = new Map()
  for (const task of tasks) {
    if (!task.parent_id) continue
    const children = childrenByParent.get(task.parent_id) ?? []
    children.push(task)
    childrenByParent.set(task.parent_id, children)
  }
  return { byId, childrenByParent }
}

const GRID_MIN_WIDTH = 240
const TIMELINE_MIN_WIDTH = 320
const TIMELINE_SPLITTER_WIDTH = 9

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value))
}

export function isArchivedGroup(task, index) {
  const children = index.childrenByParent.get(task.id) ?? []
  return Boolean(task?.archived_at) && children.length > 0
}

export function isHistoricalRoot(task, index) {
  return task.parent_id === null && Boolean(task.archived_at)
}

function branchHas(task, index, predicate) {
  return predicate(task)
    || (index.childrenByParent.get(task.id) ?? []).some((child) => branchHas(child, index, predicate))
}

function branchHasCurrent(task, index) {
  if (task.archived_at) return false
  const children = index.childrenByParent.get(task.id) ?? []
  return task.entity_type === 'project' && children.length > 0
    ? children.some((child) => branchHasCurrent(child, index))
    : true
}

export function tabCount(key, tasks, index = createTaskIndex(tasks)) {
  const roots = tasks.filter(({ parent_id }) => parent_id === null)
  if (key === 'history') {
    return roots.filter((task) => branchHas(task, index, ({ archived_at: value }) => Boolean(value))).length
  }
  const current = roots.filter((task) => branchHasCurrent(task, index))
  return key === 'all'
    ? current.length
    : current.filter((task) => (task.rollup_state ?? task.status) === key).length
}

export function endOf(task, now = new Date()) {
  if (task.end) return new Date(task.end)
  if ((task.rollup_state ?? task.status) === 'done') return new Date(task.last_activity ?? task.start)
  const activity = new Date(task.last_activity ?? task.start)
  return new Date(Math.max(now.getTime(), activity.getTime() + 20 * 60_000))
}

export function timelineBounds(tasks, now = new Date()) {
  const dates = tasks
    .flatMap((task) => [
      new Date(task.start),
      endOf(task, now),
      new Date(task.base_start),
      new Date(task.base_end),
      ...(Array.isArray(task.segments)
        ? task.segments.flatMap((segment) => [new Date(segment.start), new Date(segment.end)])
        : []),
    ])
    .filter((date) => !Number.isNaN(date.valueOf()))
  const minimum = dates.length ? new Date(Math.min(...dates)) : new Date(now)
  const maximum = dates.length ? new Date(Math.max(...dates)) : new Date(now)
  minimum.setHours(0, 0, 0, 0)
  maximum.setDate(maximum.getDate() + 1)
  maximum.setHours(0, 0, 0, 0)
  return { minimum, maximum }
}

export function progressOf(task, index) {
  if (task?.progress && Number.isFinite(task.progress.ratio)) {
    return Math.min(1, Math.max(0, task.progress.ratio))
  }
  const children = index.childrenByParent.get(task.id) ?? []
  if (children.length > 0) {
    const included = children.filter(({ status, deleted_at: deletedAt }) => (
      status !== 'canceled' && !deletedAt
    ))
    if (included.length === 0) return 0
    return Math.min(1, Math.max(0, included.filter(({ status }) => status === 'done').length / included.length))
  }
  return ({ done: 1, canceled: 1, planned: 0, blocked: 0.18, waiting: 0.28, active: 0.55 })[task.status] ?? 0
}

export function progressPresentation(task, statusLabel) {
  const state = task?.rollup_state ?? task?.status ?? 'planned'
  const progress = task?.progress
  if (!progress || !Number.isInteger(progress.total) || progress.total < 1) {
    return {
      indicator: 'ring',
      kind: 'status',
      state,
      ratio: ({ done: 1, canceled: 1, active: 0.65, waiting: 0.5, blocked: 0.25 })[state] ?? 0,
      text: statusLabel,
      ariaLabel: `${task.title}：${statusLabel}`,
    }
  }
  const completed = Math.min(progress.total, Math.max(0, Number(progress.completed) || 0))
  const ratio = completed / progress.total
  const percentage = Math.round(ratio * 100)
  const text = `${completed}/${progress.total}`
  return {
    indicator: 'bar',
    kind: 'progress',
    state: completed >= progress.total ? 'done' : state,
    ratio,
    text,
    ariaLabel: `${task.title}：已完成 ${text}，${percentage}%`,
  }
}

function exactActivityTime(value, timeZone) {
  const options = {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    ...(timeZone ? { timeZone } : {}),
  }
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', options).formatToParts(value)
      .filter(({ type }) => type !== 'literal')
      .map(({ type, value: part }) => [type, part]),
  )
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`
}

export function relativeActivity(task, now = new Date(), { timeZone } = {}) {
  if (!task.last_activity || Number.isNaN(Date.parse(task.last_activity))) {
    return { text: '—', title: null, tone: 'default', minutes: null }
  }
  const activity = new Date(task.last_activity)
  const title = exactActivityTime(activity, timeZone)
  const minutes = Math.max(0, Math.round((now - new Date(task.last_activity)) / 60_000))
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(minutes / (24 * 60))
  const text = minutes < 1 ? 'now'
    : minutes < 60 ? `${minutes}m ago`
      : hours < 24 ? `${hours}h ago`
        : days < 7 ? `${days}d ago`
          : title
  const tone = days >= 7 ? 'dead' : days >= 1 ? 'stale' : 'default'
  return { text, title, tone, minutes }
}

export function canArchiveTask(task) {
  if (!task || task.archived_at) return false
  return ['done', 'canceled'].includes(task.rollup_state ?? task.status)
}

export function estimatedTimelineLabelWidth(text) {
  const width = Array.from(String(text)).reduce(
    (total, character) => total + (/[^\x00-\xff]/.test(character) ? 11 : 6.4),
    0,
  )
  return Math.min(220, Math.max(80, Math.ceil(width + 18)))
}

export function labelPlacement({ text, barLeft, barWidth, scrollLeft, clientWidth }) {
  const labelWidth = estimatedTimelineLabelWidth(text)
  const viewportStart = scrollLeft
  const viewportEnd = scrollLeft + clientWidth
  const visibleStart = Math.max(barLeft, viewportStart)
  const visibleEnd = Math.min(barLeft + barWidth, viewportEnd)
  if (Math.max(0, visibleEnd - visibleStart) >= labelWidth) return 'inside'
  return barLeft + barWidth + labelWidth + 12 > scrollLeft + clientWidth ? 'left' : 'right'
}

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character])
}

export async function copyTextToClipboard(value, clipboard = globalThis.navigator?.clipboard) {
  if (typeof value !== 'string' || value === '' || typeof clipboard?.writeText !== 'function') {
    return false
  }
  try {
    await clipboard.writeText(value)
    return true
  } catch {
    return false
  }
}

export function sessionIdPresentation(value) {
  if (typeof value !== 'string' || value === '') {
    return { display: '—', full: null, empty: true }
  }
  const display = value.length > 16 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value
  return { display, full: value, empty: false }
}

export function formatHomePath(value, homeDirectory) {
  if (typeof value !== 'string' || value === '') return '—'
  if (typeof homeDirectory !== 'string' || homeDirectory === '') return value
  const home = homeDirectory.replace(/\/+$/, '')
  if (value === home) return '~'
  return value.startsWith(`${home}/`) ? `~${value.slice(home.length)}` : value
}

export function contextPathPresentation(value, homeDirectory) {
  if (typeof value !== 'string' || value === '') {
    return { display: '—', full: null, empty: true }
  }
  return {
    display: formatHomePath(value, homeDirectory),
    full: value,
    empty: false,
  }
}

export function gridPanelWidthBounds(containerWidth) {
  const width = Math.max(0, Number(containerWidth) || 0)
  return {
    minimum: GRID_MIN_WIDTH,
    maximum: Math.max(GRID_MIN_WIDTH, width - TIMELINE_SPLITTER_WIDTH - TIMELINE_MIN_WIDTH),
  }
}

export function effectiveGridPanelWidth({ containerWidth, preferredWidth = null }) {
  const bounds = gridPanelWidthBounds(containerWidth)
  const fallback = Math.round((Number(containerWidth) || 0) * 0.55)
  const requested = Number.isFinite(preferredWidth) ? preferredWidth : fallback
  return Math.round(clamp(requested, bounds.minimum, bounds.maximum))
}

export function nextGridPanelWidth({ key, currentWidth, minimum, maximum, step = 16 }) {
  const candidates = {
    ArrowLeft: currentWidth - step,
    ArrowRight: currentWidth + step,
    Home: minimum,
    End: maximum,
  }
  return key in candidates ? Math.round(clamp(candidates[key], minimum, maximum)) : null
}

export function contextPopoverPosition({ anchor, popover, viewport }) {
  const gap = 6
  const edge = 8
  const left = Math.min(
    Math.max(edge, anchor.left),
    Math.max(edge, viewport.width - popover.width - edge),
  )
  const below = anchor.bottom + gap
  const top = below + popover.height <= viewport.height - edge
    ? below
    : Math.max(edge, anchor.top - popover.height - gap)
  return { left, top }
}

export function statusMutationMessage(error) {
  switch (error?.code) {
    case 'TASK_VERSION_CONFLICT':
      return '任务已被其他 Agent 或页面更新，已刷新最新状态'
    case 'CHILD_TASKS_INCOMPLETE': {
      const ids = Array.isArray(error.details?.child_ids) ? error.details.child_ids : []
      return ids.length > 0 ? `请先完成子任务：${ids.join('、')}` : '请先完成所有子任务'
    }
    case 'TASK_NOT_FOUND':
      return '任务已不存在，已刷新列表'
    case 'HOST_REJECTED':
    case 'ORIGIN_REJECTED':
      return '状态修改被本机安全策略拒绝'
    case 'TASK_STATUS_INVALID':
      return '状态请求无效'
    case 'TASK_ARCHIVE_STATUS_INVALID':
      return '只有已完成、已取消或全部子任务完成的任务组可以归档'
    default:
      return '状态修改失败，仍显示最后一次成功数据'
  }
}

export function readBooleanPreference(storage, key, fallback = false) {
  try {
    const value = storage?.getItem(key)
    return value === null || value === undefined ? fallback : value === 'true'
  } catch {
    return fallback
  }
}

export function writeBooleanPreference(storage, key, value) {
  try {
    storage?.setItem(key, String(Boolean(value)))
    return true
  } catch {
    return false
  }
}

export function readChoicePreference(storage, key, choices, fallback) {
  try {
    const value = storage?.getItem(key)
    return Array.isArray(choices) && choices.includes(value) ? value : fallback
  } catch {
    return fallback
  }
}

export function writeChoicePreference(storage, key, value, choices) {
  if (!Array.isArray(choices) || !choices.includes(value)) return false
  try {
    storage?.setItem(key, value)
    return Boolean(storage)
  } catch {
    return false
  }
}

export function readNumberPreference(storage, key, fallback = null) {
  try {
    const value = Number(storage?.getItem(key))
    return Number.isFinite(value) && value >= 1 && value <= 10_000 ? value : fallback
  } catch {
    return fallback
  }
}

export function writeNumberPreference(storage, key, value) {
  if (!Number.isFinite(value) || value < 1 || value > 10_000) return false
  try {
    storage?.setItem(key, String(Math.round(value)))
    return Boolean(storage)
  } catch {
    return false
  }
}

export function resolvePreferenceStorage(globalObject = globalThis) {
  try {
    return globalObject.localStorage ?? null
  } catch {
    return null
  }
}
