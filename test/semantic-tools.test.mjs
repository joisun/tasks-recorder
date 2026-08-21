import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createJournalService } from '../mcp/src/journal-service.mjs'
import { createJournalStore } from '../mcp/src/journal-store.mjs'
import { createApiServer } from '../server/src/api-server.mjs'
import { createRevisionHub } from '../server/src/revision-hub.mjs'

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'tasks-recorder-semantic-'))
  let now = new Date('2026-08-20T11:00:00.000Z')
  const store = createJournalStore({
    databasePath: join(directory, 'tasks.sqlite'),
    clock: () => now,
  })
  store.projects.create({ id: 'project-a', name: 'Project A' })
  store.projects.create({ id: 'project-b', name: 'Project B' })
  store.tasks.create({
    id: 'task-a', project_id: 'project-a', title: 'Task A', lifecycle: 'in_progress',
  })
  store.tasks.create({
    id: 'task-b', project_id: 'project-a', title: 'Task B', lifecycle: 'in_progress',
  })
  store.work.startExecution({
    id: 'execution-1',
    source: 'codex',
    source_session_key: 'session-1',
    source_turn_key: 'turn-1',
    project_id: 'project-a',
    kind: 'main',
    started_at: '2026-08-20T11:00:00.000Z',
  })
  return {
    store,
    service: createJournalService({ store }),
    setNow(value) { now = new Date(value) },
    async cleanup() {
      store.close()
      await rm(directory, { recursive: true, force: true })
    },
  }
}

test('work focus preserves A to B to A as three semantic segments', async () => {
  const current = await fixture()
  try {
    for (const [taskId, observedAt] of [
      ['task-a', '2026-08-20T11:00:00.000Z'],
      ['task-b', '2026-08-20T11:10:00.000Z'],
      ['task-a', '2026-08-20T11:20:00.000Z'],
    ]) {
      const result = await current.service.focus({
        execution_id: 'execution-1',
        task_id: taskId,
        provenance: 'agent_explicit',
        rationale_code: 'selected_task',
        observed_at: observedAt,
      })
      assert.equal(result.ok, true)
      assert.equal(result.persisted, true)
    }
    assert.deepEqual(
      current.store.work.listSegments({ execution_id: 'execution-1' })
        .map(({ task_id }) => task_id),
      ['task-a', 'task-b', 'task-a'],
    )
  } finally {
    await current.cleanup()
  }
})

test('spawn intent attributes a future child execution without identity inference', async () => {
  const current = await fixture()
  try {
    const registered = await current.service.registerIntent({
      execution_id: 'execution-1',
      external_agent_key: 'child-agent-1',
      task_id: 'task-b',
      created_at: '2026-08-20T11:01:00.000Z',
      expires_at: '2026-08-20T12:01:00.000Z',
    })
    assert.equal(registered.persisted, true)

    const started = current.store.work.startExecution({
      id: 'execution-child-1',
      source: 'codex',
      source_session_key: 'child-session-1',
      root_session_key: 'session-1',
      source_turn_key: 'turn-child-1',
      source_agent_key: 'child-agent-1',
      project_id: 'project-a',
      kind: 'subagent',
      parent_execution_id: 'execution-1',
      started_at: '2026-08-20T11:02:00.000Z',
    })
    assert.equal(started.attribution.task_id, 'task-b')
    assert.equal(started.attribution.provenance, 'spawn_intent')
  } finally {
    await current.cleanup()
  }
})

test('user attribution correction is auditable and protected from current-focus automation', async () => {
  const current = await fixture()
  try {
    const focused = await current.service.focus({
      execution_id: 'execution-1',
      task_id: 'task-a',
      provenance: 'agent_explicit',
      rationale_code: 'selected_task',
      observed_at: '2026-08-20T11:00:00.000Z',
    })
    const corrected = await current.service.correctAttribution({
      segment_id: focused.segment.id,
      task_id: 'task-b',
      provenance: 'user',
      rationale_code: 'dashboard_correction',
      observed_at: '2026-08-20T11:05:00.000Z',
    })
    assert.equal(corrected.persisted, true)
    const protectedResult = await current.service.focus({
      execution_id: 'execution-1',
      task_id: 'task-a',
      provenance: 'current_focus',
      rationale_code: 'heartbeat',
      observed_at: '2026-08-20T11:06:00.000Z',
    })
    assert.equal(protectedResult.persisted, false)
    assert.equal(protectedResult.reason, 'user_attribution_protected')
    const history = current.store.work.listAttributions({ segment_id: focused.segment.id })
    assert.equal(history.length, 2)
    assert.equal(history[0].superseded_at, '2026-08-20T11:05:00.000Z')
    assert.equal(history[1].provenance, 'user')
  } finally {
    await current.cleanup()
  }
})

