import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createJournalService } from '../mcp/src/journal-service.mjs'
import { createJournalStore } from '../mcp/src/journal-store.mjs'

function event(overrides = {}) {
  return {
    source: 'codex',
    event_type: 'execution.started',
    external_event_id: 'session-1:turn-1:start',
    observed_at: '2026-08-20T03:00:00.000Z',
    source_session_key: 'session-1',
    source_turn_key: 'turn-1',
    source_agent_key: null,
    workfolder: '/workspace/project-a',
    git_root: '/workspace/project-a',
    git_common_dir: '/workspace/project-a/.git',
    git_remote: null,
    worktree: '/workspace/project-a',
    branch: 'feature/a',
    payload: { kind: 'main' },
    ...overrides,
  }
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'tasks-recorder-recovery-'))
  const store = createJournalStore({
    databasePath: join(directory, 'tasks.sqlite'),
    clock: () => new Date('2026-08-20T03:00:00.000Z'),
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
    store,
    service: createJournalService({ store }),
    async cleanup() {
      store.close()
      await rm(directory, { recursive: true, force: true })
    },
  }
}

test('session end closes all main and subagent facts without completing a Task', async () => {
  const current = await fixture()
  try {
    const main = await current.service.ingestEvent(event())
    await current.service.ingestEvent(event({
      external_event_id: 'session-1:turn-1:agent-a:start',
      source_agent_key: 'agent-a',
      payload: { kind: 'subagent', parent_execution_id: main.execution_id },
    }))
    const ended = await current.service.ingestEvent(event({
      event_type: 'session.ended',
      external_event_id: 'session-1:end',
      observed_at: '2026-08-20T03:10:00.000Z',
      source_turn_key: null,
      payload: { end_reason: 'completed' },
    }))
    assert.equal(ended.persisted, true)
    assert.equal(ended.execution_ids.length, 2)
    assert.equal(ended.segment_ids.length, 2)

    const snapshot = current.store.snapshot()
    assert.equal(snapshot.executions.every((execution) => (
      execution.ended_at === '2026-08-20T03:10:00.000Z'
      && execution.end_reason === 'completed'
    )), true)
    assert.equal(snapshot.segments.every((segment) => (
      segment.ended_at === '2026-08-20T03:10:00.000Z'
      && segment.close_reason === 'execution_ended'
    )), true)
    assert.equal(snapshot.tasks[0].lifecycle, 'in_progress')

    const replay = await current.service.ingestEvent(event({
      event_type: 'session.ended',
      external_event_id: 'session-1:end',
      observed_at: '2026-08-20T03:10:00.000Z',
      source_turn_key: null,
      payload: { end_reason: 'completed' },
    }))
    assert.equal(replay.deduped, true)
    assert.equal(replay.persisted, false)
  } finally {
    await current.cleanup()
  }
})

test('late heartbeat is durable evidence but never reopens an ended execution', async () => {
  const current = await fixture()
  try {
    const started = await current.service.ingestEvent(event())
    await current.service.ingestEvent(event({
      event_type: 'execution.stop',
      external_event_id: 'session-1:turn-1:stop',
      observed_at: '2026-08-20T03:10:00.000Z',
      payload: { end_reason: 'completed' },
    }))
    const late = await current.service.ingestEvent(event({
      event_type: 'execution.heartbeat',
      external_event_id: 'session-1:turn-1:late-heartbeat',
      observed_at: '2026-08-20T03:11:00.000Z',
      payload: { activity: 'host_event' },
    }))
    assert.equal(late.persisted, true)
    assert.equal(late.execution_id, started.execution_id)
    const snapshot = current.store.snapshot()
    assert.equal(snapshot.observations.length, 3)
    assert.equal(snapshot.executions[0].ended_at, '2026-08-20T03:10:00.000Z')
    assert.equal(snapshot.segments.length, 1)
  } finally {
    await current.cleanup()
  }
})

test('recovery leaves stale live work open unless exact inactive-session evidence exists', async () => {
  const current = await fixture()
  try {
    const inactive = await current.service.ingestEvent(event({
      external_event_id: 'inactive:start',
      source_session_key: 'inactive-session',
      source_turn_key: 'inactive-turn',
    }))
    const active = await current.service.ingestEvent(event({
      external_event_id: 'active:start',
      source_session_key: 'active-session',
      source_turn_key: 'active-turn',
    }))

    const scanned = await current.service.recover({
      observed_at: '2026-08-20T04:00:00.000Z',
      stale_after_ms: 30 * 60 * 1000,
      inactive_sessions: [{ source: 'codex', source_session_key: 'inactive-session' }],
    })
    assert.equal(scanned.persisted, true)
    assert.deepEqual(scanned.recovered_execution_ids, [inactive.execution_id])
    assert.deepEqual(scanned.stale_execution_ids, [active.execution_id])

    const snapshot = current.store.snapshot()
    const recovered = snapshot.executions.find(({ id }) => id === inactive.execution_id)
    const stillOpen = snapshot.executions.find(({ id }) => id === active.execution_id)
    assert.equal(recovered.end_reason, 'interrupted')
    assert.equal(recovered.ended_at, '2026-08-20T04:00:00.000Z')
    assert.equal(stillOpen.ended_at, null)
    assert.equal(current.store.work.executionLiveState(active.execution_id, {
      now: '2026-08-20T04:00:00.000Z',
      stale_after_ms: 30 * 60 * 1000,
    }), 'stale')
    assert.equal(snapshot.tasks[0].lifecycle, 'in_progress')

    const replay = await current.service.recover({
      observed_at: '2026-08-20T04:00:00.000Z',
      stale_after_ms: 30 * 60 * 1000,
      inactive_sessions: [{ source: 'codex', source_session_key: 'inactive-session' }],
    })
    assert.equal(replay.persisted, false)
  } finally {
    await current.cleanup()
  }
})
