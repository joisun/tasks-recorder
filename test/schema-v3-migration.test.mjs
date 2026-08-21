import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import {
  applyV2ToV3,
  inspectV2Migration,
  inspectV2MigrationPath,
  migrationCliReport,
} from '../mcp/src/schema-migration.mjs'
import { createTaskStore } from '../mcp/src/task-store.mjs'
import { taskInput, temporaryStore } from './helpers.mjs'

function rowCounts(db) {
  return Object.fromEntries([
    'tasks',
    'task_sessions',
    'task_executions',
    'task_events',
    'plan_observations',
  ].map((table) => [table, db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count]))
}

test('v2 migration inventory splits same-branch repositories and performs zero writes', async () => {
  const fixture = await temporaryStore({
    clock: () => new Date('2026-08-19T01:00:00.000Z'),
  })
  let db
  try {
    fixture.store.upsert(taskInput({
      id: 'task-a',
      title: 'Task A',
      project: 'Shared',
      session_id: 'session-a',
      workfolder: '/repo/a',
      git_root: '/repo/a',
      worktree: '/repo/a/.worktree/feature-a',
      branch: 'main',
    }))
    fixture.store.upsert(taskInput({
      id: 'task-b',
      title: 'Task B',
      project: 'Shared',
      session_id: 'session-b',
      workfolder: '/repo/b',
      git_root: '/repo/b',
      worktree: '/repo/b/.worktree/feature-b',
      branch: 'main',
    }))
    fixture.store.upsert(taskInput({
      id: 'loose-task',
      title: 'Loose task',
      project: 'Loose',
      session_id: 'loose-session',
      workfolder: '/temporary/location',
      branch: 'main',
    }))
    fixture.store.turnStart({
      external_key: 'codex:turn:session-a:turn-1:0',
      root_session_id: 'session-a',
      session_id: 'session-a',
      turn_id: 'turn-1',
      agent_type: 'Codex',
      workfolder: '/repo/a',
      git_root: '/repo/a',
      worktree: '/repo/a/.worktree/feature-a',
      branch: 'main',
    })
    fixture.store.focusExecution({
      root_session_id: 'session-a',
      session_id: 'session-a',
      turn_id: 'turn-1',
      task_id: 'task-a',
    })
    fixture.store.turnStart({
      external_key: 'codex:turn:unassigned:turn-2:0',
      root_session_id: 'unassigned',
      session_id: 'unassigned',
      turn_id: 'turn-2',
      agent_type: 'Codex',
      workfolder: '/unknown',
      branch: 'main',
    })

    db = new DatabaseSync(fixture.databasePath)
    db.prepare('DELETE FROM task_sessions WHERE task_id = ?').run('loose-task')
    const before = {
      version: db.prepare('PRAGMA user_version').get().user_version,
      rows: rowCounts(db),
    }

    const report = inspectV2Migration(db)

    assert.deepEqual(report.legacy, {
      schema_version: 2,
      task_count: 3,
      execution_count: 2,
      bound_execution_count: 1,
      unassigned_execution_count: 1,
    })
    assert.deepEqual(
      report.projects.map(({ name, evidence, task_ids, ambiguous }) => ({
        name, evidence, task_ids, ambiguous,
      })),
      [
        {
          name: 'Loose',
          evidence: [],
          task_ids: ['loose-task'],
          ambiguous: true,
        },
        {
          name: 'Shared',
          evidence: [{ kind: 'git_root', value: '/repo/a' }],
          task_ids: ['task-a'],
          ambiguous: false,
        },
        {
          name: 'Shared',
          evidence: [{ kind: 'git_root', value: '/repo/b' }],
          task_ids: ['task-b'],
          ambiguous: false,
        },
      ],
    )
    assert.deepEqual(report.ambiguities, [{
      code: 'PROJECT_LOCATION_MISSING',
      legacy_project: 'Loose',
      task_ids: ['loose-task'],
    }])
    assert.equal(new Set(report.projects.map(({ project_id: projectId }) => projectId)).size, 3)
    assert.deepEqual({
      version: db.prepare('PRAGMA user_version').get().user_version,
      rows: rowCounts(db),
    }, before)
  } finally {
    db?.close()
    await fixture.cleanup()
  }
})

