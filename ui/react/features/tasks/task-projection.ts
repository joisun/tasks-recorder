import type { DashboardSnapshot, TaskLifecycle, TaskRecord, TaskStatus, TimeRange } from '@/lib/api/types'
import type {
  TaskGanttModel,
  TaskGanttRow,
  TaskProjectionOptions,
  TimelineDomain,
  TimelineScale,
  TimelineZoom,
} from './task-types'

const DAY_MS = 24 * 60 * 60_000

function validRange(value: TimeRange | null | undefined): TimeRange | null {
  if (!value) return null
  const start = Date.parse(value.start)
  const end = Date.parse(value.end)
  return Number.isFinite(start) && Number.isFinite(end) && end >= start
    ? { start: new Date(start).toISOString(), end: new Date(end).toISOString() }
    : null
}

function envelope(ranges: Array<TimeRange | null>): TimeRange | null {
  const valid = ranges.filter((range): range is TimeRange => range !== null)
  if (valid.length === 0) return null
  return {
    start: new Date(Math.min(...valid.map(({ start }) => Date.parse(start)))).toISOString(),
    end: new Date(Math.max(...valid.map(({ end }) => Date.parse(end)))).toISOString(),
  }
}

function lifecycleStatus(value: TaskLifecycle | TaskStatus): TaskStatus {
  return value === 'in_progress' ? 'active' : value
}

function instant(value: string | null | undefined) {
  const timestamp = value ? Date.parse(value) : Number.NaN
  return Number.isFinite(timestamp) ? timestamp : 0
}

function formatters() {
  const month = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'short' })
  const day = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' })
  const year = new Intl.DateTimeFormat('zh-CN', { year: 'numeric' })
  return { month, day, year }
}

function scalePreset(id: Exclude<TimelineZoom, 'auto'>, viewportWidth: number, spanDays: number) {
  const { month, day, year } = formatters()
  const fitWidth = Math.max(2, Math.min(44, Math.floor(Math.max(320, viewportWidth) / Math.max(1, spanDays))))
  if (id === 'hour') {
    return {
      lengthUnit: 'hour' as const,
      cellWidth: Math.max(12, Math.min(20, Math.floor(fitWidth / 2))),
      scales: [
        { unit: 'day' as const, step: 1, format: (date: Date) => day.format(date) },
        { unit: 'hour' as const, step: 6, format: (date: Date) => `${String(date.getHours()).padStart(2, '0')}:00` },
      ],
    }
  }
  if (id === 'day') {
    return {
      lengthUnit: 'day' as const,
      cellWidth: Math.max(28, fitWidth),
      scales: [
        { unit: 'month' as const, step: 1, format: (date: Date) => month.format(date) },
        { unit: 'day' as const, step: 1, format: (date: Date) => day.format(date) },
      ],
    }
  }
  if (id === 'week') {
    return {
      lengthUnit: 'day' as const,
      cellWidth: Math.max(6, Math.min(12, fitWidth)),
      scales: [
        { unit: 'month' as const, step: 1, format: (date: Date) => month.format(date) },
        { unit: 'week' as const, step: 1, format: (date: Date) => day.format(date) },
      ],
    }
  }
  return {
    lengthUnit: 'day' as const,
    cellWidth: Math.max(2, Math.min(4, fitWidth)),
    scales: [
      { unit: 'year' as const, step: 1, format: (date: Date) => year.format(date) },
      { unit: 'quarter' as const, step: 1, format: (date: Date) => `Q${Math.floor(date.getMonth() / 3) + 1}` },
    ],
  }
}

export function chooseTimelineScale(
  domain: TimelineDomain,
  viewportWidth: number,
  requestedZoom: TimelineZoom = 'auto',
): TimelineScale {
  const sourceStart = domain.minimum.getTime()
  const sourceEnd = Math.max(sourceStart + 60 * 60_000, domain.maximum.getTime())
  const sourceSpan = sourceEnd - sourceStart
  const spanDays = sourceSpan / DAY_MS
  const pixelsPerDay = Math.max(320, viewportWidth) / Math.max(1, spanDays)
  const automatic = spanDays <= 2 && pixelsPerDay >= 120
    ? 'hour'
    : spanDays <= 31 && pixelsPerDay >= 28
      ? 'day'
      : spanDays <= 150
        ? 'week'
        : 'month'
  const id = requestedZoom === 'auto' ? automatic : requestedZoom
  const padding = Math.max(DAY_MS * 0.5, sourceSpan * 0.08)
  return {
    id,
    start: new Date(sourceStart - padding),
    end: new Date(sourceEnd + padding),
    ...scalePreset(id, viewportWidth, spanDays),
  }
}

