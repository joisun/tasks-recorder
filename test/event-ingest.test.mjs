import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createJournalService } from '../mcp/src/journal-service.mjs'
import { createJournalStore } from '../mcp/src/journal-store.mjs'
import { createApiServer } from '../server/src/api-server.mjs'
import { createRevisionHub } from '../server/src/revision-hub.mjs'

function event(overrides = {}) {
  return {
    source: 'codex',
    event_type: 'execution.started',
    external_event_id: 'codex:session-1:turn-1:start',
    observed_at: '2026-08-20T01:00:00.000Z',
    source_session_key: 'session-1',
    source_turn_key: 'turn-1',
    source_agent_key: null,
    workfolder: '/workspace/project-a',
    git_root: '/workspace/project-a',
    git_common_dir: '/workspace/project-a/.git',
    git_remote: 'git@github.com:acme/project-a.git',
    worktree: '/workspace/project-a',
    branch: 'feature/a',
    payload: { kind: 'main' },
    ...overrides,
  }
}

async function journalFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'tasks-recorder-ingest-'))
  const store = createJournalStore({
    databasePath: join(directory, 'tasks.sqlite'),
    clock: () => new Date('2026-08-20T01:00:00.000Z'),
  })
  store.projects.create({ id: 'project-a', name: 'Project A' })
  store.projects.registerLocation({
    project_id: 'project-a',
    kind: 'git_common_dir',
    value: '/workspace/project-a/.git',
  })
  store.tasks.create({
    id: 'main-task',
    project_id: 'project-a',
    title: 'Main task',
    lifecycle: 'in_progress',
  })
  return {
    directory,
    store,
    async cleanup() {
      store.close()
      await rm(directory, { recursive: true, force: true })
    },
  }
}

test('ingests start, heartbeat and stop atomically without mutating Task lifecycle', async () => {
  const current = await journalFixture()
  const changes = []
  const service = createJournalService({
    store: current.store,
    onChange: (change) => changes.push(change),
  })
  try {
    const started = await service.ingestEvent(event())
    assert.equal(started.ok, true)
    assert.equal(started.persisted, true)
    assert.equal(started.deduped, false)
    assert.equal(started.project_resolution.status, 'resolved')
    assert.equal(started.project_resolution.reason, 'git_common_dir')
    assert.ok(started.observation_id)
    assert.ok(started.execution_id)
    assert.ok(started.segment_id)

    const replayed = await service.ingestEvent(event())
    assert.equal(replayed.persisted, false)
    assert.equal(replayed.deduped, true)
    assert.equal(replayed.observation_id, started.observation_id)
    assert.equal(replayed.execution_id, started.execution_id)
    assert.equal(replayed.segment_id, started.segment_id)

    const heartbeat = await service.ingestEvent(event({
      event_type: 'execution.heartbeat',
      external_event_id: 'codex:session-1:turn-1:heartbeat:1',
      observed_at: '2026-08-20T01:05:00.000Z',
      payload: { activity: 'tool_use', coalesced_count: 2 },
    }))
    assert.equal(heartbeat.persisted, true)
    assert.equal(heartbeat.execution_id, started.execution_id)

    const stopped = await service.ingestEvent(event({
      event_type: 'execution.stop',
      external_event_id: 'codex:session-1:turn-1:stop',
      observed_at: '2026-08-20T01:10:00.000Z',
      payload: { end_reason: 'completed' },
    }))
    assert.equal(stopped.persisted, true)
    assert.equal(stopped.execution_id, started.execution_id)

    const snapshot = current.store.snapshot()
    assert.equal(snapshot.observations.length, 3)
    assert.equal(snapshot.executions.length, 1)
    assert.equal(snapshot.segments.length, 1)
    assert.equal(snapshot.executions[0].last_seen_at, '2026-08-20T01:10:00.000Z')
    assert.equal(snapshot.executions[0].ended_at, '2026-08-20T01:10:00.000Z')
    assert.equal(snapshot.segments[0].ended_at, '2026-08-20T01:10:00.000Z')
    assert.equal(snapshot.tasks[0].lifecycle, 'in_progress')
    assert.equal(changes.length, 3)
  } finally {
    await current.cleanup()
  }
})

