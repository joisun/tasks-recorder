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

export function createGanttLayout({ showTimeline, gridWidth }) {
  const grid = {
    ...(showTimeline ? { width: gridWidth } : {}),
    rows: [
      {
        view: 'grid',
        id: 'grid',
        scrollable: true,
        scrollX: 'gridScroll',
        scrollY: 'sharedScroll',
      },
      { view: 'scrollbar', id: 'gridScroll', scroll: 'x', group: 'horizontal' },
    ],
  }
  const vertical = { view: 'scrollbar', id: 'sharedScroll', scroll: 'y' }
  if (!showTimeline) return { css: 'gantt_container', cols: [grid, vertical] }
  return {
    css: 'gantt_container',
    cols: [
      grid,
      {
        html: '<div class="timeline-splitter" role="separator" aria-label="调整 Grid 与 Timeline 宽度" aria-orientation="vertical" tabindex="0"></div>',
        css: 'timeline-splitter-cell',
        width: TIMELINE_SPLITTER_WIDTH,
      },
      {
        rows: [
          {
            view: 'timeline',
            id: 'timeline',
            scrollX: 'timelineScroll',
            scrollY: 'sharedScroll',
          },
          { view: 'scrollbar', id: 'timelineScroll', scroll: 'x', group: 'horizontal' },
        ],
      },
      vertical,
    ],
  }
}

export function isTaskOpen(task) {
  if (typeof task?.$open === 'boolean') return task.$open
  if (typeof task?.open === 'boolean') return task.open
  return true
}

export function retainedGridScroll({
  timelineVisible,
  gridX,
  gridScrollable,
  gridScrollRange = 0,
  rememberedGridX,
}) {
  if (timelineVisible || (gridScrollable && gridScrollRange > 16)) return gridX
  return rememberedGridX
}

function leavesOf(task, index) {
  const children = index.childrenByParent.get(task.id) ?? []
  return children.length === 0 ? [task] : children.flatMap((child) => leavesOf(child, index))
}

export function isArchivedGroup(task, index) {
  const children = index.childrenByParent.get(task.id) ?? []
  return task.parent_id === null
    && children.length > 0
    && leavesOf(task, index).every(({ status }) => status === 'done')
}

export function isHistoricalRoot(task, index) {
  return task.parent_id === null
    && (task.status === 'done' || isArchivedGroup(task, index))
}

export function tabCount(key, tasks, index = createTaskIndex(tasks)) {
  const roots = tasks.filter(({ parent_id }) => parent_id === null)
  if (key === 'history') return roots.filter((task) => isHistoricalRoot(task, index)).length
  const current = roots.filter((task) => !isHistoricalRoot(task, index))
  return key === 'all' ? current.length : current.filter(({ status }) => status === key).length
}

export function endOf(task, now = new Date()) {
  if (task.end) return new Date(task.end)
  if (task.status === 'done') return new Date(task.last_activity ?? task.start)
  const activity = new Date(task.last_activity ?? task.start)
  return new Date(Math.max(now.getTime(), activity.getTime() + 20 * 60_000))
}

export function timelineBounds(tasks, now = new Date()) {
  const dates = tasks
    .flatMap((task) => [new Date(task.start), endOf(task, now)])
    .filter((date) => !Number.isNaN(date.valueOf()))
  const minimum = dates.length ? new Date(Math.min(...dates)) : new Date(now)
  const maximum = dates.length ? new Date(Math.max(...dates)) : new Date(now)
  minimum.setHours(0, 0, 0, 0)
  maximum.setDate(maximum.getDate() + 1)
  maximum.setHours(0, 0, 0, 0)
  return { minimum, maximum }
}

export function progressOf(task, index) {
  const children = index.childrenByParent.get(task.id) ?? []
  if (children.length > 0) {
    return Math.min(1, Math.max(0, children.filter(({ status }) => status === 'done').length / children.length))
  }
  return ({ done: 1, planned: 0, blocked: 0.18, waiting: 0.28, active: 0.55 })[task.status] ?? 0
}

export function relativeActivity(task, now = new Date()) {
  if (task.status === 'done') return { text: '完成', tone: 'default', minutes: null }
  if (!task.last_activity) return { text: '—', tone: 'default', minutes: null }
  const minutes = Math.max(0, Math.round((now - new Date(task.last_activity)) / 60_000))
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  const text = minutes < 60 ? `${minutes}m` : `${hours}h${rest ? `${rest}m` : ''}`
  const tone = minutes >= 60 ? 'dead' : minutes >= 30 ? 'stale' : 'default'
  return { text, tone, minutes }
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
  if (barWidth >= labelWidth) return 'inside'
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
  return { display: value, full: value, empty: false }
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

export function gridPanelWidthFor(containerWidth, columnWidth) {
  const width = Number(containerWidth) || 0
  const contentWidth = Number(columnWidth) || 0
  if (width <= 720) return Math.min(contentWidth || 240, 240)
  const preferred = Math.max(Math.round(width * 0.72), width - 346)
  return Math.min(contentWidth || preferred, Math.max(240, preferred))
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
  const fallback = Math.round((Number(containerWidth) || 0) * 0.65)
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

export function responsiveGridWidth({ timelineVisible, currentWidth, containerWidth, columnWidth }) {
  if (!timelineVisible) return null
  const next = gridPanelWidthFor(containerWidth, columnWidth)
  return Math.abs((Number(currentWidth) || 0) - next) > 2 ? next : null
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
