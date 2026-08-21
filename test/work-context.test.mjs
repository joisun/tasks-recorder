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
  const directory = await mkdtemp(join(tmpdir(), 'tasks-recorder-work-context-'))
  let now = new Date('2026-08-20T10:00:00.000Z')
  const store = createJournalStore({
    databasePath: join(directory, 'tasks.sqlite'),
    clock: () => now,
  })
  for (const [id, name] of [['project-a', 'Project A'], ['project-b', 'Project B']]) {
    store.projects.create({ id, name })
  }
  function createTask(id, projectId, lifecycle, options = {}) {
    now = new Date(now.valueOf() + 60_000)
    return store.tasks.create({
      id,
      project_id: projectId,
      title: options.title ?? id,
      lifecycle,
      parent_id: options.parent_id,
      sort_order: options.sort_order ?? 0,
    }).task
  }
  return {
    store,
    service: createJournalService({ store }),
    createTask,
    setNow(value) { now = new Date(value) },
    async cleanup() {
      store.close()
      await rm(directory, { recursive: true, force: true })
    },
  }
}

test('unresolved execution returns Project Inbox state and never leaks cross-project candidates', async () => {
  const current = await fixture()
  try {
    current.createTask('project-a-main', 'project-a', 'in_progress')
    current.createTask('project-b-main', 'project-b', 'in_progress')
    current.store.work.startExecution({
      id: 'unresolved-execution',
      source: 'codex',
      source_session_key: 'unresolved-session',
      source_turn_key: 'turn-1',
      kind: 'main',
      started_at: '2026-08-20T10:10:00.000Z',
    })
    const before = current.store.snapshot()
    const context = await current.service.workContext({ execution_id: 'unresolved-execution' })
    assert.equal(context.project, null)
    assert.equal(context.project_resolution.status, 'unresolved')
    assert.equal(context.project_resolution.inbox, 'project')
    assert.deepEqual(context.candidates, [])
    assert.equal(context.current.task, null)
    assert.deepEqual(current.store.snapshot(), before)
  } finally {
    await current.cleanup()
  }
})

test('returns current focus first and at most three deterministic same-project Main Tasks', async () => {
  const current = await fixture()
  try {
    current.createTask('focused-main', 'project-a', 'blocked')
    current.createTask('focused-child', 'project-a', 'in_progress', {
      parent_id: 'focused-main', sort_order: 2,
    })
    current.createTask('older-active', 'project-a', 'in_progress')
    current.createTask('newer-active', 'project-a', 'in_progress')
    current.createTask('waiting-main', 'project-a', 'waiting')
    current.createTask('planned-main', 'project-a', 'planned')
    current.createTask('done-main', 'project-a', 'done')
    current.createTask('other-project', 'project-b', 'in_progress')
    current.setNow('2026-08-20T10:20:00.000Z')
    current.store.work.startExecution({
      id: 'focused-execution',
      source: 'codex',
      source_session_key: 'focused-session',
      source_turn_key: 'turn-1',
      project_id: 'project-a',
      kind: 'main',
      started_at: '2026-08-20T10:20:00.000Z',
    })
    current.store.work.focus({
      execution_id: 'focused-execution',
      task_id: 'focused-child',
      provenance: 'agent_explicit',
      rationale_code: 'user_selected',
      observed_at: '2026-08-20T10:20:00.000Z',
    })

    const before = current.store.snapshot()
    const context = await current.service.workContext({ execution_id: 'focused-execution' })
    assert.equal(context.project.id, 'project-a')
    assert.equal(context.project_resolution.status, 'resolved')
    assert.equal(context.current.task.id, 'focused-child')
    assert.equal(context.current.attribution.provenance, 'agent_explicit')
    assert.deepEqual(context.candidates.map(({ task }) => task.id), [
      'focused-main',
      'newer-active',
      'older-active',
    ])
    assert.deepEqual(context.candidates[0].children.map(({ id }) => id), ['focused-child'])
    assert.equal(context.candidates.length, 3)
    assert.equal(context.candidates.some(({ task }) => task.id === 'other-project'), false)
    assert.equal(context.candidates.some(({ task }) => task.id === 'done-main'), false)
    assert.deepEqual(current.store.snapshot(), before)
  } finally {
    await current.cleanup()
  }
})

test('candidate ordering is stable without a current attribution', async () => {
  const current = await fixture()
  try {
    current.createTask('blocked-main', 'project-a', 'blocked')
    current.createTask('active-main', 'project-a', 'in_progress')
    current.createTask('waiting-main', 'project-a', 'waiting')
    current.createTask('planned-main', 'project-a', 'planned')
    current.store.work.startExecution({
      id: 'unfocused-execution',
      source: 'codex',
      source_session_key: 'unfocused-session',
      source_turn_key: 'turn-1',
      project_id: 'project-a',
      kind: 'main',
      started_at: '2026-08-20T10:10:00.000Z',
    })
    const first = await current.service.workContext({ execution_id: 'unfocused-execution' })
    const second = await current.service.workContext({ execution_id: 'unfocused-execution' })
    assert.deepEqual(first.candidates.map(({ task }) => task.id), [
      'active-main',
      'blocked-main',
      'waiting-main',
    ])
    assert.deepEqual(second, first)
  } finally {
    await current.cleanup()
  }
})

test('POST work context exposes the compact read model through the guarded API', async () => {
  const current = await fixture()
  const hub = createRevisionHub({ keepaliveMs: 60_000 })
  let api
  try {
    current.createTask('main-task', 'project-a', 'in_progress')
    current.store.work.startExecution({
      id: 'api-execution',
      source: 'codex',
      source_session_key: 'api-session',
      source_turn_key: 'turn-1',
      project_id: 'project-a',
      kind: 'main',
      started_at: '2026-08-20T10:10:00.000Z',
    })
    api = createApiServer({
      service: {},
      journalService: current.service,
      store: current.store,
      hub,
      host: '127.0.0.1',
      port: 0,
      dashboardHtml: '<!doctype html>',
    })
    const address = await api.listen()
    const response = await fetch(`${address.url}/api/v1/work/context`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ execution_id: 'api-execution' }),
    })
    assert.equal(response.status, 200)
    const context = await response.json()
    assert.equal(context.execution.id, 'api-execution')
    assert.deepEqual(context.candidates.map(({ task }) => task.id), ['main-task'])
  } finally {
    await api?.close()
    hub.close()
    await current.cleanup()
  }
})
