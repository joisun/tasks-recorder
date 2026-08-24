import { homedir } from 'node:os'

import { isValidDateOnly, TASK_STATUSES } from './task-store.mjs'
import { taskProgress } from './task-tree.mjs'

function validInstant(value) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) return null
  return new Date(value).toISOString()
}

function taskStart(task) {
  if (!isValidDateOnly(task.start_date)) return null
  const created = validInstant(task.created_at)
  if (!created) return null
  if (task.start_date === created.slice(0, 10)) return created
  const start = validInstant(`${task.start_date}T00:00:00.000Z`)
  return start
}

function taskEnd(task) {
  if (task.status === 'done' || task.status === 'canceled') {
    return validInstant(task.completed_at ?? task.updated_at)
  }
  if (task.due_date) {
    if (!isValidDateOnly(task.due_date)) return null
    return validInstant(`${task.due_date}T23:59:59.999Z`)
  }
  return null
}

function sessionString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

function count(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0
}

function latestInstant(values) {
  return values
    .map(validInstant)
    .filter(Boolean)
    .sort((left, right) => right.localeCompare(left))[0] ?? null
}

export function createDashboardSnapshot(snapshot, {
  now = new Date(),
  homeDirectory = homedir(),
} = {}) {
  const generatedAt = validInstant(now instanceof Date ? now.toISOString() : now)
  if (!generatedAt) throw new TypeError('now must be a valid date')
  const allTasks = Array.isArray(snapshot?.tasks) ? snapshot.tasks : []
  const sessions = Array.isArray(snapshot?.sessions) ? snapshot.sessions : []
  const allTasksById = new Map(allTasks.map((task) => [task.id, task]))
  function hiddenByDeletion(task, path = new Set()) {
    if (task.deleted_at !== null && task.deleted_at !== undefined) return true
    if (task.parent_id === null || path.has(task.id)) return false
    const parent = allTasksById.get(task.parent_id)
    return parent ? hiddenByDeletion(parent, new Set(path).add(task.id)) : false
  }
  const tasks = allTasks.filter((task) => !hiddenByDeletion(task))
  const sourceById = new Map(tasks.map((task) => [task.id, task]))
  const invalid = new Map()

  for (const task of tasks) {
    if (!TASK_STATUSES.includes(task.status)) invalid.set(task.id, 'TASK_STATUS_INVALID')
    else if (
      !taskStart(task)
      || !validInstant(task.updated_at)
      || (task.due_date !== null && !isValidDateOnly(task.due_date))
      || (taskEnd(task) === null && ['done', 'canceled'].includes(task.status))
    ) {
      invalid.set(task.id, 'TASK_DATE_INVALID')
    } else if (task.parent_id !== null && !sourceById.has(task.parent_id)) {
      invalid.set(task.id, 'TASK_PARENT_MISSING')
    }
  }

  function visit(task, path = new Set()) {
    if (invalid.has(task.id) || task.parent_id === null) return
    if (path.has(task.id)) {
      for (const id of path) invalid.set(id, 'TASK_HIERARCHY_CYCLE')
      invalid.set(task.id, 'TASK_HIERARCHY_CYCLE')
      return
    }
    const nextPath = new Set(path).add(task.id)
    const parent = sourceById.get(task.parent_id)
    if (parent) {
      visit(parent, nextPath)
      if (invalid.has(parent.id) && !invalid.has(task.id)) {
        invalid.set(task.id, 'TASK_ANCESTOR_INVALID')
      }
    }
  }
  for (const task of tasks) visit(task)

  const executionAggregatesByTask = new Map()
  for (const aggregate of Array.isArray(snapshot?.task_execution_aggregates)
    ? snapshot.task_execution_aggregates
    : []) {
    if (!sourceById.has(aggregate?.task_id)) continue
    const recentExecution = aggregate.recent_execution
    const activity = validInstant(recentExecution?.last_seen_at)
    executionAggregatesByTask.set(aggregate.task_id, {
      execution_count: count(aggregate.execution_count),
      active_execution_count: count(aggregate.active_execution_count),
      active_agent_count: count(aggregate.active_agent_count),
      recent_execution: activity ? { ...recentExecution, last_seen_at: activity } : null,
    })
  }

  const sessionsByTask = new Map()
  for (const session of sessions) {
    if (!sourceById.has(session.task_id)) continue
    const activity = validInstant(session.last_seen_at)
    if (!activity) continue
    const items = sessionsByTask.get(session.task_id) ?? []
    items.push({ ...session, last_seen_at: activity })
    sessionsByTask.set(session.task_id, items)
  }

  const outputTasks = tasks
    .filter((task) => !invalid.has(task.id))
    .map((task) => {
      const taskSessions = sessionsByTask.get(task.id) ?? []
      const recent = [...taskSessions]
        .sort((left, right) => right.last_seen_at.localeCompare(left.last_seen_at))[0]
      const recentAgent = [...taskSessions]
        .filter(({ agent }) => typeof agent === 'string' && agent.trim() !== '')
        .sort((left, right) => right.last_seen_at.localeCompare(left.last_seen_at))[0]
      const aggregate = executionAggregatesByTask.get(task.id)
      const recentExecution = aggregate?.recent_execution ?? null
      return {
        id: task.id,
        parent_id: task.parent_id,
        title: task.title,
        description: task.description ?? null,
        status: task.status,
        agent_key: task.agent_key ?? null,
        sort_order: Number.isInteger(task.sort_order) ? task.sort_order : 0,
        revision: Number.isInteger(task.revision) ? task.revision : 1,
        archived_at: validInstant(task.archived_at),
        progress: taskProgress(task, tasks.filter((child) => (
          !invalid.has(child.id) && child.parent_id === task.id
        ))),
        execution_count: aggregate?.execution_count ?? 0,
        active_execution_count: aggregate?.active_execution_count ?? 0,
        active_agent_count: aggregate?.active_agent_count ?? 0,
        agent: sessionString(recentExecution?.agent_type) ?? recentAgent?.agent ?? 'Unknown',
        start: taskStart(task),
        end: taskEnd(task),
        last_activity: recentExecution?.last_seen_at ?? recent?.last_seen_at ?? validInstant(task.updated_at),
        next_action: task.next_action,
        session_id: sessionString(recentExecution?.session_id) ?? sessionString(recent?.session_id),
        workfolder: sessionString(recentExecution?.workfolder) ?? sessionString(recent?.workfolder),
        worktree: sessionString(recentExecution?.worktree) ?? sessionString(recent?.worktree),
        branch: sessionString(recentExecution?.branch) ?? sessionString(recent?.branch),
        updated_at: validInstant(task.updated_at),
      }
    })

  return {
    generated_at: generatedAt,
    home_directory: homeDirectory,
    unassigned_execution_count: count(snapshot?.unassigned_execution_count),
    tasks: outputTasks,
    warnings: [...invalid]
      .map(([task_id, code]) => ({ code, task_id }))
      .sort((left, right) => left.task_id.localeCompare(right.task_id)),
  }
}

