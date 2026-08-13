import { homedir } from 'node:os'

import { isValidDateOnly, TASK_STATUSES } from './task-store.mjs'

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
  if (task.status === 'done') return validInstant(task.completed_at ?? task.updated_at)
  if (task.due_date) {
    if (!isValidDateOnly(task.due_date)) return null
    return validInstant(`${task.due_date}T23:59:59.999Z`)
  }
  return null
}

function sessionString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

export function createDashboardSnapshot(snapshot, {
  now = new Date(),
  homeDirectory = homedir(),
} = {}) {
  const generatedAt = validInstant(now instanceof Date ? now.toISOString() : now)
  if (!generatedAt) throw new TypeError('now must be a valid date')
  const tasks = Array.isArray(snapshot?.tasks) ? snapshot.tasks : []
  const sessions = Array.isArray(snapshot?.sessions) ? snapshot.sessions : []
  const sourceById = new Map(tasks.map((task) => [task.id, task]))
  const invalid = new Map()

  for (const task of tasks) {
    if (!TASK_STATUSES.includes(task.status)) invalid.set(task.id, 'TASK_STATUS_INVALID')
    else if (
      !taskStart(task)
      || !validInstant(task.updated_at)
      || (task.due_date !== null && !isValidDateOnly(task.due_date))
      || (taskEnd(task) === null && task.status === 'done')
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
      return {
        id: task.id,
        parent_id: task.parent_id,
        title: task.title,
        status: task.status,
        agent: recentAgent?.agent || 'Unknown',
        start: taskStart(task),
        end: taskEnd(task),
        last_activity: recent?.last_seen_at ?? validInstant(task.updated_at),
        next_action: task.next_action,
        workfolder: sessionString(recent?.workfolder),
        worktree: sessionString(recent?.worktree),
        branch: sessionString(recent?.branch),
        updated_at: validInstant(task.updated_at),
      }
    })

  return {
    generated_at: generatedAt,
    home_directory: homeDirectory,
    tasks: outputTasks,
    warnings: [...invalid]
      .map(([task_id, code]) => ({ code, task_id }))
      .sort((left, right) => left.task_id.localeCompare(right.task_id)),
  }
}