test('branch-only evidence remains unresolved in Project Inbox', async () => {
  const current = await journalFixture()
  const service = createJournalService({ store: current.store })
  try {
    const result = await service.ingestEvent(event({
      external_event_id: 'codex:session-2:turn-2:start',
      source_session_key: 'session-2',
      source_turn_key: 'turn-2',
      workfolder: null,
      git_root: null,
      git_common_dir: null,
      git_remote: null,
      worktree: null,
      branch: 'feature/a',
    }))
    assert.equal(result.project_resolution.status, 'unresolved')
    assert.equal(current.store.snapshot().project_inbox_count, 1)
  } finally {
    await current.cleanup()
  }
})

test('rejects invalid envelopes before any rows are persisted', async () => {
  const current = await journalFixture()
  const service = createJournalService({ store: current.store })
  try {
    await assert.rejects(
      service.ingestEvent(event({ payload: { kind: 'main', prompt: 'do not store' } })),
      (error) => error.code === 'EVENT_PAYLOAD_INVALID',
    )
    const snapshot = current.store.snapshot()
    assert.equal(snapshot.observations.length, 0)
    assert.equal(snapshot.executions.length, 0)
    assert.equal(snapshot.source_sessions.length, 0)
  } finally {
    await current.cleanup()
  }
})

test('rejects identity drift when an event id is replayed with different facts', async () => {
  const current = await journalFixture()
  const service = createJournalService({ store: current.store })
  try {
    await service.ingestEvent(event())
    await assert.rejects(
      service.ingestEvent(event({ branch: 'feature/different' })),
      (error) => error.code === 'OBSERVATION_IDENTITY_CONFLICT'
        && error.details.fields.includes('branch'),
    )
    const snapshot = current.store.snapshot()
    assert.equal(snapshot.observations.length, 1)
    assert.equal(snapshot.executions.length, 1)
    assert.equal(snapshot.observations[0].branch, 'feature/a')
  } finally {
    await current.cleanup()
  }
})

test('rolls back Observation and Source Session when lifecycle application fails', async () => {
  const current = await journalFixture()
  const service = createJournalService({ store: current.store })
  try {
    await assert.rejects(
      service.ingestEvent(event({
        payload: { kind: 'main', parent_execution_id: 'missing-parent' },
      })),
      (error) => error.code === 'EXECUTION_NOT_FOUND',
    )
    const snapshot = current.store.snapshot()
    assert.equal(snapshot.observations.length, 0)
    assert.equal(snapshot.executions.length, 0)
    assert.equal(snapshot.source_sessions.length, 0)
  } finally {
    await current.cleanup()
  }
})

test('POST event ingest coexists with GET SSE and publishes one revision per changed event', async () => {
  const current = await journalFixture()
  const hub = createRevisionHub({ instanceId: 'journal-api-test', keepaliveMs: 60_000 })
  const journalService = createJournalService({
    store: current.store,
    onChange: () => hub.publish(),
  })
  const api = createApiServer({
    service: {},
    journalService,
    store: current.store,
    hub,
    host: '127.0.0.1',
    port: 0,
    dashboardHtml: '<!doctype html>',
  })
  const address = await api.listen()
  try {
    const response = await fetch(`${address.url}/api/v1/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event()),
    })
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.persisted, true)
    assert.equal(body.change.revision, 1)

    const replay = await fetch(`${address.url}/api/v1/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event()),
    }).then((result) => result.json())
    assert.equal(replay.deduped, true)
    assert.equal(replay.persisted, false)
    assert.equal(replay.change, undefined)
    assert.equal(hub.current().revision, 1)

    const conflictResponse = await fetch(`${address.url}/api/v1/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event({ branch: 'feature/different' })),
    })
    assert.equal(conflictResponse.status, 409)
    assert.equal(
      (await conflictResponse.json()).error.code,
      'OBSERVATION_IDENTITY_CONFLICT',
    )
    assert.equal(hub.current().revision, 1)

    const sse = await fetch(`${address.url}/api/v1/events`)
    assert.equal(sse.headers.get('content-type'), 'text/event-stream; charset=utf-8')
    await sse.body.cancel()
  } finally {
    await api.close()
    hub.close()
    await current.cleanup()
  }
})
