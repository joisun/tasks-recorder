export const SCHEMA_V3 = 3

function createTables(db) {
  db.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL CHECK(length(trim(name)) > 0),
      description TEXT,
      revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
      archived_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE project_locations (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      kind TEXT NOT NULL
        CHECK(kind IN ('git_common_dir', 'workspace', 'git_remote', 'manual')),
      normalized_value TEXT NOT NULL CHECK(length(normalized_value) > 0),
      display_value TEXT,
      last_seen_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(project_id, kind, normalized_value)
    ) STRICT;

    CREATE TABLE source_sessions (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL CHECK(length(trim(source)) > 0),
      external_session_id TEXT NOT NULL CHECK(length(external_session_id) > 0),
      root_external_session_id TEXT,
      project_id TEXT REFERENCES projects(id),
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      UNIQUE(source, external_session_id)
    ) STRICT;

    CREATE TABLE observations (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL CHECK(length(trim(source)) > 0),
      external_event_id TEXT NOT NULL CHECK(length(external_event_id) > 0),
      event_type TEXT NOT NULL CHECK(length(trim(event_type)) > 0),
      observed_at TEXT NOT NULL,
      source_session_id TEXT REFERENCES source_sessions(id),
      source_turn_key TEXT,
      source_agent_key TEXT,
      workfolder TEXT,
      git_root TEXT,
      git_common_dir TEXT,
      git_remote TEXT,
      worktree TEXT,
      branch TEXT,
      payload_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(payload_json)),
      created_at TEXT NOT NULL,
      UNIQUE(source, external_event_id)
    ) STRICT;

    CREATE TABLE executions (
      id TEXT PRIMARY KEY,
      source_session_id TEXT NOT NULL REFERENCES source_sessions(id),
      source_turn_key TEXT,
      source_agent_key TEXT,
      parent_execution_id TEXT REFERENCES executions(id),
      kind TEXT NOT NULL CHECK(kind IN ('main', 'subagent')),
      classification TEXT NOT NULL DEFAULT 'unknown'
        CHECK(classification IN ('unknown', 'work', 'non_work')),
      workfolder TEXT,
      git_root TEXT,
      git_common_dir TEXT,
      git_remote TEXT,
      worktree TEXT,
      branch TEXT,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      last_seen_at TEXT NOT NULL,
      end_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      parent_id TEXT REFERENCES tasks(id),
      title TEXT NOT NULL CHECK(length(trim(title)) > 0),
      description TEXT,
      lifecycle TEXT NOT NULL
        CHECK(lifecycle IN ('planned', 'in_progress', 'waiting', 'blocked', 'done', 'canceled')),
      planned_start_at TEXT,
      planned_due_at TEXT,
      next_action TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0 CHECK(sort_order >= 0),
      revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
      completed_at TEXT,
      archived_at TEXT,
      deleted_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK(parent_id IS NULL OR parent_id != id)
    ) STRICT;

    CREATE TABLE work_segments (
      id TEXT PRIMARY KEY,
      execution_id TEXT NOT NULL REFERENCES executions(id),
      started_at TEXT NOT NULL,
      ended_at TEXT,
      last_seen_at TEXT NOT NULL,
      close_reason TEXT
        CHECK(close_reason IS NULL OR close_reason IN (
          'focus_changed', 'execution_ended', 'manual', 'recovered'
        )),
      summary TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK(ended_at IS NULL OR ended_at >= started_at)
    ) STRICT;

    CREATE TABLE segment_attributions (
      id TEXT PRIMARY KEY,
      segment_id TEXT NOT NULL REFERENCES work_segments(id),
      task_id TEXT NOT NULL REFERENCES tasks(id),
      provenance TEXT NOT NULL CHECK(provenance IN (
        'user', 'agent_explicit', 'spawn_intent', 'current_focus', 'migration', 'suggestion'
      )),
      confidence REAL CHECK(confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
      rationale_code TEXT NOT NULL CHECK(length(trim(rationale_code)) > 0),
      accepted_at TEXT,
      rejected_at TEXT,
      superseded_at TEXT,
      created_at TEXT NOT NULL,
      CHECK(NOT (accepted_at IS NOT NULL AND rejected_at IS NOT NULL))
    ) STRICT;

    CREATE TABLE execution_intents (
      id TEXT PRIMARY KEY,
      source_session_id TEXT NOT NULL REFERENCES source_sessions(id),
      external_agent_key TEXT NOT NULL CHECK(length(external_agent_key) > 0),
      task_id TEXT NOT NULL REFERENCES tasks(id),
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      consumed_at TEXT
    ) STRICT;

    CREATE TABLE task_events (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id),
      event_type TEXT NOT NULL CHECK(length(trim(event_type)) > 0),
      before_json TEXT CHECK(before_json IS NULL OR json_valid(before_json)),
      after_json TEXT CHECK(after_json IS NULL OR json_valid(after_json)),
      actor TEXT NOT NULL CHECK(actor IN ('agent', 'user', 'hook', 'importer')),
      source_session_id TEXT REFERENCES source_sessions(id),
      created_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE plan_observations (
      external_key TEXT PRIMARY KEY,
      source_session_id TEXT NOT NULL REFERENCES source_sessions(id),
      source_turn_key TEXT NOT NULL,
      plan_revision TEXT NOT NULL,
      plan_json TEXT NOT NULL CHECK(json_valid(plan_json)),
      observed_at TEXT NOT NULL,
      reconciled_task_id TEXT REFERENCES tasks(id),
      reconciled_revision INTEGER,
      reconciled_at TEXT,
      UNIQUE(source_session_id, plan_revision)
    ) STRICT;
  `)
}

function createIndexes(db) {
  db.exec(`
    CREATE UNIQUE INDEX project_locations_exact_owner_idx
      ON project_locations(kind, normalized_value)
      WHERE kind IN ('git_common_dir', 'workspace', 'manual');
    CREATE INDEX project_locations_project_idx
      ON project_locations(project_id, kind, last_seen_at);
    CREATE INDEX source_sessions_project_idx
      ON source_sessions(project_id, last_seen_at);
    CREATE INDEX observations_session_time_idx
      ON observations(source_session_id, observed_at);
    CREATE INDEX executions_session_time_idx
      ON executions(source_session_id, started_at);
    CREATE INDEX executions_open_idx
      ON executions(ended_at, last_seen_at)
      WHERE ended_at IS NULL;
    CREATE INDEX tasks_project_tree_idx
      ON tasks(project_id, parent_id, sort_order, id);
    CREATE INDEX tasks_project_lifecycle_idx
      ON tasks(project_id, lifecycle, updated_at);
    CREATE UNIQUE INDEX work_segments_one_open_idx
      ON work_segments(execution_id)
      WHERE ended_at IS NULL;
    CREATE INDEX work_segments_execution_time_idx
      ON work_segments(execution_id, started_at);
    CREATE UNIQUE INDEX segment_attributions_one_accepted_idx
      ON segment_attributions(segment_id)
      WHERE accepted_at IS NOT NULL AND rejected_at IS NULL AND superseded_at IS NULL;
    CREATE INDEX segment_attributions_task_idx
      ON segment_attributions(task_id, accepted_at);
    CREATE UNIQUE INDEX execution_intents_one_pending_idx
      ON execution_intents(source_session_id, external_agent_key)
      WHERE consumed_at IS NULL;
    CREATE INDEX task_events_task_time_idx
      ON task_events(task_id, created_at);
    CREATE INDEX plan_observations_session_time_idx
      ON plan_observations(source_session_id, observed_at);
  `)
}

function createTaskHierarchyTriggers(db) {
  for (const operation of ['INSERT', 'UPDATE OF parent_id, project_id']) {
    const suffix = operation.startsWith('INSERT') ? 'insert' : 'update'
    db.exec(`
      CREATE TRIGGER tasks_parent_exists_${suffix}
      BEFORE ${operation} ON tasks
      WHEN NEW.parent_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM tasks parent WHERE parent.id = NEW.parent_id)
      BEGIN
        SELECT RAISE(ABORT, 'task parent does not exist');
      END;

      CREATE TRIGGER tasks_parent_project_${suffix}
      BEFORE ${operation} ON tasks
      WHEN NEW.parent_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM tasks parent
          WHERE parent.id = NEW.parent_id AND parent.project_id != NEW.project_id
        )
      BEGIN
        SELECT RAISE(ABORT, 'task parent must belong to the same project');
      END;

      CREATE TRIGGER tasks_parent_depth_${suffix}
      BEFORE ${operation} ON tasks
      WHEN NEW.parent_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM tasks parent
          WHERE parent.id = NEW.parent_id AND parent.parent_id IS NOT NULL
        )
      BEGIN
        SELECT RAISE(ABORT, 'task hierarchy supports one subtask level');
      END;
    `)
  }

  db.exec(`
    CREATE TRIGGER tasks_existing_children_depth_update
    BEFORE UPDATE OF parent_id ON tasks
    WHEN NEW.parent_id IS NOT NULL
      AND EXISTS (SELECT 1 FROM tasks child WHERE child.parent_id = NEW.id)
    BEGIN
      SELECT RAISE(ABORT, 'task hierarchy supports one subtask level');
    END;
  `)
}

export function createSchemaV3(db) {
  if (!db || typeof db.exec !== 'function' || typeof db.prepare !== 'function') {
    throw new TypeError('db must be a node:sqlite DatabaseSync')
  }
  const version = db.prepare('PRAGMA user_version').get().user_version
  if (version !== 0) {
    throw new Error(`schema v3 requires an empty version-0 database; received version ${version}`)
  }
  createTables(db)
  createIndexes(db)
  createTaskHierarchyTriggers(db)
  db.exec(`PRAGMA user_version = ${SCHEMA_V3}`)
}

export function checkSchemaV3Invariants(db) {
  const integrityCheck = db.prepare('PRAGMA integrity_check').get().integrity_check
  const foreignKeyViolations = db.prepare('PRAGMA foreign_key_check').all()
  const invariantViolations = [
    ...db.prepare(`
      SELECT 'TASK_PARENT_INVALID' AS code, child.id AS entity_id
      FROM tasks child
      JOIN tasks parent ON parent.id = child.parent_id
      WHERE parent.project_id != child.project_id OR parent.parent_id IS NOT NULL
    `).all(),
    ...db.prepare(`
      SELECT 'EXECUTION_MULTIPLE_OPEN_SEGMENTS' AS code, execution_id AS entity_id
      FROM work_segments
      WHERE ended_at IS NULL
      GROUP BY execution_id
      HAVING COUNT(*) > 1
    `).all(),
    ...db.prepare(`
      SELECT 'SEGMENT_MULTIPLE_ACCEPTED_ATTRIBUTIONS' AS code, segment_id AS entity_id
      FROM segment_attributions
      WHERE accepted_at IS NOT NULL AND rejected_at IS NULL AND superseded_at IS NULL
      GROUP BY segment_id
      HAVING COUNT(*) > 1
    `).all(),
  ]
  return { integrityCheck, foreignKeyViolations, invariantViolations }
}
