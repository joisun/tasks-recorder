import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import { createJournalService } from '../mcp/src/journal-service.mjs'
import { createJournalStore } from '../mcp/src/journal-store.mjs'
import { createV3CompatibilityService } from '../mcp/src/v3-compatibility-service.mjs'
import { createTaskStore } from '../mcp/src/task-store.mjs'
import { startTaskd } from '../server/src/taskd-runtime.mjs'

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'tasks-recorder-v3-compat-'))
  const store = createJournalStore({
    databasePath: join(directory, 'tasks.sqlite'),
    clock: () => new Date('2026-08-20T07:00:00.000Z'),
  })
  const changes = []
  const journal = createJournalService({ store, onChange: (change) => changes.push(change) })
  const service = createV3CompatibilityService({
    store,
    journalService: journal,
    gitResolver: async (workfolder) => ({
      gitRoot: workfolder,
      gitCommonDir: `${workfolder}/.git`,
      gitRemote: null,
      worktree: workfolder,
      branch: 'feature/a',
    }),
    onChange: (change) => changes.push(change),
  })
  store.projects.create({ id: 'project-a', name: 'Project A' })
  store.projects.registerLocation({
    project_id: 'project-a', kind: 'workspace', value: '/workspace/project-a',
  })
  store.tasks.create({
    id: 'task-a', project_id: 'project-a', title: 'Task A', lifecycle: 'in_progress',
  })
  store.tasks.create({
    id: 'task-b', project_id: 'project-a', title: 'Task B', lifecycle: 'planned',
  })
  const started = await journal.ingestEvent({
    source: 'codex',
    event_type: 'execution.started',
    external_event_id: 'session-1:turn-1:start',
    observed_at: '2026-08-20T08:00:00.000Z',
    source_session_key: 'session-1',
    root_session_key: 'session-1',
    source_turn_key: 'turn-1',
    source_agent_key: null,
    workfolder: '/workspace/project-a',
    git_root: '/workspace/project-a',
    git_common_dir: '/workspace/project-a/.git',
    git_remote: null,
    worktree: '/workspace/project-a',
    branch: 'feature/a',
    payload: { kind: 'main' },
  })
  return {
    directory, store, journal, service, changes,
    executionId: started.execution_id,
    async cleanup() {
      store.close()
      await rm(directory, { recursive: true, force: true })
    },
  }
}

test('legacy execution task_id is an explicit lossy projection of the latest accepted Segment', async () => {
  const current = await fixture()
  try {
    await current.journal.focus({
      execution_id: current.executionId, task_id: 'task-a',
      provenance: 'agent_explicit', rationale_code: 'legacy-test',
      observed_at: '2026-08-20T08:01:00.000Z',
    })
    await current.journal.focus({
      execution_id: current.executionId, task_id: 'task-b',
      provenance: 'agent_explicit', rationale_code: 'legacy-test',
      observed_at: '2026-08-20T08:02:00.000Z',
    })
    await current.journal.focus({
      execution_id: current.executionId, task_id: 'task-a',
      provenance: 'agent_explicit', rationale_code: 'legacy-test',
      observed_at: '2026-08-20T08:03:00.000Z',
    })

    const [execution] = await current.service.listExecutions({ root_session_id: 'session-1' })
    assert.equal(execution.task_id, 'task-a')
    assert.equal(execution.compatibility.deprecated, true)
    assert.equal(execution.compatibility.lossy, true)
    assert.equal(execution.compatibility.replacement, 'agent_work_context')
    assert.deepEqual(execution.compatibility.attributed_task_ids, ['task-a', 'task-b'])
    assert.deepEqual(
      (await current.service.listExecutions({ task_id: 'task-b' })).map(({ id }) => id),
      [current.executionId],
    )
    assert.deepEqual(execution.attributed_segments.map(({ task_id: taskId }) => taskId), [
      'task-a', 'task-b', 'task-a',
    ])

    const canonical = current.store.snapshot().executions[0]
    assert.equal(Object.hasOwn(canonical, 'task_id'), false)
  } finally {
    await current.cleanup()
  }
})

test('v3 service serves the canonical Project-first Dashboard projection without legacy round-trip', async () => {
  const current = await fixture()
  try {
    await current.journal.focus({
      execution_id: current.executionId, task_id: 'task-a',
      provenance: 'agent_explicit', rationale_code: 'dashboard-test',
      observed_at: '2026-08-20T08:01:00.000Z',
    })
    const snapshot = await current.service.dashboardSnapshot()
    assert.equal(snapshot.schema_version, 3)
    assert.deepEqual(snapshot.tasks.map(({ id, parent_id }) => [id, parent_id]), [
      ['project:project-a', null],
      ['task-a', 'project:project-a'],
      ['task-b', 'project:project-a'],
    ])
    assert.equal(snapshot.tasks[0].entity_type, 'project')
    assert.equal(snapshot.tasks.find(({ id }) => id === 'task-a').actual_segment_count, 1)
    assert.equal(snapshot.projects[0].name, 'Project A')
    assert.equal('sessions' in snapshot, false)
  } finally {
    await current.cleanup()
  }
})

