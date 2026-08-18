import {
  contextPathPresentation,
  createTaskIndex,
  endOf,
  isHistoricalRoot,
  progressOf,
  relativeActivity,
} from './dashboard-state.mjs'

export const SVAR_ROW_HEIGHT = 30
export const SVAR_SCALE_HEIGHT = 24

export const SVAR_TIMELINE_ZOOMS = Object.freeze(['day', 'week', 'month'])

export const SVAR_GRID_COLUMNS = Object.freeze([
  { id: 'text', header: '任务', width: 240, resize: true },
  { id: 'status', header: '状态 / 进度', width: 124, align: 'center' },
  { id: 'execution_context', header: '执行上下文', width: 216 },
  { id: 'session_id', header: 'Session ID', width: 148 },
  { id: 'activity', header: '活动', width: 64, align: 'right' },
])

function rootOf(task, index) {
  let root = task
  const visited = new Set()
  while (root?.parent_id) {
    if (visited.has(root.id)) return null
    visited.add(root.id)
    root = index.byId.get(root.parent_id)
  }
  return root ?? null
}

function matchingRoot(root, filter, index) {
  const historical = isHistoricalRoot(root, index)
  if (filter === 'history') return historical
  if (historical) return false
  return filter === 'all' || root.status === filter
}

export function filterSvarTasks(tasks, filter = 'all') {
  const index = createTaskIndex(tasks)
  const result = []

  function appendBranch(task) {
    result.push(task)
    for (const child of index.childrenByParent.get(task.id) ?? []) appendBranch(child)
  }

  for (const task of tasks) {
    if (task.parent_id !== null) continue
    if (matchingRoot(task, filter, index)) appendBranch(task)
  }
  return result
}

export function createSvarTaskProjection(tasks, {
  filter = 'all',
  openIds = null,
  now = new Date(),
  homeDirectory = '',
} = {}) {
  const index = createTaskIndex(tasks)
  const filtered = filterSvarTasks(tasks, filter)
  const retainedIds = new Set(filtered.map(({ id }) => id))
  const scopeMemo = new Map()

  function timeScope(task, visiting = new Set()) {
    if (scopeMemo.has(task.id)) return scopeMemo.get(task.id)
    const start = new Date(task.start)
    const end = endOf(task, now)
    const starts = Number.isNaN(start.valueOf()) ? [] : [start.valueOf()]
    const ends = Number.isNaN(end.valueOf()) ? [] : [end.valueOf()]
    if (!visiting.has(task.id)) {
      const nextVisiting = new Set(visiting).add(task.id)
      for (const child of index.childrenByParent.get(task.id) ?? []) {
        const childScope = timeScope(child, nextVisiting)
        if (childScope) {
          starts.push(childScope.start.valueOf())
          ends.push(childScope.end.valueOf())
        }
      }
    }
    if (starts.length === 0 || ends.length === 0) return null
    const scope = {
      start: new Date(Math.min(...starts)),
      end: new Date(Math.max(...ends)),
    }
    if (!visiting.has(task.id)) scopeMemo.set(task.id, scope)
    return scope
  }

  return filtered.map((task) => {
    const root = rootOf(task, index) ?? task
    const historical = isHistoricalRoot(root, index)
    const children = (index.childrenByParent.get(task.id) ?? [])
      .filter(({ id }) => retainedIds.has(id))
    const workfolder = contextPathPresentation(task.workfolder, homeDirectory)
    const worktree = contextPathPresentation(task.worktree, homeDirectory)
    const scope = timeScope(task)

    return {
      id: task.id,
      parent: task.parent_id || 0,
      text: task.title,
      start: scope?.start ?? new Date(task.start),
      end: scope?.end ?? endOf(task, now),
      progress: Math.round(progressOf(task, index) * 100),
      type: children.length > 0 ? 'summary' : 'task',
      open: children.length > 0 && (openIds === null ? true : openIds.has(String(task.id))),
      status: historical && task.parent_id === null ? 'done' : task.status,
      archived: historical,
      session_id: task.session_id ?? null,
      workfolder: task.workfolder ?? null,
      workfolder_display: workfolder.display,
      worktree: task.worktree ?? null,
      worktree_display: worktree.display,
      branch: task.branch ?? null,
      note: task.next_action ?? '',
      agent: task.agent ?? 'Unknown',
      active_agent_count: Number.isInteger(task.active_agent_count) ? task.active_agent_count : 0,
      execution_count: Number.isInteger(task.execution_count) ? task.execution_count : 0,
      activity: relativeActivity(task, now),
      last_activity: task.last_activity ?? null,
      updated_at: task.updated_at ?? null,
      source: task,
    }
  })
}