test('checkpoint updates Segment summary and Task next action atomically with no-op replay', async () => {
  const current = await fixture()
  try {
    await current.service.focus({
      execution_id: 'execution-1',
      task_id: 'task-a',
      provenance: 'agent_explicit',
      rationale_code: 'selected_task',
      observed_at: '2026-08-20T11:00:00.000Z',
    })
    current.setNow('2026-08-20T11:10:00.000Z')
    const checkpoint = await current.service.checkpoint({
      execution_id: 'execution-1',
      task_id: 'task-a',
      expected_revision: 1,
      summary: 'Event ingest is complete.',
      next_action: 'Implement compatibility wrapper.',
      observed_at: '2026-08-20T11:10:00.000Z',
    })
    assert.equal(checkpoint.persisted, true)
    assert.equal(checkpoint.task.revision, 2)
    assert.equal(checkpoint.task.next_action, 'Implement compatibility wrapper.')
    assert.equal(checkpoint.segment.summary, 'Event ingest is complete.')

    const replay = await current.service.checkpoint({
      execution_id: 'execution-1',
      task_id: 'task-a',
      expected_revision: 2,
      summary: 'Event ingest is complete.',
      next_action: 'Implement compatibility wrapper.',
      observed_at: '2026-08-20T11:10:00.000Z',
    })
    assert.equal(replay.persisted, false)
    assert.equal(replay.task.revision, 2)

    await assert.rejects(
      current.service.checkpoint({
        execution_id: 'execution-1',
        task_id: 'task-a',
        expected_revision: 1,
        summary: 'Must roll back.',
        next_action: 'Stale change.',
        observed_at: '2026-08-20T11:20:00.000Z',
      }),
      (error) => error.code === 'TASK_VERSION_CONFLICT',
    )
    const segment = current.store.work.listSegments({ execution_id: 'execution-1' }).at(-1)
    assert.equal(segment.summary, 'Event ingest is complete.')
  } finally {
    await current.cleanup()
  }
})

test('task mutation provides one revisioned create/update/status command surface', async () => {
  const current = await fixture()
  try {
    const created = await current.service.mutateTask({
      action: 'create',
      task: {
        id: 'task-child',
        project_id: 'project-a',
        parent_id: 'task-a',
        title: 'Task child',
        lifecycle: 'planned',
      },
    })
    assert.equal(created.task.revision, 1)
    const updated = await current.service.mutateTask({
      action: 'update',
      task: {
        id: 'task-child',
        expected_revision: 1,
        patch: { title: 'Renamed child', lifecycle: 'in_progress' },
      },
    })
    assert.equal(updated.task.revision, 2)
    const done = await current.service.mutateTask({
      action: 'status',
      task: { id: 'task-child', expected_revision: 2, lifecycle: 'done' },
    })
    assert.equal(done.task.lifecycle, 'done')
    assert.equal(done.task.revision, 3)

    await assert.rejects(
      current.service.mutateTask({
        action: 'update',
        task: { id: 'task-child', expected_revision: 1, patch: { title: 'Stale' } },
      }),
      (error) => error.code === 'TASK_VERSION_CONFLICT'
        && error.details.current.revision === 3,
    )
  } finally {
    await current.cleanup()
  }
})

test('structure sync atomically reconciles one Main Task and its explicitly versioned children', async () => {
  const current = await fixture()
  try {
    await current.service.mutateTask({
      action: 'create',
      task: {
        id: 'existing-child',
        project_id: 'project-a',
        parent_id: 'task-a',
        title: 'Existing child',
        lifecycle: 'planned',
      },
    })
    const synced = await current.service.syncStructure({
      project_id: 'project-a',
      main_task: {
        id: 'task-a', expected_revision: 1, title: 'Task A refined',
      },
      expected_children: [{ id: 'existing-child', revision: 1 }],
      children: [
        {
          id: 'existing-child', expected_revision: 1,
          title: 'Existing child refined', lifecycle: 'in_progress', sort_order: 0,
        },
        {
          id: 'new-child', title: 'New child', lifecycle: 'planned', sort_order: 1,
        },
      ],
    })
    assert.equal(synced.persisted, true)
    assert.equal(synced.main_task.revision, 2)
    assert.deepEqual(synced.children.map(({ id }) => id), ['existing-child', 'new-child'])
    assert.equal(synced.children[0].revision, 2)
    assert.equal(synced.children[1].revision, 1)

    const replay = await current.service.syncStructure({
      project_id: 'project-a',
      main_task: {
        id: 'task-a', expected_revision: 2, title: 'Task A refined',
      },
      expected_children: [
        { id: 'existing-child', revision: 2 },
        { id: 'new-child', revision: 1 },
      ],
      children: [
        {
          id: 'existing-child', expected_revision: 2,
          title: 'Existing child refined', lifecycle: 'in_progress', sort_order: 0,
        },
        {
          id: 'new-child', expected_revision: 1,
          title: 'New child', lifecycle: 'planned', sort_order: 1,
        },
      ],
    })
    assert.equal(replay.persisted, false)

    await assert.rejects(
      current.service.syncStructure({
        project_id: 'project-a',
        main_task: { id: 'task-a', expected_revision: 2 },
        expected_children: [{ id: 'existing-child', revision: 1 }],
        children: [],
      }),
      (error) => error.code === 'TASK_STRUCTURE_CONFLICT'
        && error.details.current_children.length === 2,
    )
    assert.equal(current.store.tasks.show('existing-child').task.lifecycle, 'in_progress')
  } finally {
    await current.cleanup()
  }
})