test('legacy context and sync tree delegate to compact v3 semantics with deprecation metadata', async () => {
  const current = await fixture()
  try {
    const context = await current.service.context({
      session_id: 'session-1', workfolder: '/workspace/project-a', agent: 'Codex',
    })
    assert.equal(context.compatibility.deprecated, true)
    assert.equal(context.compatibility.lossy, true)
    assert.equal(context.compatibility.replacement, 'agent_work_context')
    assert.equal(context.execution_id, current.executionId)
    assert.deepEqual(context.candidates.map(({ task }) => task.id), ['task-a', 'task-b'])

    const synced = await current.service.syncTree({
      session_id: 'session-1', turn_id: 'turn-1', workfolder: '/workspace/project-a',
      expected_revision: null,
      root: { id: 'root-task', project: 'Project A', title: 'Root task', status: 'active' },
      children: [{
        id: 'child-task', title: 'Child task', status: 'planned', sort_order: 0,
      }],
      focus_task_id: 'child-task',
    })
    assert.equal(synced.compatibility.replacement, 'agent_tasks_sync_structure')
    assert.equal(synced.root.status, 'active')
    assert.equal(synced.children[0].parent_id, 'root-task')
    assert.equal(current.store.work.context({ execution_id: current.executionId }).task.id, 'child-task')
  } finally {
    await current.cleanup()
  }
})

test('default taskd runtime owns one fresh v3 store and serves both event and legacy projections', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tasks-recorder-v3-runtime-'))
  let runtime
  try {
    runtime = await startTaskd({
      config: {
        databasePath: join(directory, 'tasks.sqlite'),
        outputDir: directory,
        spoolDirectory: join(directory, 'spool'),
        spoolMaxBytes: 1024 * 1024,
        spoolMaxFiles: 32,
        spoolMaxAgeMs: 60_000,
        logsDirectory: join(directory, 'logs'),
        logMaxFileBytes: 1024 * 1024,
        logMaxFiles: 3,
        logMaxAgeMs: 60_000,
        serverHost: '127.0.0.1',
        serverPort: 0,
      },
      dashboardPath: join(directory, 'index.html'),
      dashboardHtml: '<!doctype html><title>v3</title>',
      gitResolver: async (workfolder) => ({
        gitRoot: workfolder, gitCommonDir: `${workfolder}/.git`, gitRemote: null,
        worktree: workfolder, branch: 'main',
      }),
    })
    const ready = await fetch(`${runtime.address.url}/health/ready`).then((response) => response.json())
    assert.equal(ready.ready, true)
    assert.equal(ready.check.schemaVersion, 3)

    const ingested = await fetch(`${runtime.address.url}/api/v1/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source: 'codex', event_type: 'execution.started', external_event_id: 'runtime:start',
        observed_at: '2026-08-20T08:00:00.000Z', source_session_key: 'runtime-session',
        root_session_key: 'runtime-session', source_turn_key: 'runtime-turn',
        source_agent_key: null, workfolder: '/workspace/runtime', git_root: '/workspace/runtime',
        git_common_dir: '/workspace/runtime/.git', git_remote: null,
        worktree: '/workspace/runtime', branch: 'main', payload: { kind: 'main' },
      }),
    }).then((response) => response.json())
    assert.equal(ingested.ok, true)

    const context = await fetch(`${runtime.address.url}/api/v1/context`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: 'runtime-session', workfolder: '/workspace/runtime' }),
    }).then((response) => response.json())
    assert.equal(context.compatibility.deprecated, true)
    assert.equal(context.execution_id, ingested.execution_id)

    const dashboard = await fetch(`${runtime.address.url}/api/v1/snapshot`)
      .then((response) => response.json())
    assert.equal(dashboard.schema_version, 3)
    assert.equal(dashboard.project_inbox_count, 1)
    assert.equal(dashboard.attribution_inbox_count, 1)
  } finally {
    await runtime?.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('v3 runtime refuses a v2 database without mutating the rollback source', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tasks-recorder-v3-gate-'))
  const databasePath = join(directory, 'tasks.sqlite')
  const legacy = createTaskStore({ databasePath })
  legacy.close()
  await assert.rejects(
    startTaskd({
      config: {
        databasePath, outputDir: directory, spoolDirectory: join(directory, 'spool'),
        spoolMaxBytes: 1024, spoolMaxFiles: 8, spoolMaxAgeMs: 60_000,
        logsDirectory: join(directory, 'logs'), logMaxFileBytes: 1024,
        logMaxFiles: 2, logMaxAgeMs: 60_000,
        serverHost: '127.0.0.1', serverPort: 0,
      },
      dashboardPath: join(directory, 'index.html'), dashboardHtml: '<!doctype html>',
    }),
    (error) => error.code === 'SCHEMA_MIGRATION_REQUIRED',
  )
  const db = new DatabaseSync(databasePath, { readOnly: true })
  try {
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 2)
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
  } finally {
    db.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('legacy assignment, classification, archive, delete, and restore remain revision guarded', async () => {
  const current = await fixture()
  try {
    const assigned = await current.service.assignExecution({
      id: current.executionId,
      task_id: 'task-b',
      expected_task_id: null,
    })
    assert.equal(assigned.execution.task_id, 'task-b')
    assert.equal(assigned.execution.classification, 'work')

    const classified = await current.service.classifyExecution({
      id: current.executionId,
      classification: 'non_work',
      expected_classification: 'work',
      expected_task_id: 'task-b',
    })
    assert.equal(classified.execution.task_id, null)
    assert.equal(classified.execution.classification, 'non_work')

    const done = current.store.tasks.updateLifecycle({
      id: 'task-b', expected_revision: 1, lifecycle: 'done', actor: 'user',
    }).task
    const archived = await current.service.archiveTask({ id: 'task-b', expected_revision: done.revision })
    assert.ok(archived.task.archived_at)
    const deleted = await current.service.deleteTask({
      id: 'task-b', expected_revision: archived.task.revision,
    })
    assert.ok(deleted.task.deleted_at)
    const restored = await current.service.restoreTask({
      id: 'task-b', expected_revision: deleted.task.revision,
    })
    assert.equal(restored.task.archived_at, null)
    assert.equal(restored.task.deleted_at, null)
  } finally {
    await current.cleanup()
  }
})