const RUNNING_WINDOW_MS = 2 * 60_000
const IDLE_WINDOW_MS = 15 * 60_000

function legacyLifecycle(lifecycle) {
  return lifecycle === 'in_progress' ? 'active' : lifecycle
}

function rangeFrom(items, startOf, endOfItem) {
  const ranges = items
    .map((item) => ({ start: validInstant(startOf(item)), end: validInstant(endOfItem(item)) }))
    .filter(({ start, end }) => start && end && end >= start)
  if (ranges.length === 0) return null
  return {
    start: ranges.reduce((minimum, item) => item.start < minimum ? item.start : minimum, ranges[0].start),
    end: ranges.reduce((maximum, item) => item.end > maximum ? item.end : maximum, ranges[0].end),
  }
}

function plannedRange(task) {
  const explicitStart = validInstant(task.planned_start_at)
  const explicitEnd = validInstant(task.planned_due_at)
  if (!explicitStart && !explicitEnd) return null
  const created = validInstant(task.created_at)
  const start = explicitStart ?? (created && created <= explicitEnd ? created : explicitEnd)
  const end = explicitEnd ?? explicitStart
  return start && end && end >= start ? { start, end } : null
}

function segmentRange(segment) {
  const start = validInstant(segment.started_at)
  const end = validInstant(segment.ended_at) ?? validInstant(segment.last_seen_at)
  return start && end && end >= start ? { start, end } : null
}

