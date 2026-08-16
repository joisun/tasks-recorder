import { mkdirSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { TaskRecorderError } from './errors.mjs'
import { createTaskExecutionStore } from './task-execution-store.mjs'
import { initializeTaskSchema } from './task-schema.mjs'
import {
  TASK_STATUSES,
  taskDiff,
  taskEventChanges,
  taskMetadata,
  taskProgress,
} from './task-tree.mjs'

export { TASK_STATUSES } from './task-tree.mjs'

const TASK_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const TASK_EVENT_ACTORS = new Set(['agent', 'user', 'hook', 'importer'])

function fail(code, message, details) {
  throw new TaskRecorderError(code, message, details)
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function requiredString(value, field, code = 'TASK_INPUT_INVALID') {
  if (typeof value !== 'string' || value.trim() === '') {
    fail(code, `${field} must be a non-empty string`, { field })
  }
  return value.trim()
}

function optionalString(value, field) {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string' || value.trim() === '') {
    fail('TASK_INPUT_INVALID', `${field} must be null or a non-empty string`, { field })
  }
  return value.trim()
}

function normalizeId(value) {
  const id = requiredString(value, 'id')
  if (!TASK_ID_PATTERN.test(id)) {
    fail('TASK_ID_INVALID', 'id must use lowercase kebab-case', { id })
  }
  return id
}

function normalizeStatus(value) {
  if (!TASK_STATUSES.includes(value)) {
    fail('TASK_STATUS_INVALID', `status must be one of: ${TASK_STATUSES.join(', ')}`, {
      status: value,
    })
  }
  return value
}

function normalizeExpectedUpdatedAt(value) {
  const expected = requiredString(value, 'expected_updated_at')
  if (Number.isNaN(Date.parse(expected))) {
    fail('TASK_INPUT_INVALID', 'expected_updated_at must be a valid instant', {
      field: 'expected_updated_at',
    })
  }
  return expected
}

function normalizeExpectedRevision(value) {
  if (!Number.isInteger(value) || value < 1) {
    fail('TASK_INPUT_INVALID', 'expected_revision must be a positive integer', {
      field: 'expected_revision',
    })
  }
  return value
}

function normalizeSortOrder(value) {
  if (!Number.isInteger(value) || value < 0) {
    fail('TASK_INPUT_INVALID', 'sort_order must be a non-negative integer', {
      field: 'sort_order',
    })
  }
  return value
}

function normalizeEventActor(value) {
  const actor = value ?? 'agent'
  if (!TASK_EVENT_ACTORS.has(actor)) {
    fail('TASK_INPUT_INVALID', 'actor must be agent, user, hook, or importer', { field: 'actor' })
  }
  return actor
}

function generatedTaskId(title, seed) {
  const slug = requiredString(title, 'title')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'task'
  const suffix = createHash('sha256').update(seed).digest('hex').slice(0, 8)
  return `${slug}-${suffix}`
}

export function isValidDateOnly(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value
}

function normalizeDate(value, field) {
  const date = requiredString(value, field)
  if (!isValidDateOnly(date)) {
    fail('TASK_DATE_INVALID', `${field} must use YYYY-MM-DD`, { field, value })
  }
  return date
}

function nowIso(clock) {
  const value = clock()
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.valueOf())) {
    fail('CLOCK_INVALID', 'clock must return a valid Date or date value')
  }
  return date.toISOString()
}

function nextUpdatedAt(clock, previous) {
  const timestamp = nowIso(clock)
  const previousTime = Date.parse(previous)
  return Date.parse(timestamp) > previousTime
    ? timestamp
    : new Date(previousTime + 1).toISOString()
}

function normalizeContext(input) {
  return {
    session_id: requiredString(
      input.session_id ?? input.sessionId,
      'session_id',
      'SESSION_CONTEXT_REQUIRED',
    ),
    workfolder: requiredString(input.workfolder, 'workfolder', 'SESSION_CONTEXT_REQUIRED'),
    git_root: optionalString(input.git_root ?? input.gitContext?.gitRoot, 'git_root'),
    worktree: optionalString(input.worktree ?? input.gitContext?.worktree, 'worktree'),
    branch: optionalString(input.branch ?? input.gitContext?.branch, 'branch'),
    agent: optionalString(input.agent, 'agent'),
  }
}

