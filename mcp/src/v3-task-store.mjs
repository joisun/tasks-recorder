import { randomUUID } from 'node:crypto'

import { TaskRecorderError } from './errors.mjs'

export const V3_TASK_LIFECYCLES = Object.freeze([
  'planned',
  'in_progress',
  'waiting',
  'blocked',
  'done',
  'canceled',
])

const TASK_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const EVENT_ACTORS = new Set(['agent', 'user', 'hook', 'importer'])

function fail(code, message, details) {
  throw new TaskRecorderError(code, message, details)
}

function requiredString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    fail('TASK_INPUT_INVALID', `${field} must be a non-empty string`, { field })
  }
  return value.trim()
}

function optionalString(value, field) {
  if (value === null || value === undefined) return null
  return requiredString(value, field)
}

function taskId(value, field = 'id') {
  const id = requiredString(value, field)
  if (!TASK_ID_PATTERN.test(id)) {
    fail('TASK_ID_INVALID', `${field} must use lowercase kebab-case`, { [field]: id })
  }
  return id
}

function lifecycle(value) {
  const normalized = value === 'active' ? 'in_progress' : value
  if (!V3_TASK_LIFECYCLES.includes(normalized)) {
    fail('TASK_STATUS_INVALID', `lifecycle must be one of: ${V3_TASK_LIFECYCLES.join(', ')}`, {
      lifecycle: value,
    })
  }
  return normalized
}

function revision(value) {
  if (!Number.isInteger(value) || value < 1) {
    fail('TASK_INPUT_INVALID', 'expected_revision must be a positive integer', {
      field: 'expected_revision',
    })
  }
  return value
}

function sortOrder(value) {
  if (!Number.isInteger(value) || value < 0) {
    fail('TASK_INPUT_INVALID', 'sort_order must be a non-negative integer', {
      field: 'sort_order',
    })
  }
  return value
}

function instant(value, field) {
  if (value === null || value === undefined) return null
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.valueOf())) {
    fail('TASK_DATE_INVALID', `${field} must be a valid instant`, { field, value })
  }
  return date.toISOString()
}

function nowIso(clock) {
  return instant(clock(), 'clock')
}

function actor(value) {
  const normalized = value ?? 'agent'
  if (!EVENT_ACTORS.has(normalized)) {
    fail('TASK_INPUT_INVALID', 'actor is invalid', { actor: normalized })
  }
  return normalized
}

