import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { TaskRecorderError } from './errors.mjs'

export const TASK_STATUSES = Object.freeze([
  'planned',
  'active',
  'waiting',
  'blocked',
  'done',
])

const TASK_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const SCHEMA_VERSION = 1

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

function ensureCompatibleColumns(db) {
  const hasAgent = () => db.prepare('PRAGMA table_info(task_sessions)')
    .all()
    .some(({ name }) => name === 'agent')
  if (hasAgent()) return

  db.exec('BEGIN IMMEDIATE')
  try {
    if (!hasAgent()) db.exec('ALTER TABLE task_sessions ADD COLUMN agent TEXT')
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

function initializeSchema(db) {
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA busy_timeout = 5000')
  db.exec('PRAGMA journal_mode = WAL')

  const readSchemaVersion = db.prepare('PRAGMA user_version')
  const { user_version: version } = readSchemaVersion.get()
  if (version !== 0 && version !== SCHEMA_VERSION) {
    fail(
      'SCHEMA_VERSION_UNSUPPORTED',
      `database schema version ${version} is unsupported`,
      { expected: SCHEMA_VERSION, actual: version },
    )
  }
  if (version === SCHEMA_VERSION) {
    ensureCompatibleColumns(db)
    return
  }

  db.exec('BEGIN IMMEDIATE')
  try {
    const { user_version: lockedVersion } = readSchemaVersion.get()
    if (lockedVersion === SCHEMA_VERSION) {
      db.exec('COMMIT')
      return
    }
    if (lockedVersion !== 0) {
      fail(
        'SCHEMA_VERSION_UNSUPPORTED',
        `database schema version ${lockedVersion} is unsupported`,
        { expected: SCHEMA_VERSION, actual: lockedVersion },
      )
    }

    db.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        parent_id TEXT REFERENCES tasks(id),
        project TEXT NOT NULL DEFAULT '独立任务',
        title TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('planned', 'active', 'waiting', 'blocked', 'done')),
        start_date TEXT NOT NULL,
        due_date TEXT,
        next_action TEXT,
        completed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE task_sessions (
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL,
        workfolder TEXT NOT NULL,
        git_root TEXT,
        worktree TEXT,
        branch TEXT,
        agent TEXT,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        PRIMARY KEY(task_id, session_id)
      ) STRICT;

      CREATE INDEX task_sessions_session_id_idx ON task_sessions(session_id);
      CREATE INDEX task_sessions_workfolder_idx ON task_sessions(workfolder);
      CREATE INDEX task_sessions_worktree_idx ON task_sessions(worktree);
      CREATE INDEX task_sessions_branch_idx ON task_sessions(branch);
      CREATE INDEX tasks_parent_id_idx ON tasks(parent_id);
      CREATE INDEX tasks_project_status_idx ON tasks(project, status);

      PRAGMA user_version = 1;
    `)
    db.exec('COMMIT')
    ensureCompatibleColumns(db)
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
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
    initializeSchema(db)
  } catch (error) {
    db.close()
    throw error
  }

  const selectTask = db.prepare('SELECT * FROM tasks WHERE id = ?')
  const selectChildren = db.prepare(`
    SELECT * FROM tasks
    WHERE parent_id = ?
    ORDER BY start_date, id
  `)
  const selectSessions = db.prepare(`
    SELECT * FROM task_sessions
    WHERE task_id = ?
    ORDER BY first_seen_at, session_id
  `)
  const insertTask = db.prepare(`
    INSERT INTO tasks (
      id, parent_id, project, title, status, start_date, due_date,
      next_action, completed_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const updateTask = db.prepare(`
    UPDATE tasks SET
      parent_id = ?, project = ?, title = ?, status = ?, start_date = ?,
      due_date = ?, next_action = ?, completed_at = ?, updated_at = ?
    WHERE id = ?
  `)
  const updateTaskStatus = db.prepare(`
    UPDATE tasks
    SET status = ?, completed_at = ?, updated_at = ?
    WHERE id = ?
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

    return {
      task,
      parent: task.parent_id === null ? null : selectTask.get(task.parent_id) ?? null,
      children: selectChildren.all(normalizedId),
      sessions: selectSessions.all(normalizedId),
    }
  }

  function upsert(input) {
    const id = normalizeId(input.id)
    const context = normalizeContext(input)
    const existing = selectTask.get(id)
    const timestamp = nowIso(clock)
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
    const task = {
      id,
      parent_id: parentId,
      project,
      title: requiredString(input.title, 'title'),
      status,
      start_date: startDate,
      due_date: dueDate,
      next_action: nextAction,
      completed_at: status === 'done' ? existing?.completed_at ?? timestamp : null,
      created_at: existing?.created_at ?? timestamp,
      updated_at: timestamp,
    }

    return runTransaction(db, () => {
      validateHierarchy(task)
      if (existing) {
        updateTask.run(
          task.parent_id,
          task.project,
          task.title,
          task.status,
          task.start_date,
          task.due_date,
          task.next_action,
          task.completed_at,
          task.updated_at,
          task.id,
        )
      } else {
        insertTask.run(
          task.id,
          task.parent_id,
          task.project,
          task.title,
          task.status,
          task.start_date,
          task.due_date,
          task.next_action,
          task.completed_at,
          task.created_at,
          task.updated_at,
        )
      }
      writeSession(id, context, timestamp)
      return { task: selectTask.get(id), session: selectSessions.get(id) }
    })
  }

  function complete(input) {
    const id = normalizeId(input.id)
    const context = normalizeContext(input)
    const existing = selectTask.get(id)
    if (!existing) fail('TASK_NOT_FOUND', `task ${id} does not exist`, { id })
    const timestamp = nowIso(clock)

    return runTransaction(db, () => {
      updateTask.run(
        existing.parent_id,
        existing.project,
        existing.title,
        'done',
        existing.start_date,
        existing.due_date,
        existing.next_action,
        existing.completed_at ?? timestamp,
        timestamp,
        id,
      )
      writeSession(id, context, timestamp)
      return { task: selectTask.get(id), session: selectSessions.get(id) }
    })
  }

  function updateStatus(input) {
    const id = normalizeId(input.id)
    const status = normalizeStatus(input.status)
    const expectedUpdatedAt = normalizeExpectedUpdatedAt(input.expected_updated_at)

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
        const incomplete = children.filter((child) => child.status !== 'done')
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

      let affectedParent = null
      if (existing.status === 'done' && status !== 'done' && existing.parent_id !== null) {
        const parent = selectTask.get(existing.parent_id)
        if (parent?.status === 'done') {
          const parentTimestamp = Date.parse(timestamp) > Date.parse(parent.updated_at)
            ? timestamp
            : new Date(Date.parse(parent.updated_at) + 1).toISOString()
          updateTaskStatus.run('active', null, parentTimestamp, parent.id)
          affectedParent = selectTask.get(parent.id)
        }
      }
      return { task: selectTask.get(id), affected_parent: affectedParent, changed: true }
    })
  }

  function list(filters = {}) {
    const clauses = []
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
    return {
      tasks: list(),
      sessions: db.prepare(`
        SELECT * FROM task_sessions
        ORDER BY task_id, first_seen_at, session_id
      `).all(),
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
    updateStatus,
    check,
    close: () => db.close(),
  }
}