function runTransaction(db, operation) {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = operation()
    db.exec('COMMIT')
    return result
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export function createTaskStore({ databasePath, clock = () => new Date() }) {
  requiredString(databasePath, 'databasePath', 'DATABASE_PATH_INVALID')
  mkdirSync(dirname(databasePath), { recursive: true })

  const db = new DatabaseSync(databasePath)
  try {
    initializeTaskSchema(db)
  } catch (error) {
    db.close()
    throw error
  }
  const executionStore = createTaskExecutionStore({
    db,
    clock,
    transact: (operation) => runTransaction(db, operation),
  })

  const selectTask = db.prepare('SELECT * FROM tasks WHERE id = ?')
  const selectChildren = db.prepare(`
    SELECT * FROM tasks
    WHERE parent_id = ?
    ORDER BY start_date, id
  `)
  const selectVisibleChildren = db.prepare(`
    SELECT * FROM tasks
    WHERE parent_id = ? AND deleted_at IS NULL
    ORDER BY sort_order, start_date, id
  `)
  const selectSessions = db.prepare(`
    SELECT * FROM task_sessions
    WHERE task_id = ?
    ORDER BY first_seen_at, session_id
  `)
  const insertTask = db.prepare(`
    INSERT INTO tasks (
      id, parent_id, project, title, description, status, start_date, due_date,
      next_action, agent_key, sort_order, completed_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const updateTask = db.prepare(`
    UPDATE tasks SET
      parent_id = ?, project = ?, title = ?, description = ?, status = ?, start_date = ?,
      due_date = ?, next_action = ?, agent_key = ?, sort_order = ?, completed_at = ?,
      revision = revision + 1, updated_at = ?
    WHERE id = ?
  `)
  const updateTaskStatus = db.prepare(`
    UPDATE tasks
    SET status = ?, completed_at = ?, revision = revision + 1, updated_at = ?
    WHERE id = ?
  `)
  const incrementTreeRevision = db.prepare(`
    UPDATE tasks
    SET revision = revision + 1, updated_at = ?
    WHERE id = ?
  `)
  const updateTaskLifecycle = db.prepare(`
    UPDATE tasks
    SET archived_at = ?, deleted_at = ?, revision = revision + 1, updated_at = ?
    WHERE id = ?
  `)
  const insertTaskEvent = db.prepare(`
    INSERT INTO task_events (
      id, task_id, event_type, before_json, after_json, actor, source_session_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const selectTaskEvents = db.prepare(`
    SELECT * FROM task_events
    WHERE task_id = ?
    ORDER BY created_at, rowid
  `)
  const linkSession = db.prepare(`
    INSERT INTO task_sessions (
      task_id, session_id, workfolder, git_root, worktree, branch, agent,
      first_seen_at, last_seen_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(task_id, session_id) DO UPDATE SET
      workfolder = excluded.workfolder,
      git_root = excluded.git_root,
      worktree = excluded.worktree,
      branch = excluded.branch,
      agent = COALESCE(excluded.agent, task_sessions.agent),
      last_seen_at = excluded.last_seen_at
  `)
  const selectHeartbeatTarget = db.prepare(`
    SELECT t.id AS task_id, s.last_seen_at
    FROM task_sessions s
    JOIN tasks t ON t.id = s.task_id
    WHERE s.session_id = ? AND t.status != 'done'
    ORDER BY s.last_seen_at DESC, t.updated_at DESC, t.id ASC
    LIMIT 1
  `)
  const updateHeartbeat = db.prepare(`
    UPDATE task_sessions
    SET last_seen_at = ?, agent = COALESCE(?, agent)
    WHERE task_id = ? AND session_id = ?
  `)

  function validateHierarchy(task) {
    const children = selectChildren.all(task.id)
    if (task.parent_id === task.id) {
      fail('PARENT_SELF_REFERENCE', 'a task cannot be its own parent', { id: task.id })
    }
    if (task.parent_id !== null) {
      const parent = selectTask.get(task.parent_id)
      if (!parent) {
        fail('PARENT_NOT_FOUND', `parent task ${task.parent_id} does not exist`, {
          parent_id: task.parent_id,
        })
      }
      if (parent.parent_id !== null || children.length > 0) {
        fail('PARENT_DEPTH_INVALID', 'task hierarchy supports exactly one child level', {
          id: task.id,
          parent_id: task.parent_id,
        })
      }
      if (parent.project !== task.project) {
        fail('PARENT_PROJECT_MISMATCH', 'parent and child must belong to the same project', {
          id: task.id,
          parent_id: task.parent_id,
        })
      }
    }
    if (children.some((child) => child.project !== task.project)) {
      fail('PARENT_PROJECT_MISMATCH', 'parent and children must belong to the same project', {
        id: task.id,
      })
    }
  }

  function writeSession(taskId, context, timestamp) {
    linkSession.run(
      taskId,
      context.session_id,
      context.workfolder,
      context.git_root,
      context.worktree,
      context.branch,
      context.agent,
      timestamp,
      timestamp,
    )
  }

  function writeTaskEvents({ before, after, actor, sourceSessionId, timestamp }) {
    const changes = before === null
      ? [{ event_type: 'created', before: null, after: taskMetadata(after) }]
      : taskEventChanges(before, after)
    for (const change of changes) {
      insertTaskEvent.run(
        randomUUID(),
        after.id,
        change.event_type,
        change.before === null ? null : JSON.stringify(change.before),
        JSON.stringify(change.after),
        actor,
        sourceSessionId,
        timestamp,
      )
    }
  }

  function heartbeat(input) {
    const sessionId = requiredString(
      input.session_id ?? input.sessionId,
      'session_id',
      'SESSION_CONTEXT_REQUIRED',
    )
    const agent = optionalString(input.agent, 'agent')
    const minimumInterval = input.minimum_interval_ms ?? 0
    if (!Number.isFinite(minimumInterval) || minimumInterval < 0) {
      fail('TASK_INPUT_INVALID', 'minimum_interval_ms must be a non-negative number')
    }
    const target = selectHeartbeatTarget.get(sessionId)
    if (!target) return { updated: false, reason: 'no-active-task' }
    const timestamp = nowIso(clock)
    if (Date.parse(timestamp) - Date.parse(target.last_seen_at) < minimumInterval) {
      return {
        updated: false,
        reason: 'throttled',
        task_id: target.task_id,
        last_seen_at: target.last_seen_at,
      }
    }
    updateHeartbeat.run(timestamp, agent, target.task_id, sessionId)
    return { updated: true, task_id: target.task_id, last_seen_at: timestamp }
  }

  function show(id) {
    const normalizedId = normalizeId(id)
    const task = selectTask.get(normalizedId)
    if (!task) fail('TASK_NOT_FOUND', `task ${normalizedId} does not exist`, { id: normalizedId })
    const children = selectVisibleChildren.all(normalizedId)

    return {
      task,
      parent: task.parent_id === null ? null : selectTask.get(task.parent_id) ?? null,
      children,
      sessions: selectSessions.all(normalizedId),
      progress: taskProgress(task, children),
      events: selectTaskEvents.all(normalizedId),
    }
  }

  function upsert(input) {
    const id = normalizeId(input.id)
    const context = normalizeContext(input)
    const existing = selectTask.get(id)
    const timestamp = nowIso(clock)
    const actor = normalizeEventActor(input.actor)
    const status = normalizeStatus(input.status)
    const project = hasOwn(input, 'project')
      ? requiredString(input.project, 'project')
      : existing?.project ?? '独立任务'
    const parentId = hasOwn(input, 'parent_id')
      ? (input.parent_id === null ? null : normalizeId(input.parent_id))
      : existing?.parent_id ?? null
    const startDate = hasOwn(input, 'start_date')
      ? normalizeDate(input.start_date, 'start_date')
      : existing?.start_date ?? timestamp.slice(0, 10)
    const dueDate = hasOwn(input, 'due_date')
      ? (input.due_date === null ? null : normalizeDate(input.due_date, 'due_date'))
      : existing?.due_date ?? null
    const nextAction = hasOwn(input, 'next_action')
      ? optionalString(input.next_action, 'next_action')
      : existing?.next_action ?? null
    const description = hasOwn(input, 'description')
      ? optionalString(input.description, 'description')
      : existing?.description ?? null
    const agentKey = hasOwn(input, 'agent_key')
      ? optionalString(input.agent_key, 'agent_key')
      : existing?.agent_key ?? null
    const sortOrder = hasOwn(input, 'sort_order')
      ? normalizeSortOrder(input.sort_order)
      : existing?.sort_order ?? 0
    const task = {
      id,
      parent_id: parentId,
      project,
      title: requiredString(input.title, 'title'),
      description,
      status,
      start_date: startDate,
      due_date: dueDate,
      next_action: nextAction,
      agent_key: agentKey,
      sort_order: sortOrder,
      completed_at: status === 'done' ? existing?.completed_at ?? timestamp : null,
      archived_at: existing?.archived_at ?? null,
      deleted_at: existing?.deleted_at ?? null,
      created_at: existing?.created_at ?? timestamp,
      updated_at: timestamp,
    }

    return runTransaction(db, () => {
      validateHierarchy(task)
      let changed = !existing
      if (existing) {
        changed = Object.keys(taskDiff(existing, task)).length > 0
        if (changed) {
          task.updated_at = nextUpdatedAt(clock, existing.updated_at)
          updateTask.run(
            task.parent_id,
            task.project,
            task.title,
            task.description,
            task.status,
            task.start_date,
            task.due_date,
            task.next_action,
            task.agent_key,
            task.sort_order,
            task.completed_at,
            task.updated_at,
            task.id,
          )
          writeTaskEvents({
            before: existing,
            after: selectTask.get(task.id),
            actor,
            sourceSessionId: context.session_id,
            timestamp: task.updated_at,
          })
          const parentIds = new Set([existing.parent_id, task.parent_id])
          parentIds.delete(null)
          for (const parentId of parentIds) {
            const parent = selectTask.get(parentId)
            incrementTreeRevision.run(nextUpdatedAt(clock, parent.updated_at), parent.id)
          }
        }
      } else {
        insertTask.run(
          task.id,
          task.parent_id,
          task.project,
          task.title,
          task.description,
          task.status,
          task.start_date,
          task.due_date,
          task.next_action,
          task.agent_key,
          task.sort_order,
          task.completed_at,
          task.created_at,
          task.updated_at,
        )
        writeTaskEvents({
          before: null,
          after: selectTask.get(task.id),
          actor,
          sourceSessionId: context.session_id,
          timestamp: task.created_at,
        })
        if (task.parent_id !== null) {
          const parent = selectTask.get(task.parent_id)
          incrementTreeRevision.run(nextUpdatedAt(clock, parent.updated_at), parent.id)
        }
      }
      writeSession(id, context, timestamp)
      return { task: selectTask.get(id), session: selectSessions.get(id), changed }
    })
  }

  function complete(input) {
    const id = normalizeId(input.id)
    const context = normalizeContext(input)
    const activityTimestamp = nowIso(clock)
    const actor = normalizeEventActor(input.actor)

    return runTransaction(db, () => {
      const existing = selectTask.get(id)
      if (!existing) fail('TASK_NOT_FOUND', `task ${id} does not exist`, { id })
      const incomplete = selectChildren.all(id).filter((child) => (
        child.deleted_at === null && !['done', 'canceled'].includes(child.status)
      ))
      if (incomplete.length > 0) {
        fail('CHILD_TASKS_INCOMPLETE', 'all child tasks must be done first', {
          id,
          child_ids: incomplete.map((child) => child.id),
        })
      }
      if (existing.status === 'done') {
        writeSession(id, context, activityTimestamp)
        return {
          task: existing,
          session: selectSessions.get(id),
          affected_parent: null,
          changed: false,
        }
      }

      const timestamp = nextUpdatedAt(clock, existing.updated_at)
      updateTaskStatus.run(
        'done',
        existing.completed_at ?? activityTimestamp,
        timestamp,
        id,
      )
      const updated = selectTask.get(id)
      writeTaskEvents({
        before: existing,
        after: updated,
        actor,
        sourceSessionId: context.session_id,
        timestamp,
      })
      let affectedParent = null
      if (updated.parent_id !== null) {
        const parent = selectTask.get(updated.parent_id)
        incrementTreeRevision.run(nextUpdatedAt(clock, parent.updated_at), parent.id)
        affectedParent = selectTask.get(parent.id)
      }
      writeSession(id, context, activityTimestamp)
      return {
        task: updated,
        session: selectSessions.get(id),
        affected_parent: affectedParent,
        changed: true,
      }
    })
  }

  function updateTaskMetadata(input) {
    const id = normalizeId(input.id)
    const expectedRevision = normalizeExpectedRevision(input.expected_revision)
    const patch = input.patch
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      fail('TASK_INPUT_INVALID', 'patch must be an object', { field: 'patch' })
    }
    const allowedFields = new Set([
      'parent_id', 'project', 'title', 'description', 'status', 'start_date', 'due_date',
      'next_action', 'agent_key', 'sort_order',
    ])
    const unknownFields = Object.keys(patch).filter((field) => !allowedFields.has(field))
    if (unknownFields.length > 0) {
      fail('TASK_INPUT_INVALID', 'patch contains unsupported fields', { fields: unknownFields })
    }
    const actor = normalizeEventActor(input.actor ?? 'user')
    const sourceSessionId = optionalString(
      input.source_session_id ?? input.session_id,
      'source_session_id',
    )

    return runTransaction(db, () => {
      const existing = selectTask.get(id)
      if (!existing) fail('TASK_NOT_FOUND', `task ${id} does not exist`, { id })
      if (existing.revision !== expectedRevision) {
        fail('TASK_VERSION_CONFLICT', `task ${id} was updated`, {
          id,
          expected_revision: expectedRevision,
          actual_revision: existing.revision,
          task: existing,
        })
      }
      const timestamp = nowIso(clock)
      const status = hasOwn(patch, 'status') ? normalizeStatus(patch.status) : existing.status
      const task = {
        ...existing,
        parent_id: hasOwn(patch, 'parent_id')
          ? (patch.parent_id === null ? null : normalizeId(patch.parent_id))
          : existing.parent_id,
        project: hasOwn(patch, 'project')
          ? requiredString(patch.project, 'project')
          : existing.project,
        title: hasOwn(patch, 'title')
          ? requiredString(patch.title, 'title')
          : existing.title,
        description: hasOwn(patch, 'description')
          ? optionalString(patch.description, 'description')
          : existing.description,
        status,
        start_date: hasOwn(patch, 'start_date')
          ? normalizeDate(patch.start_date, 'start_date')
          : existing.start_date,
        due_date: hasOwn(patch, 'due_date')
          ? (patch.due_date === null ? null : normalizeDate(patch.due_date, 'due_date'))
          : existing.due_date,
        next_action: hasOwn(patch, 'next_action')
          ? optionalString(patch.next_action, 'next_action')
          : existing.next_action,
        agent_key: hasOwn(patch, 'agent_key')
          ? optionalString(patch.agent_key, 'agent_key')
          : existing.agent_key,
        sort_order: hasOwn(patch, 'sort_order')
          ? normalizeSortOrder(patch.sort_order)
          : existing.sort_order,
        completed_at: status === 'done' ? existing.completed_at ?? timestamp : null,
      }
      validateHierarchy(task)
      if (status === 'done') {
        const incomplete = selectChildren.all(id).filter((child) => (
          child.deleted_at === null && !['done', 'canceled'].includes(child.status)
        ))
        if (incomplete.length > 0) {
          fail('CHILD_TASKS_INCOMPLETE', 'all child tasks must be done first', {
            id,
            child_ids: incomplete.map((child) => child.id),
          })
        }
      }
      if (Object.keys(taskDiff(existing, task)).length === 0) {
        return { task: existing, affected_parent: null, changed: false }
      }

      task.updated_at = nextUpdatedAt(clock, existing.updated_at)
      updateTask.run(
        task.parent_id,
        task.project,
        task.title,
        task.description,
        task.status,
        task.start_date,
        task.due_date,
        task.next_action,
        task.agent_key,
        task.sort_order,
        task.completed_at,
        task.updated_at,
        task.id,
      )
      const updated = selectTask.get(id)
      writeTaskEvents({
        before: existing,
        after: updated,
        actor,
        sourceSessionId,
        timestamp: task.updated_at,
      })

      let affectedParent = null
      const parentIds = new Set([existing.parent_id, updated.parent_id])
      parentIds.delete(null)
      for (const parentId of parentIds) {
        let parent = selectTask.get(parentId)
        if (
          parentId === updated.parent_id
          && parent.status === 'done'
          && !['done', 'canceled'].includes(updated.status)
        ) {
          const parentTimestamp = nextUpdatedAt(clock, parent.updated_at)
          updateTaskStatus.run('active', null, parentTimestamp, parent.id)
          const reopenedParent = selectTask.get(parent.id)
          writeTaskEvents({
            before: parent,
            after: reopenedParent,
            actor,
            sourceSessionId,
            timestamp: parentTimestamp,
          })
          parent = reopenedParent
        }
        incrementTreeRevision.run(nextUpdatedAt(clock, parent.updated_at), parent.id)
        affectedParent = selectTask.get(parent.id)
      }
      return { task: updated, affected_parent: affectedParent, changed: true }
    })
  }

  function mutateTaskLifecycle(input, operation) {
    const id = normalizeId(input.id)
    const expectedRevision = normalizeExpectedRevision(input.expected_revision)
    const actor = normalizeEventActor(input.actor ?? 'user')
    const sourceSessionId = optionalString(
      input.source_session_id ?? input.session_id,
      'source_session_id',
    )

    return runTransaction(db, () => {
      const existing = selectTask.get(id)
      if (!existing) fail('TASK_NOT_FOUND', `task ${id} does not exist`, { id })
      if (existing.revision !== expectedRevision) {
        fail('TASK_VERSION_CONFLICT', `task ${id} was updated`, {
          id,
          expected_revision: expectedRevision,
          actual_revision: existing.revision,
          task: existing,
        })
      }
      if (operation === 'archive' && !['done', 'canceled'].includes(existing.status)) {
        fail('TASK_ARCHIVE_STATUS_INVALID', 'only done or canceled tasks can be archived', {
          id,
          status: existing.status,
        })
      }

      const timestamp = nextUpdatedAt(clock, existing.updated_at)
      const task = {
        ...existing,
        archived_at: operation === 'archive'
          ? existing.archived_at ?? timestamp
          : operation === 'restore' ? null : existing.archived_at,
        deleted_at: operation === 'delete'
          ? existing.deleted_at ?? timestamp
          : operation === 'restore' ? null : existing.deleted_at,
      }
      if (Object.keys(taskDiff(existing, task)).length === 0) {
        return { task: existing, affected_parent: null, changed: false }
      }

      updateTaskLifecycle.run(task.archived_at, task.deleted_at, timestamp, id)
      const updated = selectTask.get(id)
      writeTaskEvents({
        before: existing,
        after: updated,
        actor,
        sourceSessionId,
        timestamp,
      })
      let affectedParent = null
      if (updated.parent_id !== null) {
        const parent = selectTask.get(updated.parent_id)
        incrementTreeRevision.run(nextUpdatedAt(clock, parent.updated_at), parent.id)
        affectedParent = selectTask.get(parent.id)
      }
      return { task: updated, affected_parent: affectedParent, changed: true }
    })
  }

  function taskEvents(filters = {}) {
    const id = normalizeId(filters.task_id ?? filters.id)
    if (!selectTask.get(id)) fail('TASK_NOT_FOUND', `task ${id} does not exist`, { id })
    return selectTaskEvents.all(id)
  }

  function syncTree(input) {
    const context = normalizeContext(input)
    const turnId = requiredString(input.turn_id, 'turn_id')
    if (!input.root || typeof input.root !== 'object' || Array.isArray(input.root)) {
      fail('TASK_INPUT_INVALID', 'root must be an object', { field: 'root' })
    }
    if (!Array.isArray(input.children)) {
      fail('TASK_INPUT_INVALID', 'children must be an array', { field: 'children' })
    }
    const actor = normalizeEventActor(input.actor)
    const timestamp = nowIso(clock)
    const generatedRoot = !hasOwn(input.root, 'id')
    const rootId = !generatedRoot
      ? normalizeId(input.root.id)
      : generatedTaskId(
        input.root.title,
        `${context.session_id}:${turnId}:root:${input.root.title}`,
      )
    const normalizedChildren = input.children.map((child, index) => {
      if (!child || typeof child !== 'object' || Array.isArray(child)) {
        fail('TASK_INPUT_INVALID', 'child must be an object', { index })
      }
      return {
        ...child,
        id: hasOwn(child, 'id')
          ? normalizeId(child.id)
          : generatedTaskId(
            child.title,
            `${context.session_id}:${turnId}:${rootId}:${index}:${child.title}`,
          ),
      }
    })
    const duplicateIds = normalizedChildren
      .map(({ id }) => id)
      .filter((id, index, ids) => id === rootId || ids.indexOf(id) !== index)
    if (duplicateIds.length > 0) {
      fail('TASK_TREE_DUPLICATE_ID', 'root and children must use unique ids', {
        ids: [...new Set(duplicateIds)],
      })
    }
    const agentKeys = normalizedChildren
      .map(({ agent_key: agentKey }) => agentKey)
      .filter((agentKey) => agentKey !== undefined && agentKey !== null)
    const duplicateAgentKeys = agentKeys.filter(
      (agentKey, index) => agentKeys.indexOf(agentKey) !== index,
    )
    if (duplicateAgentKeys.length > 0) {
      fail('TASK_TREE_AGENT_KEY_CONFLICT', 'child agent_key values must be unique', {
        agent_keys: [...new Set(duplicateAgentKeys)],
      })
    }

    return runTransaction(db, () => {
      const existingRoot = selectTask.get(rootId)
      if (existingRoot) {
        const implicitGeneratedRetry = generatedRoot && input.expected_revision === null
        let revisionMatches = false
        if (implicitGeneratedRetry) {
          const createdBySession = selectTaskEvents.all(rootId).some((event) => (
            event.event_type === 'created' && event.source_session_id === context.session_id
          ))
          const existingChildren = selectVisibleChildren.all(rootId)
          const expectedChildIds = normalizedChildren.map(({ id }) => id).sort()
          const actualChildIds = existingChildren.map(({ id }) => id).sort()
          revisionMatches = createdBySession
            && existingRoot.revision === 1 + normalizedChildren.length
            && existingChildren.every(({ revision }) => revision === 1)
            && expectedChildIds.length === actualChildIds.length
            && expectedChildIds.every((id, index) => id === actualChildIds[index])
        } else {
          revisionMatches = existingRoot.revision
            === normalizeExpectedRevision(input.expected_revision)
        }
        if (!revisionMatches) {
          fail('TASK_TREE_VERSION_CONFLICT', `task tree ${rootId} was updated`, {
            id: rootId,
            expected_revision: input.expected_revision,
            actual_revision: existingRoot.revision,
            root: existingRoot,
            children: selectVisibleChildren.all(rootId),
          })
        }
      } else if (input.expected_revision !== null && input.expected_revision !== undefined) {
        fail('TASK_TREE_VERSION_CONFLICT', `task tree ${rootId} does not exist`, {
          id: rootId,
          expected_revision: input.expected_revision,
          actual_revision: null,
        })
      }

      const rootStatus = normalizeStatus(input.root.status)
      const root = {
        id: rootId,
        parent_id: null,
        project: hasOwn(input.root, 'project')
          ? requiredString(input.root.project, 'project')
          : existingRoot?.project ?? '独立任务',
        title: requiredString(input.root.title, 'title'),
        description: hasOwn(input.root, 'description')
          ? optionalString(input.root.description, 'description')
          : existingRoot?.description ?? null,
        status: rootStatus,
        start_date: hasOwn(input.root, 'start_date')
          ? normalizeDate(input.root.start_date, 'start_date')
          : existingRoot?.start_date ?? timestamp.slice(0, 10),
        due_date: hasOwn(input.root, 'due_date')
          ? (input.root.due_date === null
            ? null
            : normalizeDate(input.root.due_date, 'due_date'))
          : existingRoot?.due_date ?? null,
        next_action: hasOwn(input.root, 'next_action')
          ? optionalString(input.root.next_action, 'next_action')
          : existingRoot?.next_action ?? null,
        agent_key: null,
        sort_order: 0,
        completed_at: rootStatus === 'done'
          ? existingRoot?.completed_at ?? timestamp
          : null,
        archived_at: existingRoot?.archived_at ?? null,
        deleted_at: existingRoot?.deleted_at ?? null,
        created_at: existingRoot?.created_at ?? timestamp,
        updated_at: existingRoot?.updated_at ?? timestamp,
      }
      validateHierarchy(root)
      let taskChanged = false
      if (existingRoot) {
        if (Object.keys(taskDiff(existingRoot, root)).length > 0) {
          root.updated_at = nextUpdatedAt(clock, existingRoot.updated_at)
          updateTask.run(
            root.parent_id,
            root.project,
            root.title,
            root.description,
            root.status,
            root.start_date,
            root.due_date,
            root.next_action,
            root.agent_key,
            root.sort_order,
            root.completed_at,
            root.updated_at,
            root.id,
          )
          writeTaskEvents({
            before: existingRoot,
            after: selectTask.get(rootId),
            actor,
            sourceSessionId: context.session_id,
            timestamp: root.updated_at,
          })
          taskChanged = true
        }
      } else {
        insertTask.run(
          root.id,
          root.parent_id,
          root.project,
          root.title,
          root.description,
          root.status,
          root.start_date,
          root.due_date,
          root.next_action,
          root.agent_key,
          root.sort_order,
          root.completed_at,
          root.created_at,
          root.updated_at,
        )
        writeTaskEvents({
          before: null,
          after: selectTask.get(rootId),
          actor,
          sourceSessionId: context.session_id,
          timestamp,
        })
        taskChanged = true
      }

      for (const childInput of normalizedChildren) {
        const existing = selectTask.get(childInput.id)
        if (existing && existing.parent_id !== rootId) {
          fail('TASK_TREE_SCOPE_INVALID', `task ${existing.id} belongs to another tree`, {
            id: existing.id,
            parent_id: existing.parent_id,
            root_id: rootId,
          })
        }
        const status = normalizeStatus(childInput.status)
        const currentRoot = selectTask.get(rootId)
        const child = {
          id: childInput.id,
          parent_id: rootId,
          project: currentRoot.project,
          title: requiredString(childInput.title, 'title'),
          description: hasOwn(childInput, 'description')
            ? optionalString(childInput.description, 'description')
            : existing?.description ?? null,
          status,
          start_date: existing?.start_date ?? currentRoot.start_date,
          due_date: hasOwn(childInput, 'due_date')
            ? (childInput.due_date === null
              ? null
              : normalizeDate(childInput.due_date, 'due_date'))
            : existing?.due_date ?? null,
          next_action: hasOwn(childInput, 'next_action')
            ? optionalString(childInput.next_action, 'next_action')
            : existing?.next_action ?? null,
          agent_key: hasOwn(childInput, 'agent_key')
            ? optionalString(childInput.agent_key, 'agent_key')
            : existing?.agent_key ?? null,
          sort_order: normalizeSortOrder(childInput.sort_order),
          completed_at: status === 'done' ? existing?.completed_at ?? timestamp : null,
          archived_at: existing?.archived_at ?? null,
          deleted_at: existing?.deleted_at ?? null,
          created_at: existing?.created_at ?? timestamp,
          updated_at: existing?.updated_at ?? timestamp,
        }
        validateHierarchy(child)
        let childChanged = false
        if (existing) {
          if (Object.keys(taskDiff(existing, child)).length > 0) {
            child.updated_at = nextUpdatedAt(clock, existing.updated_at)
            updateTask.run(
              child.parent_id,
              child.project,
              child.title,
              child.description,
              child.status,
              child.start_date,
              child.due_date,
              child.next_action,
              child.agent_key,
              child.sort_order,
              child.completed_at,
              child.updated_at,
              child.id,
            )
            writeTaskEvents({
              before: existing,
              after: selectTask.get(child.id),
              actor,
              sourceSessionId: context.session_id,
              timestamp: child.updated_at,
            })
            childChanged = true
          }
        } else {
          insertTask.run(
            child.id,
            child.parent_id,
            child.project,
            child.title,
            child.description,
            child.status,
            child.start_date,
            child.due_date,
            child.next_action,
            child.agent_key,
            child.sort_order,
            child.completed_at,
            child.created_at,
            child.updated_at,
          )
          writeTaskEvents({
            before: null,
            after: selectTask.get(child.id),
            actor,
            sourceSessionId: context.session_id,
            timestamp,
          })
          childChanged = true
        }
        if (childChanged) {
          const parent = selectTask.get(rootId)
          incrementTreeRevision.run(nextUpdatedAt(clock, parent.updated_at), rootId)
          taskChanged = true
        }
      }

      const persistedRoot = selectTask.get(rootId)
      if (persistedRoot.status === 'done') {
        const incomplete = selectChildren.all(rootId).filter((child) => (
          child.deleted_at === null && !['done', 'canceled'].includes(child.status)
        ))
        if (incomplete.length > 0) {
          fail('CHILD_TASKS_INCOMPLETE', 'all child tasks must be done first', {
            id: rootId,
            child_ids: incomplete.map((child) => child.id),
          })
        }
      }

      writeSession(rootId, context, timestamp)
      const focusTaskId = input.focus_task_id === null || input.focus_task_id === undefined
        ? null
        : normalizeId(input.focus_task_id)
      let focusedTask = null
      let focusResult = null
      if (focusTaskId !== null) {
        focusedTask = selectTask.get(focusTaskId)
        if (!focusedTask || (focusedTask.id !== rootId && focusedTask.parent_id !== rootId)) {
          fail('TASK_TREE_FOCUS_INVALID', 'focus_task_id must belong to the synchronized tree', {
            root_id: rootId,
            focus_task_id: focusTaskId,
          })
        }
        focusResult = executionStore.focusExecutionInTransaction({
          root_session_id: context.session_id,
          session_id: context.session_id,
          turn_id: turnId,
          task_id: focusTaskId,
          actor,
        })
        writeSession(focusTaskId, context, timestamp)
      }
      const finalRoot = selectTask.get(rootId)
      const reconciledPlanObservations = executionStore.reconcilePlanObservationsInTransaction({
        session_id: context.session_id,
        turn_id: turnId,
        task_id: rootId,
        revision: finalRoot.revision,
        reconciled_at: timestamp,
      })
      const children = selectVisibleChildren.all(rootId)
      return {
        root: finalRoot,
        children,
        focused_task: focusedTask,
        progress: taskProgress(finalRoot, children),
        bound_execution: focusResult?.execution ?? null,
        reconciled_plan_observations: reconciledPlanObservations,
        changed: taskChanged
          || Boolean(focusResult?.changed)
          || reconciledPlanObservations.length > 0,
      }
    })
  }

  function updateStatus(input) {
    const id = normalizeId(input.id)
    const status = normalizeStatus(input.status)
    const expectedUpdatedAt = normalizeExpectedUpdatedAt(input.expected_updated_at)
    const actor = normalizeEventActor(input.actor ?? 'user')
    const sourceSessionId = optionalString(
      input.source_session_id ?? input.session_id,
      'source_session_id',
    )

    return runTransaction(db, () => {
      const existing = selectTask.get(id)
      if (!existing) fail('TASK_NOT_FOUND', `task ${id} does not exist`, { id })
      if (existing.updated_at !== expectedUpdatedAt) {
        fail('TASK_VERSION_CONFLICT', `task ${id} was updated`, {
          id,
          expected_updated_at: expectedUpdatedAt,
          actual_updated_at: existing.updated_at,
        })
      }
      if (existing.status === status) {
        return { task: existing, affected_parent: null, changed: false }
      }

      const children = selectChildren.all(id)
      if (status === 'done') {
        const incomplete = children.filter((child) => (
          child.deleted_at === null && !['done', 'canceled'].includes(child.status)
        ))
        if (incomplete.length > 0) {
          fail('CHILD_TASKS_INCOMPLETE', 'all child tasks must be done first', {
            id,
            child_ids: incomplete.map((child) => child.id),
          })
        }
      }

      const timestamp = nextUpdatedAt(clock, existing.updated_at)
      updateTaskStatus.run(
        status,
        status === 'done' ? existing.completed_at ?? timestamp : null,
        timestamp,
        id,
      )
      const updated = selectTask.get(id)
      writeTaskEvents({
        before: existing,
        after: updated,
        actor,
        sourceSessionId,
        timestamp,
      })

      let affectedParent = null
      if (existing.status === 'done' && status !== 'done' && existing.parent_id !== null) {
        const parent = selectTask.get(existing.parent_id)
        if (parent?.status === 'done') {
          const parentTimestamp = Date.parse(timestamp) > Date.parse(parent.updated_at)
            ? timestamp
            : new Date(Date.parse(parent.updated_at) + 1).toISOString()
          updateTaskStatus.run('active', null, parentTimestamp, parent.id)
          writeTaskEvents({
            before: parent,
            after: selectTask.get(parent.id),
            actor,
            sourceSessionId,
            timestamp: parentTimestamp,
          })
        }
      }
      if (existing.parent_id !== null) {
        const parent = selectTask.get(existing.parent_id)
        incrementTreeRevision.run(nextUpdatedAt(clock, parent.updated_at), parent.id)
        affectedParent = selectTask.get(parent.id)
      }
      return { task: updated, affected_parent: affectedParent, changed: true }
    })
  }

  function list(filters = {}) {
    const deleted = filters.deleted === true || filters.deleted === 'true'
    const clauses = [deleted
      ? 't.deleted_at IS NOT NULL'
      : `t.deleted_at IS NULL AND (
          t.parent_id IS NULL OR EXISTS (
            SELECT 1 FROM tasks visible_parent
            WHERE visible_parent.id = t.parent_id AND visible_parent.deleted_at IS NULL
          )
        )`]
    const parameters = []
    for (const [field, value] of [
      ['project', filters.project],
      ['status', filters.status],
    ]) {
      if (value !== undefined) {
        clauses.push(`t.${field} = ?`)
        parameters.push(value)
      }
    }
    for (const [field, value] of [
      ['workfolder', filters.workfolder],
      ['branch', filters.branch],
    ]) {
      if (value !== undefined) {
        clauses.push(`EXISTS (
          SELECT 1 FROM task_sessions s
          WHERE s.task_id = t.id AND s.${field} = ?
        )`)
        parameters.push(value)
      }
    }

    const where = clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`
    return db.prepare(`
      SELECT t.* FROM tasks t
      ${where}
      ORDER BY
        t.project COLLATE NOCASE,
        COALESCE(t.parent_id, t.id),
        CASE WHEN t.parent_id IS NULL THEN 0 ELSE 1 END,
        t.start_date,
        t.id
    `).all(...parameters)
  }

  function context(input = {}) {
    const sessionId = input.session_id ?? input.sessionId ?? null
    const workfolder = input.workfolder ?? null
    const worktree = input.worktree ?? input.gitContext?.worktree ?? null
    const branch = input.branch ?? input.gitContext?.branch ?? null
    const tasks = list().filter((task) => task.status !== 'done')
    const candidates = []

    for (const task of tasks) {
      const sessions = selectSessions.all(task.id)
      const matches = {
        session_id: Boolean(sessionId && sessions.some((item) => item.session_id === sessionId)),
        workfolder: Boolean(workfolder && sessions.some((item) => item.workfolder === workfolder)),
        worktree: Boolean(worktree && sessions.some((item) => item.worktree === worktree)),
        branch: Boolean(branch && sessions.some((item) => item.branch === branch)),
      }
      const matchReasons = Object.entries(matches)
        .filter(([, matched]) => matched)
        .map(([reason]) => reason)
      if (matchReasons.length === 0) continue
      const score = (matches.session_id ? 8 : 0)
        + (matches.workfolder ? 4 : 0)
        + (matches.worktree ? 2 : 0)
        + (matches.branch ? 1 : 0)
      candidates.push({ task, sessions, match_reasons: matchReasons, score })
    }

    candidates.sort((left, right) => right.score - left.score || left.task.id.localeCompare(right.task.id))
    return { candidates }
  }

  function snapshot() {
    const taskExecutionAggregates = db.prepare(`
      WITH ranked AS (
        SELECT
          task_id,
          session_id,
          agent_type,
          workfolder,
          git_root,
          worktree,
          branch,
          last_seen_at,
          status,
          kind,
          agent_id,
          id,
          ROW_NUMBER() OVER (
            PARTITION BY task_id
            ORDER BY last_seen_at DESC, started_at DESC, id DESC
          ) AS recency
        FROM task_executions
        WHERE task_id IS NOT NULL
      )
      SELECT
        task_id,
        COUNT(*) AS execution_count,
        SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active_execution_count,
        COUNT(DISTINCT CASE
          WHEN status = 'active'
          THEN COALESCE(agent_id, CASE WHEN kind = 'main' THEN 'main:' || session_id ELSE 'execution:' || id END)
        END) AS active_agent_count,
        MAX(CASE WHEN recency = 1 THEN session_id END) AS recent_session_id,
        MAX(CASE WHEN recency = 1 THEN agent_type END) AS recent_agent_type,
        MAX(CASE WHEN recency = 1 THEN workfolder END) AS recent_workfolder,
        MAX(CASE WHEN recency = 1 THEN git_root END) AS recent_git_root,
        MAX(CASE WHEN recency = 1 THEN worktree END) AS recent_worktree,
        MAX(CASE WHEN recency = 1 THEN branch END) AS recent_branch,
        MAX(CASE WHEN recency = 1 THEN last_seen_at END) AS recent_last_seen_at
      FROM ranked
      GROUP BY task_id
      ORDER BY task_id
    `).all().map((row) => ({
      task_id: row.task_id,
      execution_count: row.execution_count,
      active_execution_count: row.active_execution_count,
      active_agent_count: row.active_agent_count,
      recent_execution: {
        session_id: row.recent_session_id,
        agent_type: row.recent_agent_type,
        workfolder: row.recent_workfolder,
        git_root: row.recent_git_root,
        worktree: row.recent_worktree,
        branch: row.recent_branch,
        last_seen_at: row.recent_last_seen_at,
      },
    }))
    const { count: unassignedExecutionCount } = db.prepare(`
      SELECT COUNT(*) AS count FROM task_executions
      WHERE task_id IS NULL AND classification != 'non_work'
    `).get()
    return {
      tasks: list(),
      sessions: db.prepare(`
        SELECT * FROM task_sessions
        ORDER BY task_id, first_seen_at, session_id
      `).all(),
      task_execution_aggregates: taskExecutionAggregates,
      unassigned_execution_count: unassignedExecutionCount,
    }
  }

  function check() {
    return {
      schemaVersion: db.prepare('PRAGMA user_version').get().user_version,
      integrityCheck: db.prepare('PRAGMA integrity_check').get().integrity_check,
      foreignKeyViolations: db.prepare('PRAGMA foreign_key_check').all(),
    }
  }

  return {
    context,
    list,
    show,
    snapshot,
    heartbeat,
    upsert,
    complete,
    updateTask: updateTaskMetadata,
    archiveTask: (input) => mutateTaskLifecycle(input, 'archive'),
    deleteTask: (input) => mutateTaskLifecycle(input, 'delete'),
    restoreTask: (input) => mutateTaskLifecycle(input, 'restore'),
    taskEvents,
    syncTree,
    sessionStart: executionStore.sessionStart,
    turnStart: executionStore.turnStart,
    focusExecution: executionStore.focusExecution,
    subagentStart: executionStore.subagentStart,
    subagentStop: executionStore.subagentStop,
    sessionEnd: executionStore.sessionEnd,
    toolUse: executionStore.toolUse,
    assignExecution: executionStore.assignExecution,
    classifyExecution: executionStore.classifyExecution,
    updateExecutionAssignments: executionStore.updateExecutionAssignments,
    importExecutions: executionStore.importExecutions,
    listExecutions: executionStore.listExecutions,
    listPlanObservations: executionStore.listPlanObservations,
    sessionContext: executionStore.sessionContext,
    updateStatus,
    check,
    close: () => db.close(),
  }
}