function defaultTransaction(db, operation) {
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

function progress(children) {
  const included = children.filter(({ lifecycle: value }) => value !== 'canceled')
  const completed = included.filter(({ lifecycle: value }) => value === 'done').length
  const total = included.length
  return {
    completed,
    total,
    remaining: total - completed,
    ratio: total === 0 ? 0 : completed / total,
  }
}

export function createV3TaskStore({ db, clock = () => new Date(), transact } = {}) {
  if (!db || typeof db.prepare !== 'function') {
    throw new TypeError('db must be a node:sqlite DatabaseSync')
  }
  const transaction = transact ?? ((operation) => defaultTransaction(db, operation))
  const selectProject = db.prepare('SELECT * FROM projects WHERE id = ? AND archived_at IS NULL')
  const selectTask = db.prepare('SELECT * FROM tasks WHERE id = ?')
  const selectChildren = db.prepare(`
    SELECT * FROM tasks
    WHERE parent_id = ? AND deleted_at IS NULL
    ORDER BY sort_order, created_at, id
  `)
  const selectEvents = db.prepare(`
    SELECT * FROM task_events WHERE task_id = ? ORDER BY created_at, id
  `)
  const insertTask = db.prepare(`
    INSERT INTO tasks (
      id, project_id, parent_id, title, description, lifecycle,
      planned_start_at, planned_due_at, next_action, sort_order, revision,
      completed_at, archived_at, deleted_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, NULL, NULL, ?, ?)
  `)
  const updateTask = db.prepare(`
    UPDATE tasks SET
      project_id = ?, parent_id = ?, title = ?, description = ?, lifecycle = ?,
      planned_start_at = ?, planned_due_at = ?, next_action = ?, sort_order = ?,
      completed_at = ?, revision = revision + 1, updated_at = ?
    WHERE id = ?
  `)
  const updateTaskVisibility = db.prepare(`
    UPDATE tasks SET
      archived_at = ?, deleted_at = ?, revision = revision + 1, updated_at = ?
    WHERE id = ?
  `)
  const insertEvent = db.prepare(`
    INSERT INTO task_events (
      id, task_id, event_type, before_json, after_json, actor,
      source_session_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `)

  function requireProject(id) {
    const normalized = requiredString(id, 'project_id')
    const project = selectProject.get(normalized)
    if (!project) fail('PROJECT_NOT_FOUND', `project ${normalized} does not exist`, { id: normalized })
    return project
  }

  function requireTask(id) {
    const normalized = taskId(id)
    const task = selectTask.get(normalized)
    if (!task) fail('TASK_NOT_FOUND', `task ${normalized} does not exist`, { id: normalized })
    return task
  }

  function writeEvent({ task, eventType, before, eventActor, sourceSessionId, timestamp }) {
    insertEvent.run(
      randomUUID(),
      task.id,
      eventType,
      before === null ? null : JSON.stringify(before),
      JSON.stringify(task),
      eventActor,
      sourceSessionId,
      timestamp,
    )
  }

  function create(input) {
    const id = taskId(input.id)
    const project = requireProject(input.project_id)
    const parentId = input.parent_id === null || input.parent_id === undefined
      ? null
      : taskId(input.parent_id, 'parent_id')
    const targetLifecycle = lifecycle(input.lifecycle ?? input.status ?? 'planned')
    const timestamp = nowIso(clock)
    const completedAt = targetLifecycle === 'done' ? timestamp : null
    const eventActor = actor(input.actor)
    const sourceSessionId = optionalString(input.source_session_id, 'source_session_id')
    return transaction(() => {
      if (selectTask.get(id)) fail('TASK_EXISTS', `task ${id} already exists`, { id })
      insertTask.run(
        id,
        project.id,
        parentId,
        requiredString(input.title, 'title'),
        optionalString(input.description, 'description'),
        targetLifecycle,
        instant(input.planned_start_at, 'planned_start_at'),
        instant(input.planned_due_at, 'planned_due_at'),
        optionalString(input.next_action, 'next_action'),
        input.sort_order === undefined ? 0 : sortOrder(input.sort_order),
        completedAt,
        timestamp,
        timestamp,
      )
      const task = selectTask.get(id)
      writeEvent({
        task,
        eventType: 'created',
        before: null,
        eventActor,
        sourceSessionId,
        timestamp,
      })
      return { task, changed: true }
    })
  }

  function update(input) {
    const id = taskId(input.id)
    const expectedRevision = revision(input.expected_revision)
    const patch = input.patch
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      fail('TASK_INPUT_INVALID', 'patch must be an object', { field: 'patch' })
    }
    const supported = new Set([
      'project_id',
      'parent_id',
      'title',
      'description',
      'lifecycle',
      'status',
      'planned_start_at',
      'planned_due_at',
      'next_action',
      'sort_order',
    ])
    const unknown = Object.keys(patch).filter((key) => !supported.has(key))
    if (unknown.length > 0) {
      fail('TASK_INPUT_INVALID', 'patch contains unsupported fields', { fields: unknown })
    }
    const eventActor = actor(input.actor)
    const sourceSessionId = optionalString(input.source_session_id, 'source_session_id')
    return transaction(() => {
      const current = requireTask(id)
      if (current.revision !== expectedRevision) {
        fail('TASK_VERSION_CONFLICT', 'task revision does not match', {
          expected_revision: expectedRevision,
          current,
        })
      }
      const projectId = 'project_id' in patch
        ? requireProject(patch.project_id).id
        : current.project_id
      const parentId = 'parent_id' in patch
        ? (patch.parent_id === null ? null : taskId(patch.parent_id, 'parent_id'))
        : current.parent_id
      const targetLifecycle = 'lifecycle' in patch || 'status' in patch
        ? lifecycle(patch.lifecycle ?? patch.status)
        : current.lifecycle
      if (targetLifecycle === 'done') {
        const incomplete = selectChildren.all(id).filter((child) => (
          !['done', 'canceled'].includes(child.lifecycle)
        ))
        if (incomplete.length > 0) {
          fail('CHILD_TASKS_INCOMPLETE', 'all subtasks must be done or canceled first', {
            id,
            child_ids: incomplete.map(({ id: childId }) => childId),
          })
        }
      }
      const next = {
        project_id: projectId,
        parent_id: parentId,
        title: 'title' in patch ? requiredString(patch.title, 'title') : current.title,
        description: 'description' in patch
          ? optionalString(patch.description, 'description')
          : current.description,
        lifecycle: targetLifecycle,
        planned_start_at: 'planned_start_at' in patch
          ? instant(patch.planned_start_at, 'planned_start_at')
          : current.planned_start_at,
        planned_due_at: 'planned_due_at' in patch
          ? instant(patch.planned_due_at, 'planned_due_at')
          : current.planned_due_at,
        next_action: 'next_action' in patch
          ? optionalString(patch.next_action, 'next_action')
          : current.next_action,
        sort_order: 'sort_order' in patch ? sortOrder(patch.sort_order) : current.sort_order,
        completed_at: targetLifecycle === 'done'
          ? current.completed_at ?? nowIso(clock)
          : null,
      }
      const changed = Object.entries(next).some(([key, value]) => current[key] !== value)
      if (!changed) return { task: current, changed: false }
      const timestamp = nowIso(clock)
      updateTask.run(
        next.project_id,
        next.parent_id,
        next.title,
        next.description,
        next.lifecycle,
        next.planned_start_at,
        next.planned_due_at,
        next.next_action,
        next.sort_order,
        next.completed_at,
        timestamp,
        id,
      )
      const task = selectTask.get(id)
      writeEvent({
        task,
        eventType: current.lifecycle === task.lifecycle ? 'updated' : 'lifecycle_changed',
        before: current,
        eventActor,
        sourceSessionId,
        timestamp,
      })
      return { task, changed: true }
    })
  }

  function updateLifecycle(input) {
    return update({
      id: input.id,
      expected_revision: input.expected_revision,
      patch: { lifecycle: input.lifecycle ?? input.status },
      actor: input.actor,
      source_session_id: input.source_session_id,
    })
  }

  function mutateVisibility(input, operation) {
    const id = taskId(input.id)
    const expected = revision(input.expected_revision)
    const eventActor = actor(input.actor ?? 'user')
    const sourceSessionId = optionalString(input.source_session_id, 'source_session_id')
    return transaction(() => {
      const current = requireTask(id)
      if (current.revision !== expected) {
        fail('TASK_VERSION_CONFLICT', 'task revision does not match', {
          expected_revision: expected,
          current,
        })
      }
      if (operation === 'archive' && !['done', 'canceled'].includes(current.lifecycle)) {
        fail('TASK_ARCHIVE_STATUS_INVALID', 'only done or canceled tasks can be archived', {
          id,
          lifecycle: current.lifecycle,
        })
      }
      const timestamp = nowIso(clock)
      const archivedAt = operation === 'archive'
        ? current.archived_at ?? timestamp
        : operation === 'restore' ? null : current.archived_at
      const deletedAt = operation === 'delete'
        ? current.deleted_at ?? timestamp
        : operation === 'restore' ? null : current.deleted_at
      if (archivedAt === current.archived_at && deletedAt === current.deleted_at) {
        return { task: current, changed: false }
      }
      updateTaskVisibility.run(archivedAt, deletedAt, timestamp, id)
      const task = selectTask.get(id)
      writeEvent({
        task,
        eventType: operation === 'delete' ? 'deleted' : `${operation}d`,
        before: current,
        eventActor,
        sourceSessionId,
        timestamp,
      })
      return { task, changed: true }
    })
  }

  function archive(input) {
    return mutateVisibility(input, 'archive')
  }

  function deleteTask(input) {
    return mutateVisibility(input, 'delete')
  }

  function restore(input) {
    return mutateVisibility(input, 'restore')
  }

  function show(id) {
    const task = requireTask(id)
    const children = selectChildren.all(task.id)
    return {
      task,
      parent: task.parent_id === null ? null : selectTask.get(task.parent_id) ?? null,
      children,
      progress: progress(children),
      events: selectEvents.all(task.id),
    }
  }

  function list(filters = {}) {
    const clauses = [filters.deleted === true ? 'deleted_at IS NOT NULL' : 'deleted_at IS NULL']
    const parameters = []
    for (const [field, value] of [
      ['project_id', filters.project_id],
      ['parent_id', filters.parent_id],
      ['lifecycle', filters.lifecycle],
    ]) {
      if (value !== undefined) {
        clauses.push(`${field} ${value === null ? 'IS NULL' : '= ?'}`)
        if (value !== null) parameters.push(value)
      }
    }
    return db.prepare(`
      SELECT * FROM tasks
      WHERE ${clauses.join(' AND ')}
      ORDER BY project_id, COALESCE(parent_id, id),
        CASE WHEN parent_id IS NULL THEN 0 ELSE 1 END, sort_order, id
    `).all(...parameters)
  }

  return { create, update, updateLifecycle, archive, delete: deleteTask, restore, show, list }
}