function executionState(execution, now) {
  if (validInstant(execution.ended_at)) {
    return execution.end_reason === 'interrupted' ? 'interrupted' : 'ended'
  }
  const lastSeen = validInstant(execution.last_seen_at)
  if (!lastSeen) return 'stale'
  const age = Math.max(0, now.getTime() - Date.parse(lastSeen))
  if (age <= RUNNING_WINDOW_MS) return 'running'
  if (age <= IDLE_WINDOW_MS) return 'idle'
  return 'stale'
}

function liveExecutionSummary(executions, now) {
  const states = executions.map((execution) => ({ execution, state: executionState(execution, now) }))
  const open = states.filter(({ state }) => ['running', 'idle', 'stale'].includes(state))
  const counts = Object.fromEntries(
    ['running', 'idle', 'stale'].map((state) => [
      state,
      open.filter((item) => item.state === state).length,
    ]),
  )
  const liveState = counts.running > 0
    ? 'running'
    : counts.idle > 0 ? 'idle' : counts.stale > 0 ? 'stale' : executions.length > 0 ? 'ended' : 'none'
  const runningAgents = new Set(
    open
      .filter(({ state }) => state === 'running')
      .map(({ execution }) => execution.source_agent_key || execution.id),
  )
  return {
    execution_count: executions.length,
    active_execution_count: open.length,
    running_execution_count: counts.running,
    idle_execution_count: counts.idle,
    stale_execution_count: counts.stale,
    active_agent_count: runningAgents.size,
    live_state: liveState,
  }
}

function semanticProgress(tasks) {
  const included = tasks.filter(({ lifecycle }) => lifecycle !== 'canceled')
  if (included.length === 0) return null
  const completed = included.filter(({ lifecycle }) => lifecycle === 'done').length
  return {
    remaining: included.length - completed,
    total: included.length,
    completed,
    ratio: completed / included.length,
  }
}

function rollupLifecycle(task, children) {
  const included = children.filter(({ lifecycle, deleted_at: deletedAt }) => (
    lifecycle !== 'canceled' && !deletedAt
  ))
  return included.length > 0 && included.every(({ lifecycle }) => lifecycle === 'done')
    ? 'done'
    : task.lifecycle
}

function sortDashboardTree(rows) {
  const childrenByParent = new Map()
  for (const row of rows) {
    const children = childrenByParent.get(row.parent_id) ?? []
    children.push(row)
    childrenByParent.set(row.parent_id, children)
  }
  const compare = (left, right) => (
    String(right.last_activity ?? '').localeCompare(String(left.last_activity ?? ''))
    || left.sort_order - right.sort_order
    || left.id.localeCompare(right.id)
  )
  const sorted = []
  function append(parentId) {
    for (const row of [...(childrenByParent.get(parentId) ?? [])].sort(compare)) {
      sorted.push(row)
      append(row.id)
    }
  }
  append(null)
  return sorted
}

function projectLifecycle(tasks) {
  const current = tasks.filter(({ archived_at: archivedAt }) => !archivedAt)
  if (current.length === 0 || current.every(({ lifecycle }) => ['done', 'canceled'].includes(lifecycle))) {
    return current.some(({ lifecycle }) => lifecycle === 'done') ? 'done' : 'canceled'
  }
  if (current.some(({ lifecycle }) => lifecycle === 'blocked')) return 'blocked'
  if (current.some(({ lifecycle }) => lifecycle === 'in_progress')) return 'in_progress'
  if (current.some(({ lifecycle }) => lifecycle === 'waiting')) return 'waiting'
  return 'planned'
}

function recentExecution(executions) {
  return [...executions].sort((left, right) => (
    String(right.last_seen_at).localeCompare(String(left.last_seen_at))
    || String(right.id).localeCompare(String(left.id))
  ))[0] ?? null
}