test('structure sync cancels omitted children only after an exact child-set precondition', async () => {
  const current = await fixture()
  try {
    await current.service.mutateTask({
      action: 'create',
      task: {
        id: 'remove-child',
        project_id: 'project-a',
        parent_id: 'task-a',
        title: 'Remove child',
        lifecycle: 'in_progress',
      },
    })
    const result = await current.service.syncStructure({
      project_id: 'project-a',
      main_task: { id: 'task-a', expected_revision: 1 },
      expected_children: [{ id: 'remove-child', revision: 1 }],
      children: [],
    })
    assert.equal(result.persisted, true)
    assert.deepEqual(result.removed.map(({ id }) => id), ['remove-child'])
    assert.equal(current.store.tasks.show('remove-child').task.lifecycle, 'canceled')
  } finally {
    await current.cleanup()
  }
})

test('guarded semantic API routes publish one revision per committed command', async () => {
  const current = await fixture()
  const hub = createRevisionHub({ keepaliveMs: 60_000 })
  const service = createJournalService({ store: current.store, onChange: () => hub.publish() })
  let api
  try {
    api = createApiServer({
      service: {},
      journalService: service,
      store: current.store,
      hub,
      host: '127.0.0.1',
      port: 0,
      dashboardHtml: '<!doctype html>',
    })
    const address = await api.listen()
    const post = async (path, body, method = 'POST') => {
      const response = await fetch(`${address.url}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      assert.equal(response.status, 200)
      return response.json()
    }
    const focused = await post('/api/v1/work/focus', {
      execution_id: 'execution-1',
      task_id: 'task-a',
      provenance: 'agent_explicit',
      rationale_code: 'selected_task',
      observed_at: '2026-08-20T11:00:00.000Z',
    })
    assert.equal(focused.change.revision, 1)
    const intent = await post('/api/v1/work/intents', {
      execution_id: 'execution-1',
      external_agent_key: 'api-child-agent',
      task_id: 'task-a',
      created_at: '2026-08-20T11:01:00.000Z',
    })
    assert.equal(intent.change.revision, 2)
    const corrected = await post(`/api/v1/segments/${focused.segment.id}/attribution`, {
      task_id: 'task-b',
      provenance: 'user',
      rationale_code: 'dashboard_correction',
      observed_at: '2026-08-20T11:05:00.000Z',
    }, 'PATCH')
    assert.equal(corrected.change.revision, 3)
    const checkpoint = await post('/api/v1/work/checkpoint', {
      execution_id: 'execution-1',
      task_id: 'task-b',
      expected_revision: 1,
      summary: 'Corrected work is progressing.',
      next_action: 'Continue Task B.',
      observed_at: '2026-08-20T11:10:00.000Z',
    })
    assert.equal(checkpoint.change.revision, 4)
    const mutation = await post('/api/v1/tasks/mutate', {
      action: 'create',
      task: {
        id: 'api-child', project_id: 'project-a', parent_id: 'task-a',
        title: 'API child', lifecycle: 'planned',
      },
    })
    assert.equal(mutation.change.revision, 5)
    const structure = await post('/api/v1/tasks/sync-structure', {
      project_id: 'project-a',
      main_task: { id: 'task-a', expected_revision: 1 },
      expected_children: [{ id: 'api-child', revision: 1 }],
      children: [{
        id: 'api-child', expected_revision: 1, title: 'API child refined',
        lifecycle: 'in_progress',
      }],
    })
    assert.equal(structure.change.revision, 6)
    current.store.work.startExecution({
      id: 'execution-unresolved', source: 'codex', source_session_key: 'session-unresolved',
      source_turn_key: 'turn-unresolved', project_id: null, kind: 'main',
      started_at: '2026-08-20T11:20:00.000Z', branch: 'main',
    })
    const sourceSession = current.store.snapshot().source_sessions
      .find(({ external_session_id: id }) => id === 'session-unresolved')
    const projectAssigned = await post(`/api/v1/source-sessions/${sourceSession.id}/project`, {
      expected_project_id: null,
      project_id: 'project-b',
    }, 'PATCH')
    assert.equal(projectAssigned.source_session.project_id, 'project-b')
    assert.equal(projectAssigned.change.revision, 7)
    assert.equal(hub.current().revision, 7)
  } finally {
    await api?.close()
    hub.close()
    await current.cleanup()
  }
})
