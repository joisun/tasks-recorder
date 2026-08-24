import {
  contextPathPresentation,
  createTaskIndex,
  endOf,
  progressOf,
  relativeActivity,
} from './dashboard-state.mjs'

export const SVAR_ROW_HEIGHT = 30
export const SVAR_SCALE_HEIGHT = 24

export const SVAR_TIMELINE_ZOOMS = Object.freeze(['auto', 'day', 'week', 'month'])

export const SVAR_GRID_COLUMNS = Object.freeze([
  { id: 'text', header: '任务', width: 200, resize: true },
  { id: 'activity', header: '最近活跃', width: 100, align: 'right', resize: true },
  { id: 'status', header: '状态 / 进度', width: 100, align: 'center', resize: true },
  { id: 'workspace', header: 'Workspace', width: 105, resize: true },
  { id: 'branch', header: 'Branch', width: 75, resize: true },
  { id: 'session_id', header: 'Session ID', width: 116, flexgrow: 1, resize: false },
])

export function filterSvarTasks(tasks, filter = 'all') {
  const index = createTaskIndex(tasks)
  const roots = tasks.filter(({ parent_id: parentId }) => parentId === null)

  function currentBranch(task, ancestorArchived = false) {
    const archived = ancestorArchived || Boolean(task.archived_at)
    if (archived) return []
    const children = index.childrenByParent.get(task.id) ?? []
    const descendants = children.flatMap((child) => currentBranch(child, archived))
    if (task.entity_type === 'project' && children.length > 0 && descendants.length === 0) return []
    return [task, ...descendants]
  }

  if (filter !== 'history') {
    return roots.flatMap((root) => {
      if (filter !== 'all' && (root.rollup_state ?? root.status) !== filter) return []
      return currentBranch(root)
    })
  }

  const selected = new Set()
  const context = new Set()
  function addDescendants(task) {
    for (const child of index.childrenByParent.get(task.id) ?? []) {
      selected.add(child.id)
      addDescendants(child)
    }
  }
  function addAncestors(task) {
    let current = task
    const visited = new Set()
    while (current?.parent_id && !visited.has(current.id)) {
      visited.add(current.id)
      current = index.byId.get(current.parent_id)
      if (current) {
        selected.add(current.id)
        context.add(current.id)
      }
    }
  }
  for (const task of tasks.filter(({ archived_at: archivedAt }) => Boolean(archivedAt))) {
    selected.add(task.id)
    addAncestors(task)
    if (task.entity_type !== 'subtask') addDescendants(task)
  }
  function historyBranch(task) {
    if (!selected.has(task.id)) return []
    return [
      { ...task, history_context: context.has(task.id) && !task.archived_at },
      ...(index.childrenByParent.get(task.id) ?? []).flatMap(historyBranch),
    ]
  }
  return roots.flatMap(historyBranch)
}

