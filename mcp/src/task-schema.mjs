import { TaskRecorderError } from './errors.mjs'

export const SCHEMA_VERSION = 2

function fail(code, message, details) {
  throw new TaskRecorderError(code, message, details)
}

function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some(({ name }) => name === column)
}

function createTaskTable(db, name = 'tasks') {
  db.exec(`
    CREATE TABLE ${name} (
      id TEXT PRIMARY KEY,
      parent_id TEXT REFERENCES tasks(id),
      project TEXT NOT NULL DEFAULT '独立任务',
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL CHECK(status IN ('planned', 'active', 'waiting', 'blocked', 'done', 'canceled')),
      start_date TEXT NOT NULL,
      due_date TEXT,
      next_action TEXT,
      agent_key TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0 CHECK(sort_order >= 0),
      revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
      completed_at TEXT,
      archived_at TEXT,
      deleted_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
  `)
}

function createLifecycleTables(db) {
  db.exec(`
    CREATE TABLE task_executions (
      id TEXT PRIMARY KEY,
      external_key TEXT NOT NULL UNIQUE,
      task_id TEXT REFERENCES tasks(id),
      kind TEXT NOT NULL CHECK(kind IN ('main', 'subagent')),
      root_session_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      turn_id TEXT,
      agent_id TEXT,
      agent_type TEXT,
      agent_path TEXT,
      parent_execution_id TEXT REFERENCES task_executions(id),
      transcript_path TEXT,
      classification TEXT NOT NULL DEFAULT 'unknown'
        CHECK(classification IN ('unknown', 'work', 'non_work')),
      workfolder TEXT NOT NULL,
      git_root TEXT,
      worktree TEXT,
      branch TEXT,
      status TEXT NOT NULL CHECK(status IN ('active', 'completed', 'interrupted', 'unknown')),
      started_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      ended_at TEXT
    ) STRICT;

    CREATE TABLE task_events (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id),
      event_type TEXT NOT NULL,
      before_json TEXT,
      after_json TEXT,
      actor TEXT NOT NULL CHECK(actor IN ('agent', 'user', 'hook', 'importer')),
      source_session_id TEXT,
      created_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE plan_observations (
      external_key TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      plan_json TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      reconciled_task_id TEXT REFERENCES tasks(id),
      reconciled_revision INTEGER,
      reconciled_at TEXT
    ) STRICT;
  `)
}

function createIndexes(db) {
  db.exec(`
    CREATE INDEX IF NOT EXISTS task_sessions_session_id_idx ON task_sessions(session_id);
    CREATE INDEX IF NOT EXISTS task_sessions_workfolder_idx ON task_sessions(workfolder);
    CREATE INDEX IF NOT EXISTS task_sessions_worktree_idx ON task_sessions(worktree);
    CREATE INDEX IF NOT EXISTS task_sessions_branch_idx ON task_sessions(branch);
    CREATE INDEX IF NOT EXISTS tasks_parent_id_idx ON tasks(parent_id);
    CREATE INDEX IF NOT EXISTS tasks_project_status_idx ON tasks(project, status);
    CREATE INDEX IF NOT EXISTS task_executions_task_id_idx ON task_executions(task_id);
    CREATE INDEX IF NOT EXISTS task_executions_root_session_idx
      ON task_executions(root_session_id, started_at);
    CREATE INDEX IF NOT EXISTS task_executions_session_idx
      ON task_executions(session_id, started_at);
    CREATE INDEX IF NOT EXISTS task_executions_unassigned_idx
      ON task_executions(classification, task_id, started_at);
    CREATE INDEX IF NOT EXISTS task_events_task_created_idx
      ON task_events(task_id, created_at);
    CREATE INDEX IF NOT EXISTS plan_observations_session_turn_idx
      ON plan_observations(session_id, turn_id, observed_at);
  `)
}

function createFreshSchema(db) {
  db.exec('BEGIN IMMEDIATE')
  try {
    const { user_version: lockedVersion } = db.prepare('PRAGMA user_version').get()
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
    createTaskTable(db)
    db.exec(`
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
    `)
    createLifecycleTables(db)
    createIndexes(db)
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

function migrateV1ToV2(db) {
  db.exec('PRAGMA foreign_keys = OFF')
  db.exec('BEGIN IMMEDIATE')
  try {
    const { user_version: lockedVersion } = db.prepare('PRAGMA user_version').get()
    if (lockedVersion === SCHEMA_VERSION) {
      db.exec('COMMIT')
      return
    }
    if (lockedVersion !== 1) {
      fail(
        'SCHEMA_VERSION_UNSUPPORTED',
        `database schema version ${lockedVersion} is unsupported`,
        { expected: SCHEMA_VERSION, actual: lockedVersion },
      )
    }
    createTaskTable(db, 'tasks_v2')
    db.exec(`
      INSERT INTO tasks_v2 (
        id, parent_id, project, title, status, start_date, due_date, next_action,
        completed_at, created_at, updated_at
      )
      SELECT
        id, parent_id, project, title, status, start_date, due_date, next_action,
        completed_at, created_at, updated_at
      FROM tasks;
      DROP TABLE tasks;
      ALTER TABLE tasks_v2 RENAME TO tasks;
    `)
    if (!hasColumn(db, 'task_sessions', 'agent')) {
      db.exec('ALTER TABLE task_sessions ADD COLUMN agent TEXT')
    }
    createLifecycleTables(db)
    createIndexes(db)
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  } finally {
    db.exec('PRAGMA foreign_keys = ON')
  }

  const violations = db.prepare('PRAGMA foreign_key_check').all()
  if (violations.length > 0) {
    fail('SCHEMA_MIGRATION_INVALID', 'database migration introduced foreign key violations', {
      violations,
    })
  }
}

export function initializeTaskSchema(db) {
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA busy_timeout = 5000')
  db.exec('PRAGMA journal_mode = WAL')

  const { user_version: version } = db.prepare('PRAGMA user_version').get()
  if (version === 0) {
    createFreshSchema(db)
    return
  }
  if (version === 1) {
    migrateV1ToV2(db)
    return
  }
  if (version !== SCHEMA_VERSION) {
    fail(
      'SCHEMA_VERSION_UNSUPPORTED',
      `database schema version ${version} is unsupported`,
      { expected: SCHEMA_VERSION, actual: version },
    )
  }
}