test('v2 migration inventory rejects non-v2 databases without modifying them', () => {
  const db = new DatabaseSync(':memory:')
  try {
    assert.throws(
      () => inspectV2Migration(db),
      (error) => error.code === 'SCHEMA_MIGRATION_SOURCE_UNSUPPORTED'
        && error.details.actual === 0,
    )
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 0)
  } finally {
    db.close()
  }
})

test('path migration dry-run opens read-only and returns a privacy-bounded CLI report', async () => {
  const fixture = await temporaryStore()
  let db
  try {
    fixture.store.upsert(taskInput({
      id: 'private-task-id',
      title: 'Private task title',
      project: 'Private project',
      session_id: 'private-session-id',
      workfolder: '/private/repository',
      git_root: '/private/repository',
    }))
    db = new DatabaseSync(fixture.databasePath)
    const before = {
      version: db.prepare('PRAGMA user_version').get().user_version,
      counts: rowCounts(db),
    }
    db.close()
    db = null

    const report = await inspectV2MigrationPath(fixture.databasePath)
    const summary = migrationCliReport(report, { dryRun: true })

    assert.deepEqual(summary, {
      dry_run: true,
      source_schema_version: 2,
      target_schema_version: 3,
      legacy: {
        schema_version: 2,
        task_count: 1,
        execution_count: 0,
        bound_execution_count: 0,
        unassigned_execution_count: 0,
      },
      plan: {
        project_count: 1,
        ambiguous_project_count: 0,
        ambiguity_count: 0,
        ambiguity_codes: {},
      },
    })
    assert.doesNotMatch(JSON.stringify(summary), /Private|private-|\/private\//)

    db = new DatabaseSync(fixture.databasePath)
    assert.deepEqual({
      version: db.prepare('PRAGMA user_version').get().user_version,
      counts: rowCounts(db),
    }, before)
  } finally {
    db?.close()
    await fixture.cleanup()
  }
})

test('v2 migration keeps conflicting project labels provisional for one exact location', async () => {
  const fixture = await temporaryStore()
  let db
  try {
    fixture.store.upsert(taskInput({
      id: 'project-one-task',
      title: 'Project one',
      project: 'Project One',
      session_id: 'session-one',
      workfolder: '/repo/shared',
      git_root: '/repo/shared',
    }))
    fixture.store.upsert(taskInput({
      id: 'project-two-task',
      title: 'Project two',
      project: 'Project Two',
      session_id: 'session-two',
      workfolder: '/repo/shared',
      git_root: '/repo/shared',
    }))
    db = new DatabaseSync(fixture.databasePath)

    const report = inspectV2Migration(db)

    assert.deepEqual(report.projects.map(({ name, ambiguous }) => ({ name, ambiguous })), [
      { name: 'Project One', ambiguous: true },
      { name: 'Project Two', ambiguous: true },
    ])
    assert.deepEqual(report.ambiguities, [{
      code: 'PROJECT_LOCATION_COLLISION',
      evidence: { kind: 'git_root', value: '/repo/shared' },
      legacy_projects: ['Project One', 'Project Two'],
      task_ids: ['project-one-task', 'project-two-task'],
    }])
  } finally {
    db?.close()
    await fixture.cleanup()
  }
})

test('v2 migration rejects a backup path that canonically resolves to the source', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tasks-recorder-v3-same-backup-'))
  const databasePath = join(directory, 'tasks.sqlite')
  try {
    const store = createTaskStore({ databasePath })
    store.close()
    await assert.rejects(
      () => applyV2ToV3({
        databasePath,
        backupPath: join(directory, 'nested', '..', 'tasks.sqlite'),
      }),
      (error) => error.code === 'SCHEMA_MIGRATION_BACKUP_INVALID',
    )
    const db = new DatabaseSync(databasePath, { readOnly: true })
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 2)
    db.close()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('v2 migration backs up then preserves tasks and bound execution facts in schema v3', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tasks-recorder-v3-apply-'))
  const databasePath = join(directory, 'tasks.sqlite')
  const backupPath = join(directory, 'tasks.v2.backup.sqlite')
  let db
  try {
    const store = createTaskStore({
      databasePath,
      clock: () => new Date('2026-08-19T02:00:00.000Z'),
    })
    store.upsert(taskInput({
      id: 'main-task',
      title: 'Main task',
      project: 'Example',
      session_id: 'session-1',
      workfolder: '/repo/example',
      git_root: '/repo/example',
      worktree: '/repo/example/.worktree/feature-a',
      branch: 'feature/a',
    }))
    store.upsert(taskInput({
      id: 'child-task',
      parent_id: 'main-task',
      title: 'Child task',
      project: 'Example',
      status: 'done',
      session_id: 'session-1',
      workfolder: '/repo/example',
      git_root: '/repo/example',
      worktree: '/repo/example/.worktree/feature-a',
      branch: 'feature/a',
    }))
    store.turnStart({
      external_key: 'codex:turn:session-1:turn-1:0',
      root_session_id: 'session-1',
      session_id: 'session-1',
      turn_id: 'turn-1',
      agent_type: 'Codex',
      workfolder: '/repo/example',
      git_root: '/repo/example',
      worktree: '/repo/example/.worktree/feature-a',
      branch: 'feature/a',
    })
    store.focusExecution({
      root_session_id: 'session-1',
      session_id: 'session-1',
      turn_id: 'turn-1',
      task_id: 'main-task',
    })
    store.close()

    const report = await applyV2ToV3({
      databasePath,
      backupPath,
      clock: () => new Date('2026-08-19T03:00:00.000Z'),
    })

    assert.match(report.backup.sha256, /^[a-f0-9]{64}$/)
    assert.equal(report.backup.schema_version, 2)
    assert.deepEqual(report.migrated, {
      project_count: 1,
      task_count: 2,
      execution_count: 1,
      segment_count: 1,
      accepted_attribution_count: 1,
    })
    assert.deepEqual(report.invariants, {
      integrityCheck: 'ok',
      foreignKeyViolations: [],
      invariantViolations: [],
    })

    const backup = new DatabaseSync(backupPath, { readOnly: true })
    assert.equal(backup.prepare('PRAGMA user_version').get().user_version, 2)
    assert.equal(backup.prepare('SELECT COUNT(*) AS count FROM tasks').get().count, 2)
    backup.close()

    db = new DatabaseSync(databasePath)
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 3)
    assert.deepEqual(db.prepare(`
      SELECT id, parent_id, lifecycle FROM tasks ORDER BY id
    `).all().map((row) => ({ ...row })), [
      { id: 'child-task', parent_id: 'main-task', lifecycle: 'done' },
      { id: 'main-task', parent_id: null, lifecycle: 'in_progress' },
    ])
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM work_segments').get().count, 1)
    assert.deepEqual({ ...db.prepare(`
      SELECT task_id, provenance, rationale_code
      FROM segment_attributions
    `).get() }, {
      task_id: 'main-task',
      provenance: 'migration',
      rationale_code: 'legacy_direct_task_binding',
    })
  } finally {
    db?.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('v2 migration rolls back the source database when transformed rows violate v3', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tasks-recorder-v3-rollback-'))
  const databasePath = join(directory, 'tasks.sqlite')
  const backupPath = join(directory, 'tasks.v2.backup.sqlite')
  let db
  try {
    const store = createTaskStore({ databasePath })
    store.upsert(taskInput({ id: 'main-task', title: 'Main task' }))
    store.close()
    db = new DatabaseSync(databasePath)
    db.prepare(`
      INSERT INTO task_events (
        id, task_id, event_type, before_json, after_json, actor, source_session_id, created_at
      ) VALUES (
        'invalid-event', 'main-task', 'updated', 'not-json', '{}', 'agent', 'session-1',
        '2026-08-19T00:00:00.000Z'
      )
    `).run()
    db.close()
    db = null

    await assert.rejects(
      () => applyV2ToV3({ databasePath, backupPath }),
      /CHECK constraint failed/,
    )

    db = new DatabaseSync(databasePath)
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 2)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM tasks').get().count, 1)
    assert.equal(db.prepare('SELECT before_json FROM task_events WHERE id = ?').get('invalid-event').before_json, 'not-json')
    const backup = new DatabaseSync(backupPath, { readOnly: true })
    assert.equal(backup.prepare('PRAGMA user_version').get().user_version, 2)
    backup.close()
  } finally {
    db?.close()
    await rm(directory, { recursive: true, force: true })
  }
})