export function normalizeTimelineZoom(value) {
  return SVAR_TIMELINE_ZOOMS.includes(value) ? value : 'week'
}

export function createSvarScales({ minimum, maximum }, requestedZoom = 'week') {
  const zoom = normalizeTimelineZoom(requestedZoom)
  const month = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'short' })
  const day = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' })
  const year = new Intl.DateTimeFormat('zh-CN', { year: 'numeric' })
  const presets = {
    day: {
      minimumSpan: 21 * 24 * 60 * 60_000,
      lengthUnit: 'day',
      cellWidth: 44,
      scales: [
        { unit: 'month', step: 1, format: (date) => month.format(date) },
        { unit: 'day', step: 1, format: (date) => day.format(date) },
      ],
    },
    week: {
      minimumSpan: 56 * 24 * 60 * 60_000,
      lengthUnit: 'day',
      cellWidth: 16,
      scales: [
        { unit: 'month', step: 1, format: (date) => month.format(date) },
        { unit: 'week', step: 1, format: (date) => day.format(date) },
      ],
    },
    month: {
      minimumSpan: 240 * 24 * 60 * 60_000,
      lengthUnit: 'day',
      cellWidth: 4,
      scales: [
        { unit: 'year', step: 1, format: (date) => year.format(date) },
        { unit: 'month', step: 1, format: (date) => month.format(date) },
      ],
    },
  }
  const preset = presets[zoom]
  const sourceStart = new Date(minimum)
  const sourceEnd = new Date(maximum)
  const sourceSpan = Math.max(0, sourceEnd.valueOf() - sourceStart.valueOf())
  const padding = Math.max(0, preset.minimumSpan - sourceSpan) / 2
  return {
    start: new Date(sourceStart.valueOf() - padding),
    end: new Date(sourceEnd.valueOf() + padding),
    lengthUnit: preset.lengthUnit,
    cellWidth: preset.cellWidth,
    scales: preset.scales,
  }
}

function finiteNonNegative(value, fallback = 0) {
  return Number.isFinite(value) && value >= 0 ? value : fallback
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value))
}

export function normalizeRendererState(input = {}, bounds = { minimum: 240, maximum: 1111 }) {
  const minimum = Number.isFinite(bounds.minimum) ? bounds.minimum : 240
  const maximum = Number.isFinite(bounds.maximum) ? Math.max(minimum, bounds.maximum) : 1111
  const requestedGridWidth = Number.isFinite(input.gridWidth) && input.gridWidth > 0
    ? input.gridWidth
    : 792
  const openIds = input.openIds instanceof Set || Array.isArray(input.openIds)
    ? new Set([...input.openIds].map(String))
    : new Set()
  const selectedTaskId = typeof input.selectedTaskId === 'string' && input.selectedTaskId
    ? input.selectedTaskId
    : null
  const requestedTaskWidth = Number.isFinite(input.taskColumnWidth) ? input.taskColumnWidth : 240

  return {
    displayMode: ['all', 'grid'].includes(input.displayMode) ? input.displayMode : 'all',
    gridWidth: Math.round(clamp(requestedGridWidth, minimum, maximum)),
    openIds,
    gridX: finiteNonNegative(input.gridX),
    timelineX: finiteNonNegative(input.timelineX),
    verticalY: finiteNonNegative(input.verticalY),
    selectedTaskId,
    taskColumnWidth: Math.round(clamp(requestedTaskWidth, 180, 520)),
    labelsVisible: Boolean(input.labelsVisible),
    timelineZoom: normalizeTimelineZoom(input.timelineZoom),
  }
}

export function currentTimePosition({
  now,
  timelineStart,
  timelineEnd,
  contentWidth,
  scrollLeft = 0,
  viewportWidth,
}) {
  const start = new Date(timelineStart).getTime()
  const end = new Date(timelineEnd).getTime()
  const current = new Date(now).getTime()
  const width = finiteNonNegative(contentWidth)
  const viewport = finiteNonNegative(viewportWidth)
  if (![start, end, current].every(Number.isFinite) || end <= start || width <= 0 || viewport <= 0) {
    return { visible: false, x: 0, contentX: 0 }
  }

  const ratio = (current - start) / (end - start)
  const contentX = Math.round(clamp(ratio, 0, 1) * width)
  const rawX = contentX - finiteNonNegative(scrollLeft)
  return {
    visible: ratio >= 0 && ratio <= 1 && rawX >= 0 && rawX <= viewport,
    x: Math.round(clamp(rawX, 0, viewport)),
    contentX,
  }
}
