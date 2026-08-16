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