function agentName(execution, sourceSession) {
  if (execution?.source_agent_key) return execution.source_agent_key
  if (sourceSession?.source === 'claude') return 'Claude'
  if (sourceSession?.source === 'codex') return 'Codex'
  return sourceSession?.source ?? 'Unknown'
}

function projectionContext(executions, sessionById, fallbackWorkfolder = null) {
  const execution = recentExecution(executions)
  const session = execution ? sessionById.get(execution.source_session_id) : null
  return {
    agent: agentName(execution, session),
    session_id: session?.external_session_id ?? null,
    workfolder: execution?.workfolder ?? fallbackWorkfolder,
    worktree: execution?.worktree ?? null,
    branch: execution?.branch ?? null,
    last_activity: validInstant(execution?.last_seen_at),
  }
}

function projectLocation(projectId, locations) {
  const priority = { workspace: 0, manual: 1, git_common_dir: 2, git_remote: 3 }
  return locations
    .filter(({ project_id: owner }) => owner === projectId)
    .sort((left, right) => (
      (priority[left.kind] ?? 9) - (priority[right.kind] ?? 9)
      || String(right.last_seen_at).localeCompare(String(left.last_seen_at))
    ))[0]?.display_value ?? null
}

function actualProjection(segments, { summary = false } = {}) {
  const validSegments = segments
    .map((segment) => ({ segment, range: segmentRange(segment) }))
    .filter(({ range }) => range)
  const actual = rangeFrom(validSegments, ({ range }) => range.start, ({ range }) => range.end)
  if (!actual) return { actual: null, actual_segments: [], actual_segment_count: 0 }
  const actualSegments = summary
    ? [{ id: 'envelope', ...actual, kind: 'envelope' }]
    : validSegments.map(({ segment, range }) => ({ id: segment.id, ...range, kind: 'segment' }))
  return {
    actual,
    actual_segments: actualSegments,
    actual_segment_count: validSegments.length,
  }
}

/**
 * Build the canonical schema-v3 Dashboard query projection.
 * Project rows are read-only projection nodes; they are never persisted as Tasks.
 */
