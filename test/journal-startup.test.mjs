import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createEventSpool } from '../hooks/src/event-spool.mjs'
import { createJournalService } from '../mcp/src/journal-service.mjs'
import { createJournalStore } from '../mcp/src/journal-store.mjs'
import { prepareJournalStartup } from '../server/src/journal-startup.mjs'

function event(overrides = {}) {
  return {
    source: 'codex',
    event_type: 'execution.started',
    external_event_id: 'stale:start',
    observed_at: '2026-08-20T06:00:00.000Z',
    source_session_key: 'stale-session',
    source_turn_key: 'stale-turn',
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

test('startup uses explicit inactive evidence before replaying the bounded spool', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tasks-recorder-journal-startup-'))
  const store = createJournalStore({ databasePath: join(directory, 'tasks.sqlite') })
  const service = createJournalService({ store })
  const spool = createEventSpool({ directory: join(directory, 'spool') })
  try {
    const stale = await service.ingestEvent(event())
    await spool.queue(event({
      external_event_id: 'queued:start',
      observed_at: '2026-08-20T07:00:00.000Z',
      source_session_key: 'queued-session',
      source_turn_key: 'queued-turn',
    }))

    const prepared = await prepareJournalStartup({
      service,
      spool,
      detectInactiveSessions: async () => [
        { source: 'codex', source_session_key: 'stale-session' },
      ],
      observedAt: '2026-08-20T07:00:00.000Z',
      staleAfterMs: 30 * 60 * 1000,
    })
    assert.deepEqual(prepared.recovery.recovered_execution_ids, [stale.execution_id])
    assert.equal(prepared.replay.replayed, 1)
    assert.equal(prepared.replay.pending, 0)
    assert.equal(prepared.detector_error, null)

    const snapshot = store.snapshot()
    assert.equal(snapshot.executions.length, 2)
    assert.equal(snapshot.executions.filter(({ end_reason }) => end_reason === 'interrupted').length, 1)
    assert.equal(snapshot.executions.filter(({ ended_at }) => ended_at === null).length, 1)
  } finally {
    store.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('detector failure never invents inactive evidence and does not block spool replay', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tasks-recorder-journal-startup-'))
  const store = createJournalStore({ databasePath: join(directory, 'tasks.sqlite') })
  const service = createJournalService({ store })
  const spool = createEventSpool({ directory: join(directory, 'spool') })
  try {
    const stale = await service.ingestEvent(event())
    await spool.queue(event({
      external_event_id: 'queued:start',
      observed_at: '2026-08-20T07:00:00.000Z',
      source_session_key: 'queued-session',
      source_turn_key: 'queued-turn',
    }))
    const prepared = await prepareJournalStartup({
      service,
      spool,
      detectInactiveSessions: async () => { throw new Error('private process detail') },
      observedAt: '2026-08-20T07:00:00.000Z',
      staleAfterMs: 30 * 60 * 1000,
    })
    assert.equal(prepared.detector_error, 'INACTIVE_SESSION_DETECTOR_FAILED')
    assert.deepEqual(prepared.recovery.recovered_execution_ids, [])
    assert.deepEqual(prepared.recovery.stale_execution_ids, [stale.execution_id])
    assert.equal(prepared.replay.replayed, 1)
    assert.equal(store.snapshot().executions.find(({ id }) => id === stale.execution_id).ended_at, null)
  } finally {
    store.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('startup quarantines a permanent identity conflict without blocking later replay', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tasks-recorder-journal-startup-'))
  const store = createJournalStore({ databasePath: join(directory, 'tasks.sqlite') })
  const service = createJournalService({ store })
  const spoolDirectory = join(directory, 'spool')
  const spool = createEventSpool({ directory: spoolDirectory })
  try {
    await service.ingestEvent(event())
    await spool.queue(event({ observed_at: '2026-08-20T06:01:00.000Z' }))
    await spool.queue(event({
      external_event_id: 'later:start',
      observed_at: '2026-08-20T06:02:00.000Z',
      source_session_key: 'later-session',
      source_turn_key: 'later-turn',
    }))

    const prepared = await prepareJournalStartup({
      service,
      spool,
      observedAt: '2026-08-20T06:03:00.000Z',
    })

    assert.equal(prepared.replay.replayed, 1)
    assert.equal(prepared.replay.isolated, 1)
    assert.equal(prepared.replay.pending, 0)
    assert.equal(prepared.replay.last_error, null)
    assert.equal(store.snapshot().observations.length, 2)
    assert.equal((await readdir(spoolDirectory)).some((name) => name.endsWith('.invalid')), true)
  } finally {
    store.close()
    await rm(directory, { recursive: true, force: true })
  }
})