export function createSvarTaskProjection(tasks, {
  filter = 'all',
  openIds = null,
  now = new Date(),
  homeDirectory = '',
  timeZone,
} = {}) {
  const index = createTaskIndex(tasks)
  const filtered = filterSvarTasks(tasks, filter)
  const retainedIds = new Set(filtered.map(({ id }) => id))
  const scopeMemo = new Map()
  const canonicalScopeMemo = {
    actual: new Map(),
    planned: new Map(),
  }

  function validRange(range) {
    if (!range) return null
    const start = new Date(range.start)
    const end = new Date(range.end)
    return Number.isNaN(start.valueOf()) || Number.isNaN(end.valueOf()) || end < start
      ? null
      : { start, end }
  }

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

  function envelope(ranges) {
    const valid = ranges.filter(Boolean)
    if (valid.length === 0) return null
    return {
      start: new Date(Math.min(...valid.map(({ start }) => start.valueOf()))),
      end: new Date(Math.max(...valid.map(({ end }) => end.valueOf()))),
    }
  }

  function canonicalScope(task, field, visiting = new Set()) {
    const memo = canonicalScopeMemo[field]
    if (memo.has(task.id)) return memo.get(task.id)
    if (visiting.has(task.id)) return validRange(task[field])
    const nextVisiting = new Set(visiting).add(task.id)
    const scope = envelope([
      validRange(task[field]),
      ...(index.childrenByParent.get(task.id) ?? [])
        .map((child) => canonicalScope(child, field, nextVisiting)),
    ])
    memo.set(task.id, scope)
    return scope
  }

  return filtered.map((task) => {
    const children = (index.childrenByParent.get(task.id) ?? [])
      .filter(({ id }) => retainedIds.has(id))
    const workspaceValue = task.workfolder ?? task.worktree ?? null
    const workspace = contextPathPresentation(workspaceValue, homeDirectory)
    const scope = timeScope(task)
    const actual = children.length > 0
      ? canonicalScope(task, 'actual')
      : validRange(task.actual)
    const planned = children.length > 0
      ? canonicalScope(task, 'planned')
      : validRange(task.planned)
    const primary = children.length > 0
      ? envelope([scope, actual, planned])
      : actual ?? planned ?? scope
    const actualSegments = actual && !children.length
      ? (Array.isArray(task.actual_segments) ? task.actual_segments : [])
        .map(validRange)
        .filter(Boolean)
      : []
    const visualMode = actual && planned
      ? 'actual_with_plan'
      : actual ? 'actual_only' : planned ? 'planned_only' : 'legacy'

    return {
      id: task.id,
      parent: task.parent_id || 0,
      text: task.title,
      start: primary?.start ?? new Date(task.start),
      end: primary?.end ?? endOf(task, now),
      ...(actual && planned ? { base_start: planned.start, base_end: planned.end } : {}),
      ...(actualSegments.length > 1 ? { segments: actualSegments } : {}),
      progress: Math.round(progressOf(task, index) * 100),
      type: children.length > 0 ? 'summary' : 'task',
      open: children.length > 0 && (openIds === null ? true : openIds.has(String(task.id))),
      status: task.rollup_state ?? task.status,
      entity_type: task.entity_type ?? 'task',
      visual_mode: visualMode,
      actual_segment_count: Number.isInteger(task.actual_segment_count)
        ? task.actual_segment_count
        : actualSegments.length,
      live_state: task.live_state ?? 'none',
      running_execution_count: Number.isInteger(task.running_execution_count)
        ? task.running_execution_count
        : 0,
      idle_execution_count: Number.isInteger(task.idle_execution_count)
        ? task.idle_execution_count
        : 0,
      stale_execution_count: Number.isInteger(task.stale_execution_count)
        ? task.stale_execution_count
        : 0,
      blocked_count: Number.isInteger(task.blocked_count) ? task.blocked_count : 0,
      archived: Boolean(task.archived_at),
      historical: filter === 'history',
      history_context: Boolean(task.history_context),
      session_id: task.session_id ?? null,
      session_source: task.session_source ?? null,
      resume_available: task.entity_type !== 'project'
        && task.resume_available === true
        && typeof task.session_id === 'string'
        && typeof workspaceValue === 'string',
      workspace: workspaceValue,
      workspace_display: workspace.display,
      branch: task.branch ?? null,
      note: task.next_action ?? '',
      agent: task.agent ?? 'Unknown',
      active_agent_count: Number.isInteger(task.active_agent_count) ? task.active_agent_count : 0,
      execution_count: Number.isInteger(task.execution_count) ? task.execution_count : 0,
      activity: relativeActivity(task, now, { timeZone }),
      last_activity: task.last_activity ?? null,
      updated_at: task.updated_at ?? null,
      source: task,
    }
  })
}

export function normalizeTimelineZoom(value) {
  return SVAR_TIMELINE_ZOOMS.includes(value) ? value : 'auto'
}

export function createSvarScales({ minimum, maximum }, requestedZoom = 'auto') {
  const zoom = normalizeTimelineZoom(requestedZoom)
  const month = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'short' })
  const day = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' })
  const year = new Intl.DateTimeFormat('zh-CN', { year: 'numeric' })
  const manualPresets = {
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
  const sourceStart = new Date(minimum)
  const sourceEnd = new Date(maximum)
  const sourceSpan = Math.max(0, sourceEnd.valueOf() - sourceStart.valueOf())
  const dayMs = 24 * 60 * 60_000
  const autoZoom = sourceSpan <= 2 * dayMs
    ? 'hour'
    : sourceSpan <= 21 * dayMs ? 'day' : sourceSpan <= 120 * dayMs ? 'week' : 'month'
  const autoPresets = {
    hour: {
      lengthUnit: 'hour', cellWidth: 18,
      scales: [
        { unit: 'day', step: 1, format: (date) => day.format(date) },
        { unit: 'hour', step: 6, format: (date) => `${String(date.getHours()).padStart(2, '0')}:00` },
      ],
    },
    day: {
      lengthUnit: 'day', cellWidth: 44,
      scales: [
        { unit: 'month', step: 1, format: (date) => month.format(date) },
        { unit: 'day', step: 1, format: (date) => day.format(date) },
      ],
    },
    week: {
      lengthUnit: 'day', cellWidth: 8,
      scales: [
        { unit: 'month', step: 1, format: (date) => month.format(date) },
        { unit: 'week', step: 1, format: (date) => day.format(date) },
      ],
    },
    month: {
      lengthUnit: 'day', cellWidth: 2,
      scales: [
        { unit: 'year', step: 1, format: (date) => year.format(date) },
        { unit: 'quarter', step: 1, format: (date) => `Q${Math.floor(date.getMonth() / 3) + 1}` },
      ],
    },
  }
  const resolvedZoom = zoom === 'auto' ? autoZoom : zoom
  const preset = zoom === 'auto' ? autoPresets[autoZoom] : manualPresets[zoom]
  const padding = zoom === 'auto'
    ? Math.max(sourceSpan, dayMs) * 0.1
    : Math.max(0, preset.minimumSpan - sourceSpan) / 2
  return {
    start: new Date(sourceStart.valueOf() - padding),
    end: new Date(sourceEnd.valueOf() + padding),
    resolvedZoom,
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