export function createJournalDashboardSnapshot(snapshot, {
  now = new Date(),
  homeDirectory = homedir(),
} = {}) {
  const generatedAt = validInstant(now instanceof Date ? now.toISOString() : now)
  if (!generatedAt) throw new TypeError('now must be a valid date')
  const currentTime = new Date(generatedAt)
  const projects = Array.isArray(snapshot?.projects) ? snapshot.projects : []
  const locations = Array.isArray(snapshot?.project_locations) ? snapshot.project_locations : []
  const sourceSessions = Array.isArray(snapshot?.source_sessions) ? snapshot.source_sessions : []
  const executions = Array.isArray(snapshot?.executions) ? snapshot.executions : []
  const segments = Array.isArray(snapshot?.segments) ? snapshot.segments : []
  const rawTasks = Array.isArray(snapshot?.tasks) ? snapshot.tasks : []
  const projectById = new Map(projects.map((project) => [project.id, project]))
  const sessionById = new Map(sourceSessions.map((session) => [session.id, session]))
  const executionById = new Map(executions.map((execution) => [execution.id, execution]))
  const taskById = new Map(rawTasks.map((task) => [task.id, task]))
  const warnings = []

  const tasks = rawTasks.filter((task) => {
    if (task.deleted_at) return false
    if (!projectById.has(task.project_id)) {
      warnings.push({ code: 'TASK_PROJECT_MISSING', task_id: task.id })
      return false
    }
    if (task.parent_id !== null) {
      const parent = taskById.get(task.parent_id)
      if (!parent || parent.project_id !== task.project_id || parent.parent_id !== null) {
        warnings.push({ code: 'TASK_PARENT_INVALID', task_id: task.id })
        return false
      }
    }
    return true
  })
  const validTaskIds = new Set(tasks.map(({ id }) => id))
  const childrenByParent = new Map()
  for (const task of tasks) {
    if (task.parent_id === null) continue
    const children = childrenByParent.get(task.parent_id) ?? []
    children.push(task)
    childrenByParent.set(task.parent_id, children)
  }
  for (const children of childrenByParent.values()) {
    children.sort((left, right) => left.sort_order - right.sort_order || left.id.localeCompare(right.id))
  }

  const segmentsByTask = new Map()
  for (const segment of segments) {
    if (!segment.attribution_id || !segment.task_id) continue
    if (!validTaskIds.has(segment.task_id)) {
      warnings.push({ code: 'SEGMENT_TASK_MISSING', segment_id: segment.id })
      continue
    }
    if (!executionById.has(segment.execution_id) || !segmentRange(segment)) {
      warnings.push({ code: 'SEGMENT_FACT_INVALID', segment_id: segment.id })
      continue
    }
    const attributed = segmentsByTask.get(segment.task_id) ?? []
    attributed.push(segment)
    segmentsByTask.set(segment.task_id, attributed)
  }
  for (const attributed of segmentsByTask.values()) {
    attributed.sort((left, right) => left.started_at.localeCompare(right.started_at) || left.id.localeCompare(right.id))
  }

  function taskScope(task) {
    return task.parent_id === null ? [task, ...(childrenByParent.get(task.id) ?? [])] : [task]
  }

  function derivedTaskLifecycle(task) {
    return rollupLifecycle(task, childrenByParent.get(task.id) ?? [])
  }

  function factsFor(scopeTasks) {
    const scopedSegments = scopeTasks.flatMap((task) => segmentsByTask.get(task.id) ?? [])
    const scopedExecutions = [...new Set(scopedSegments.map(({ execution_id: id }) => id))]
      .map((id) => executionById.get(id))
      .filter(Boolean)
    return { scopedSegments, scopedExecutions }
  }

  function projectedPlan(scopeTasks) {
    const ranges = scopeTasks.map(plannedRange).filter(Boolean)
    return rangeFrom(ranges, ({ start }) => start, ({ end }) => end)
  }

  function taskRow(task) {
    const scope = taskScope(task)
    const summary = task.parent_id === null && (childrenByParent.get(task.id)?.length ?? 0) > 0
    const { scopedSegments, scopedExecutions } = factsFor(scope)
    const actual = actualProjection(scopedSegments, { summary })
    const planned = projectedPlan(scope)
    const context = projectionContext(scopedExecutions, sessionById)
    const rollup = derivedTaskLifecycle(task)
    const lastActivity = latestInstant([
      ...scopedSegments.map((segment) => segment.last_seen_at ?? segment.ended_at ?? segment.started_at),
      ...scope.map(({ updated_at: updatedAt }) => updatedAt),
    ])
    const fallbackStart = actual.actual?.start ?? planned?.start ?? validInstant(task.created_at)
    const fallbackEnd = actual.actual?.end ?? planned?.end ?? validInstant(task.updated_at) ?? fallbackStart
    return {
      id: task.id,
      parent_id: task.parent_id ?? `project:${task.project_id}`,
      project_id: task.project_id,
      entity_type: task.parent_id === null ? 'main_task' : 'subtask',
      title: task.title,
      description: task.description ?? null,
      lifecycle: task.lifecycle,
      status: legacyLifecycle(task.lifecycle),
      rollup_state: legacyLifecycle(rollup),
      next_action: task.next_action ?? null,
      sort_order: Number.isInteger(task.sort_order) ? task.sort_order : 0,
      revision: task.revision,
      archived_at: validInstant(task.archived_at),
      deleted_at: null,
      progress: task.parent_id === null ? semanticProgress(childrenByParent.get(task.id) ?? []) : null,
      planned,
      ...actual,
      start: fallbackStart,
      end: fallbackEnd,
      ...liveExecutionSummary(scopedExecutions, currentTime),
      ...context,
      last_activity: lastActivity,
      updated_at: validInstant(task.updated_at),
    }
  }

  const output = []
  const projectSummaries = []
  for (const project of [...projects].sort((left, right) => (
    left.name.localeCompare(right.name) || left.id.localeCompare(right.id)
  ))) {
    const projectTasks = tasks.filter(({ project_id: id }) => id === project.id)
    const mainTasks = projectTasks
      .filter(({ parent_id: parentId }) => parentId === null)
      .sort((left, right) => left.sort_order - right.sort_order || left.id.localeCompare(right.id))
    const { scopedSegments } = factsFor(projectTasks)
    const projectSessionIds = new Set(sourceSessions
      .filter(({ project_id: id }) => id === project.id)
      .map(({ id }) => id))
    const projectExecutions = executions.filter(({ source_session_id: id }) => projectSessionIds.has(id))
    const actual = actualProjection(scopedSegments, { summary: true })
    const planned = projectedPlan(projectTasks)
    const fallbackLocation = projectLocation(project.id, locations)
    const context = projectionContext(projectExecutions, sessionById, fallbackLocation)
    const rollupMainTasks = mainTasks.map((task) => ({
      ...task,
      lifecycle: derivedTaskLifecycle(task),
    }))
    const lifecycle = projectLifecycle(rollupMainTasks)
    const lastActivity = latestInstant([
      ...scopedSegments.map((segment) => segment.last_seen_at ?? segment.ended_at ?? segment.started_at),
      ...projectTasks.map(({ updated_at: updatedAt }) => updatedAt),
      context.last_activity,
      ...(projectTasks.length === 0 ? [project.updated_at] : []),
    ])
    const fallbackStart = actual.actual?.start ?? planned?.start ?? validInstant(project.created_at)
    const fallbackEnd = actual.actual?.end ?? planned?.end ?? validInstant(project.updated_at) ?? fallbackStart
    const row = {
      id: `project:${project.id}`,
      parent_id: null,
      project_id: project.id,
      entity_type: 'project',
      title: project.name,
      description: project.description ?? null,
      lifecycle,
      status: legacyLifecycle(lifecycle),
      rollup_state: legacyLifecycle(lifecycle),
      next_action: mainTasks.find(({ lifecycle: state }) => state === 'in_progress')?.next_action ?? null,
      sort_order: 0,
      revision: project.revision,
      archived_at: validInstant(project.archived_at),
      deleted_at: null,
      progress: semanticProgress(rollupMainTasks),
      planned,
      ...actual,
      start: fallbackStart,
      end: fallbackEnd,
      blocked_count: projectTasks.filter(({ lifecycle: state }) => state === 'blocked').length,
      ...liveExecutionSummary(projectExecutions, currentTime),
      ...context,
      last_activity: lastActivity,
      updated_at: validInstant(project.updated_at),
    }
    output.push(row)
    projectSummaries.push({
      id: project.id,
      name: project.name,
      revision: project.revision,
      lifecycle,
      task_count: projectTasks.length,
      blocked_count: row.blocked_count,
      live_state: row.live_state,
    })
    for (const mainTask of mainTasks) {
      output.push(taskRow(mainTask))
      for (const child of childrenByParent.get(mainTask.id) ?? []) output.push(taskRow(child))
    }
  }

  const projectInbox = sourceSessions
    .filter(({ project_id: projectId }) => projectId === null)
    .map((session) => {
      const sessionExecutions = executions.filter(({ source_session_id: id }) => id === session.id)
      const execution = recentExecution(sessionExecutions)
      return {
        id: session.id,
        source: session.source,
        external_session_id: session.external_session_id,
        root_external_session_id: session.root_external_session_id,
        first_seen_at: validInstant(session.first_seen_at),
        last_seen_at: validInstant(session.last_seen_at),
        agent: agentName(execution, session),
        workfolder: execution?.workfolder ?? null,
        worktree: execution?.worktree ?? null,
        branch: execution?.branch ?? null,
      }
    })
    .sort((left, right) => (
      String(right.last_seen_at).localeCompare(String(left.last_seen_at))
      || left.id.localeCompare(right.id)
    ))

  return {
    schema_version: 3,
    generated_at: generatedAt,
    home_directory: homeDirectory,
    project_inbox_count: count(snapshot?.project_inbox_count),
    attribution_inbox_count: count(snapshot?.attribution_inbox_count),
    unassigned_execution_count: count(snapshot?.attribution_inbox_count),
    projects: projectSummaries,
    project_inbox: projectInbox,
    tasks: sortDashboardTree(output),
    warnings: warnings.sort((left, right) => (
      String(left.task_id ?? left.segment_id).localeCompare(String(right.task_id ?? right.segment_id))
    )),
  }
}
