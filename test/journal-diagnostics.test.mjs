import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createEventSpool } from '../hooks/src/event-spool.mjs'
import { createJournalDiagnostics } from '../mcp/src/journal-diagnostics.mjs'
import { createJournalService } from '../mcp/src/journal-service.mjs'
import { createJournalStore } from '../mcp/src/journal-store.mjs'
import { createApiServer } from '../server/src/api-server.mjs'
import { createRevisionHub } from '../server/src/revision-hub.mjs'
import { createStructuredLogger } from '../server/src/structured-logger.mjs'

function event(overrides = {}) {
  return {
    source: 'codex',
    event_type: 'execution.started',
    external_event_id: 'session-1:turn-1:start',
    observed_at: '2026-08-20T08:00:00.000Z',
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

test('diagnostics distinguishes ready from degraded and exposes bounded operational state', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tasks-recorder-diagnostics-'))
  const store = createJournalStore({ databasePath: join(directory, 'tasks.sqlite') })
  const spool = createEventSpool({ directory: join(directory, 'spool') })
  const logger = createStructuredLogger({
    directory: join(directory, 'logs'),
    clock: () => new Date('2026-08-20T09:00:00.000Z'),
  })
  const diagnostics = createJournalDiagnostics({
    store,
    spool,
    logger,
    clock: () => new Date('2026-08-20T09:00:00.000Z'),
    staleAfterMs: 30 * 60 * 1000,
  })
  const service = createJournalService({ store, logger, diagnostics })
  try {
    const healthy = await diagnostics.status()
    assert.equal(healthy.live, true)
    assert.equal(healthy.ready, true)
    assert.equal(healthy.degraded, false)
    assert.equal(healthy.schema_version, 3)
    assert.equal(healthy.database.writable, true)
    assert.equal(healthy.spool.backlog_files, 0)

    await assert.rejects(
      service.ingestEvent(event({ prompt: 'private' })),
      (error) => error.code === 'EVENT_ENVELOPE_INVALID',
    )
    await service.ingestEvent(event())
    await spool.queue(event({
      event_type: 'execution.heartbeat',
      external_event_id: 'queued-heartbeat',
      observed_at: '2026-08-20T08:30:00.000Z',
      payload: { activity: 'tool_use' },
    }))

    const degraded = await diagnostics.status()
    assert.equal(degraded.ready, true)
    assert.equal(degraded.degraded, true)
    assert.equal(degraded.ingest.accepted, 1)
    assert.equal(degraded.ingest.rejected, 1)
    assert.equal(degraded.ingest.deduped, 0)
    assert.equal(degraded.ingest.last_error_code, 'EVENT_ENVELOPE_INVALID')
    assert.equal(degraded.spool.backlog_files, 1)
    assert.equal(degraded.executions.open, 1)
    assert.equal(degraded.executions.stale, 1)

    const records = (await readFile(join(directory, 'logs', 'tasks-recorder.ndjson'), 'utf8'))
      .trim().split('\n').map((line) => JSON.parse(line))
    assert.deepEqual(records.map(({ event: name }) => name), [
      'event.rejected',
      'event.accepted',
    ])
    assert.equal(records.some((record) => 'prompt' in record || 'payload' in record), false)
  } finally {
    store.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('GET status exposes diagnostics without weakening local transport guards', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tasks-recorder-diagnostics-api-'))
  const store = createJournalStore({ databasePath: join(directory, 'tasks.sqlite') })
  const spool = createEventSpool({ directory: join(directory, 'spool') })
  const diagnostics = createJournalDiagnostics({ store, spool })
  const hub = createRevisionHub({ keepaliveMs: 60_000 })
  const api = createApiServer({
    service: {},
    journalDiagnostics: diagnostics,
    store,
    hub,
    host: '127.0.0.1',
    port: 0,
    dashboardHtml: '<!doctype html>',
  })
  const address = await api.listen()
  try {
    const response = await fetch(`${address.url}/api/v1/status`)
    assert.equal(response.status, 200)
    const status = await response.json()
    assert.equal(status.ready, true)
    assert.equal(status.service, 'tasks-recorder')

    const rejected = await fetch(`${address.url}/api/v1/status`, {
      headers: { Origin: 'https://attacker.example' },
    })
    assert.equal(rejected.status, 403)
  } finally {
    await api.close()
    hub.close()
    store.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('scheduler diagnostics are a privacy-bounded degraded sibling and do not make Journal unready', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tasks-recorder-diagnostics-scheduler-'))
  const store = createJournalStore({ databasePath: join(directory, 'tasks.sqlite') })
  const spool = createEventSpool({ directory: join(directory, 'spool') })
  const diagnostics = createJournalDiagnostics({
    store,
    spool,
    scheduler: async () => ({
      capability: { backend: 'launchd', supported: true, prompt: 'private' },
      ready: false,
      degraded: true,
      error_code: 'SCHEDULER_STALE_RECOVERY_UNAVAILABLE',
      backlog: { pending: 2, path: '/private/spool' },
      counts: { jobs: 3, runs: 4, nonce: 'secret' },
      workspace: '/private/workspace',
    }),
  })
  try {
    const status = await diagnostics.status()
    assert.equal(status.ready, true)
    assert.equal(status.degraded, true)
    assert.deepEqual(status.scheduler, {
      capability: { backend: 'launchd', supported: true },
      ready: false,
      degraded: true,
      error_code: 'SCHEDULER_STALE_RECOVERY_UNAVAILABLE',
      backlog: 2,
      count: 7,
    })
    assert.doesNotMatch(JSON.stringify(status.scheduler), /private|workspace|nonce|prompt|path|secret/)
  } finally {
    store.close()
    await rm(directory, { recursive: true, force: true })
  }
})
