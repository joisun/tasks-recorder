import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import {
  SCHEMA_V3,
  checkSchemaV3Invariants,
  createSchemaV3,
} from '../mcp/src/schema-v3.mjs'

function createDatabase() {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  createSchemaV3(db)
  return db
}

function insertProject(db, id) {
  db.prepare(`
    INSERT INTO projects (id, name, created_at, updated_at)
    VALUES (?, ?, '2026-08-19T00:00:00.000Z', '2026-08-19T00:00:00.000Z')
  `).run(id, id)
}

function insertTask(db, { id, projectId, parentId = null, lifecycle = 'in_progress' }) {
  db.prepare(`
    INSERT INTO tasks (
      id, project_id, parent_id, title, lifecycle, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, '2026-08-19T00:00:00.000Z', '2026-08-19T00:00:00.000Z')
  `).run(id, projectId, parentId, id, lifecycle)
}

function insertExecution(db, id = 'execution-1') {
  db.prepare(`
    INSERT INTO source_sessions (
      id, source, external_session_id, first_seen_at, last_seen_at
    ) VALUES (
      'session-1', 'codex', 'external-session-1',
      '2026-08-19T00:00:00.000Z', '2026-08-19T00:00:00.000Z'
    )
  `).run()
  db.prepare(`
    INSERT INTO executions (
      id, source_session_id, kind, started_at, last_seen_at, created_at, updated_at
    ) VALUES (
      ?, 'session-1', 'main',
      '2026-08-19T00:00:00.000Z', '2026-08-19T00:00:00.000Z',
      '2026-08-19T00:00:00.000Z', '2026-08-19T00:00:00.000Z'
    )
  `).run(id)
}

test('creates the complete privacy-bounded schema v3 contract', () => {
  const db = createDatabase()
  try {
    assert.equal(SCHEMA_V3, 3)
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 3)
    const tables = db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `).all().map(({ name }) => name)
    assert.deepEqual(tables, [
      'execution_intents',
      'executions',
      'observations',
      'plan_observations',
      'project_locations',
      'projects',
      'segment_attributions',
      'source_sessions',
      'task_events',
      'tasks',
      'work_segments',
    ])

    const executionColumns = db.prepare('PRAGMA table_info(executions)').all()
      .map(({ name }) => name)
    assert.equal(executionColumns.includes('task_id'), false)
    const taskColumns = db.prepare('PRAGMA table_info(tasks)').all().map(({ name }) => name)
    assert.equal(taskColumns.includes('project_id'), true)
    assert.equal(taskColumns.includes('lifecycle'), true)
    assert.equal(taskColumns.includes('planned_start_at'), true)
    assert.equal(taskColumns.includes('planned_due_at'), true)

    const allColumns = tables.flatMap((table) => (
      db.prepare(`PRAGMA table_info(${table})`).all().map(({ name }) => name)
    ))
    for (const forbidden of ['prompt', 'reasoning', 'tool_input', 'tool_output', 'token', 'secret']) {
      assert.equal(allColumns.includes(forbidden), false)
    }
  } finally {
    db.close()
  }
})

test('stores only the new task lifecycle and enforces one child level within a project', () => {
  const db = createDatabase()
  try {
    insertProject(db, 'project-a')
    insertProject(db, 'project-b')
    insertTask(db, { id: 'main-a', projectId: 'project-a' })
    insertTask(db, { id: 'child-a', projectId: 'project-a', parentId: 'main-a' })

    assert.throws(
      () => insertTask(db, { id: 'legacy-active', projectId: 'project-a', lifecycle: 'active' }),
      /CHECK constraint failed/,
    )
    assert.throws(
      () => insertTask(db, { id: 'cross-project', projectId: 'project-b', parentId: 'main-a' }),
      /task parent must belong to the same project/,
    )
    assert.throws(
      () => insertTask(db, { id: 'grandchild', projectId: 'project-a', parentId: 'child-a' }),
      /task hierarchy supports one subtask level/,
    )
  } finally {
    db.close()
  }
})

test('allows one open segment per execution and one accepted attribution per segment', () => {
  const db = createDatabase()
  try {
    insertProject(db, 'project-a')
    insertTask(db, { id: 'main-a', projectId: 'project-a' })
    insertTask(db, { id: 'main-b', projectId: 'project-a' })
    insertExecution(db)
    db.prepare(`
      INSERT INTO work_segments (id, execution_id, started_at, last_seen_at, created_at, updated_at)
      VALUES (
        'segment-1', 'execution-1', '2026-08-19T00:00:00.000Z',
        '2026-08-19T00:00:00.000Z', '2026-08-19T00:00:00.000Z',
        '2026-08-19T00:00:00.000Z'
      )
    `).run()

    assert.throws(
      () => db.prepare(`
        INSERT INTO work_segments (
          id, execution_id, started_at, last_seen_at, created_at, updated_at
        ) VALUES (
          'segment-2', 'execution-1', '2026-08-19T00:01:00.000Z',
          '2026-08-19T00:01:00.000Z', '2026-08-19T00:01:00.000Z',
          '2026-08-19T00:01:00.000Z'
        )
      `).run(),
      /UNIQUE constraint failed/,
    )

    db.prepare(`
      INSERT INTO segment_attributions (
        id, segment_id, task_id, provenance, rationale_code, accepted_at, created_at
      ) VALUES (
        'attribution-1', 'segment-1', 'main-a', 'agent_explicit', 'focus',
        '2026-08-19T00:00:00.000Z', '2026-08-19T00:00:00.000Z'
      )
    `).run()
    assert.throws(
      () => db.prepare(`
        INSERT INTO segment_attributions (
          id, segment_id, task_id, provenance, rationale_code, accepted_at, created_at
        ) VALUES (
          'attribution-2', 'segment-1', 'main-b', 'current_focus', 'heartbeat',
          '2026-08-19T00:01:00.000Z', '2026-08-19T00:01:00.000Z'
        )
      `).run(),
      /UNIQUE constraint failed/,
    )
  } finally {
    db.close()
  }
})

test('reports schema v3 integrity and domain invariant violations together', () => {
  const db = createDatabase()
  try {
    assert.deepEqual(checkSchemaV3Invariants(db), {
      integrityCheck: 'ok',
      foreignKeyViolations: [],
      invariantViolations: [],
    })
  } finally {
    db.close()
  }
})
