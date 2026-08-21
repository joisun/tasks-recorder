import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { TaskRecorderError } from './errors.mjs'
import { createProjectStore } from './project-store.mjs'
import { checkSchemaV3Invariants, createSchemaV3, SCHEMA_V3 } from './schema-v3.mjs'
import { createV3TaskStore } from './v3-task-store.mjs'
import { createWorkStore } from './work-store.mjs'

function transaction(db, operation) {
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

function createNestedTransaction(db) {
  let depth = 0
  return (operation) => {
    if (depth > 0) return operation()
    db.exec('BEGIN IMMEDIATE')
    depth += 1
    try {
      const result = operation()
      db.exec('COMMIT')
      return result
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    } finally {
      depth -= 1
    }
  }
}

function initializeJournalSchema(db) {
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA busy_timeout = 5000')
  db.exec('PRAGMA journal_mode = WAL')
  const version = db.prepare('PRAGMA user_version').get().user_version
  if (version === 0) {
    transaction(db, () => createSchemaV3(db))
    return
  }
  if (version === SCHEMA_V3) return
  if (version === 1 || version === 2) {
    throw new TaskRecorderError(
      'SCHEMA_MIGRATION_REQUIRED',
      `database schema version ${version} must be explicitly migrated to version ${SCHEMA_V3}`,
      { expected: SCHEMA_V3, actual: version },
    )
  }
  throw new TaskRecorderError(
    'SCHEMA_VERSION_UNSUPPORTED',
    `database schema version ${version} is unsupported`,
    { expected: SCHEMA_V3, actual: version },
  )
}

export function createJournalStore({ databasePath, clock = () => new Date() } = {}) {
  if (typeof databasePath !== 'string' || databasePath.trim() === '') {
    throw new TypeError('databasePath must be a non-empty string')
  }
  mkdirSync(dirname(databasePath), { recursive: true })
  const db = new DatabaseSync(databasePath)
  try {
    initializeJournalSchema(db)
  } catch (error) {
    db.close()
    throw error
  }
  const transact = createNestedTransaction(db)
  const projects = createProjectStore({ db, clock, transact })
  const tasks = createV3TaskStore({ db, clock, transact })
  const work = createWorkStore({ db, clock, transact })

  function snapshot() {
    const segments = db.prepare(`
      SELECT
        segment.*,
        attribution.id AS attribution_id,
        attribution.task_id AS task_id,
        attribution.provenance AS attribution_provenance
      FROM work_segments segment
      LEFT JOIN segment_attributions attribution
        ON attribution.segment_id = segment.id
       AND attribution.accepted_at IS NOT NULL
       AND attribution.rejected_at IS NULL
       AND attribution.superseded_at IS NULL
      ORDER BY segment.started_at, segment.id
    `).all()
    return {
      projects: db.prepare(`
        SELECT * FROM projects WHERE archived_at IS NULL ORDER BY name COLLATE NOCASE, id
      `).all(),
      project_locations: db.prepare(`
        SELECT * FROM project_locations ORDER BY project_id, kind, normalized_value
      `).all(),
      tasks: tasks.list(),
      observations: db.prepare(`
        SELECT * FROM observations ORDER BY observed_at, id
      `).all(),
      source_sessions: db.prepare(`
        SELECT * FROM source_sessions ORDER BY first_seen_at, id
      `).all(),
      executions: db.prepare(`
        SELECT * FROM executions ORDER BY started_at, id
      `).all(),
      segments,
      project_inbox_count: db.prepare(`
        SELECT COUNT(*) AS count FROM source_sessions WHERE project_id IS NULL
      `).get().count,
      attribution_inbox_count: db.prepare(`
        SELECT COUNT(*) AS count
        FROM work_segments segment
        JOIN executions execution ON execution.id = segment.execution_id
        WHERE execution.classification != 'non_work'
          AND NOT EXISTS (
            SELECT 1 FROM segment_attributions attribution
            WHERE attribution.segment_id = segment.id
              AND attribution.accepted_at IS NOT NULL
              AND attribution.rejected_at IS NULL
              AND attribution.superseded_at IS NULL
          )
      `).get().count,
    }
  }

  function check() {
    const invariants = checkSchemaV3Invariants(db)
    return {
      schemaVersion: db.prepare('PRAGMA user_version').get().user_version,
      ...invariants,
    }
  }

  function probeWritable() {
    try {
      transact(() => true)
      return true
    } catch {
      return false
    }
  }

  return {
    projects,
    tasks,
    work,
    transaction: transact,
    snapshot,
    check,
    probeWritable,
    close: () => db.close(),
  }
}