export function projectTaskSnapshot(
  snapshot: DashboardSnapshot,
  {
    viewportWidth,
    openIds = null,
    zoom = 'auto',
    includeArchived = false,
    now = new Date(),
  }: TaskProjectionOptions,
): TaskGanttModel {
  const allById = new Map(snapshot.tasks.map((task) => [task.id, task]))

  function visible(task: TaskRecord, visiting = new Set<string>()): boolean {
    if (!includeArchived && task.archived_at) return false
    if (!task.parent_id || visiting.has(task.id)) return true
    const parent = allById.get(task.parent_id)
    return !parent || visible(parent, new Set(visiting).add(task.id))
  }

  const tasks = snapshot.tasks.filter((task) => visible(task))
  const byId = new Map(tasks.map((task) => [task.id, task]))
  const childrenByParent = new Map<string | null, TaskRecord[]>()
  for (const task of tasks) {
    const parent = task.parent_id && byId.has(task.parent_id) ? task.parent_id : null
    const children = childrenByParent.get(parent) ?? []
    children.push(task)
    childrenByParent.set(parent, children)
  }

  const activityMemo = new Map<string, number>()
  function subtreeActivity(task: TaskRecord, visiting = new Set<string>()): number {
    if (activityMemo.has(task.id)) return activityMemo.get(task.id) ?? 0
    if (visiting.has(task.id)) return instant(task.last_activity ?? task.updated_at)
    const next = new Set(visiting).add(task.id)
    const value = Math.max(
      instant(task.last_activity ?? task.updated_at),
      ...(childrenByParent.get(task.id) ?? []).map((child) => subtreeActivity(child, next)),
    )
    activityMemo.set(task.id, value)
    return value
  }

  const scopeMemo = new Map<string, TimeRange>()
  const actualMemo = new Map<string, TimeRange | null>()
  const plannedMemo = new Map<string, TimeRange | null>()

  function fieldEnvelope(task: TaskRecord, field: 'actual' | 'planned', visiting = new Set<string>()): TimeRange | null {
    const memo = field === 'actual' ? actualMemo : plannedMemo
    if (memo.has(task.id)) return memo.get(task.id) ?? null
    if (visiting.has(task.id)) return validRange(task[field])
    const next = new Set(visiting).add(task.id)
    const result = envelope([
      validRange(task[field]),
      ...(childrenByParent.get(task.id) ?? []).map((child) => fieldEnvelope(child, field, next)),
    ])
    memo.set(task.id, result)
    return result
  }

  function scope(task: TaskRecord, visiting = new Set<string>()): TimeRange {
    if (scopeMemo.has(task.id)) return scopeMemo.get(task.id) as TimeRange
    const own = envelope([
      validRange(task.actual),
      validRange(task.planned),
      task.start && task.end ? validRange({ start: task.start, end: task.end }) : null,
    ])
    const next = new Set(visiting).add(task.id)
    const childScopes = visiting.has(task.id)
      ? []
      : (childrenByParent.get(task.id) ?? []).map((child) => scope(child, next))
    const fallbackStart = task.last_activity ?? task.updated_at ?? snapshot.generated_at ?? now.toISOString()
    const fallbackTimestamp = instant(fallbackStart) || now.getTime()
    const result = envelope([own, ...childScopes]) ?? {
      start: new Date(fallbackTimestamp).toISOString(),
      end: new Date(fallbackTimestamp + 60 * 60_000).toISOString(),
    }
    scopeMemo.set(task.id, result)
    return result
  }

  const compare = (left: TaskRecord, right: TaskRecord) => (
    subtreeActivity(right) - subtreeActivity(left)
    || left.sort_order - right.sort_order
    || left.id.localeCompare(right.id)
  )
  const ordered: TaskRecord[] = []
  function append(parentId: string | null) {
    for (const task of [...(childrenByParent.get(parentId) ?? [])].sort(compare)) {
      ordered.push(task)
      append(task.id)
    }
  }
  append(null)

  const rows: TaskGanttRow[] = ordered.map((task) => {
    const children = childrenByParent.get(task.id) ?? []
    const hasChildren = children.length > 0
    const isGroup = children.length > 0 || task.entity_type === 'project'
    const primary = scope(task)
    const actual = fieldEnvelope(task, 'actual')
    const planned = fieldEnvelope(task, 'planned')
    const status = lifecycleStatus(isGroup
      ? (task.rollup_state ?? task.lifecycle ?? task.status)
      : task.status)
    const progressRatio = task.progress?.ratio ?? (status === 'done' ? 1 : 0)
    const actualSegments = !isGroup
      ? task.actual_segments.map(validRange).filter((range): range is TimeRange => range !== null)
      : []
    const workspace = task.workspace ?? task.workfolder ?? task.worktree ?? null
    return {
      id: task.id,
      parent: task.parent_id && byId.has(task.parent_id) ? task.parent_id : 0,
      text: task.title,
      start: new Date(primary.start),
      end: new Date(primary.end),
      ...(planned ? { base_start: new Date(planned.start), base_end: new Date(planned.end) } : {}),
      ...(actualSegments.length > 1 ? {
        segments: actualSegments.map((segment) => ({
          start: new Date(segment.start), end: new Date(segment.end),
        })),
      } : {}),
      progress: Math.round(Math.max(0, Math.min(1, progressRatio)) * 100),
      type: isGroup ? 'summary' : 'task',
      open: hasChildren && (openIds === null || openIds.has(task.id)),
      status,
      source: task,
      entity_type: task.entity_type,
      status_indicator: isGroup ? 'bar' : task.entity_type === 'subtask' ? 'dot' : 'ring',
      planned_pattern: status === 'planned' && actual === null ? 'dash-dot' : null,
      progress_count: isGroup && task.progress
        ? `${task.progress.completed}/${task.progress.total}`
        : null,
      workspace,
      branch: task.branch,
      session_id: task.session_id,
      last_activity: task.last_activity,
    }
  })

  const timestamps = rows.flatMap(({ start, end }) => [start.getTime(), end.getTime()])
  const fallback = now.getTime()
  const domain = {
    minimum: new Date(timestamps.length > 0 ? Math.min(...timestamps) : fallback - 7 * DAY_MS),
    maximum: new Date(timestamps.length > 0 ? Math.max(...timestamps) : fallback + 7 * DAY_MS),
  }
  return {
    rows,
    rowIds: rows.map(({ id }) => id),
    links: [],
    domain,
    scale: chooseTimelineScale(domain, viewportWidth, zoom),
    empty: rows.length === 0,
  }
}
