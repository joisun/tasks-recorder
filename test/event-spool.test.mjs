import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createEventSpool as createClaudeEventSpool } from '../adapters/claude/tasks-recorder/hooks/src/event-spool.mjs'
import { parseEventEnvelope as parseClaudeEventEnvelope } from '../adapters/claude/tasks-recorder/hooks/src/event-envelope.mjs'
import { createEventSpool as createCodexEventSpool } from '../adapters/codex/tasks-recorder/hooks/src/event-spool.mjs'
import { parseEventEnvelope as parseCodexEventEnvelope } from '../adapters/codex/tasks-recorder/hooks/src/event-envelope.mjs'
import { parseEventEnvelope } from '../mcp/src/event-envelope.mjs'
import { createEventSpool } from '../hooks/src/event-spool.mjs'

function event(overrides = {}) {
  return {
    source: 'codex',
    event_type: 'execution.started',
    external_event_id: 'codex:session-1:turn-1:start',
    observed_at: '2026-08-20T02:00:00.000Z',
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

async function fixture(options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'tasks-recorder-spool-'))
  const spoolDirectory = join(directory, 'spool')
  return {
    directory,
    spoolDirectory,
    spool: createEventSpool({ directory: spoolDirectory, ...options }),
    async cleanup() {
      await rm(directory, { recursive: true, force: true })
    },
  }
}

test('root, Codex and Claude adapters preserve the same self-contained spool contract', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tasks-recorder-spool-parity-'))
  const implementations = [
    ['root', createEventSpool, parseEventEnvelope],
    ['codex', createCodexEventSpool, parseCodexEventEnvelope],
    ['claude', createClaudeEventSpool, parseClaudeEventEnvelope],
  ]
  try {
    const normalized = implementations.map(([, , parse]) => parse(event()))
    assert.deepEqual(normalized[1], normalized[0])
    assert.deepEqual(normalized[2], normalized[0])
    for (const [name, create] of implementations) {
      const spool = create({ directory: join(directory, name) })
      const queued = await spool.queue(event({ external_event_id: `${name}-event` }))
      assert.equal(queued.queued, true)
      const status = await spool.status()
      assert.equal(status.backlog_files, 1)
      assert.equal(status.queued, 1)
      assert.equal(status.dropped, 0)
      await assert.rejects(
        spool.queue(event({ prompt: 'private' })),
        (error) => error.code === 'EVENT_ENVELOPE_INVALID',
      )
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('queues only validated envelopes with 0700 directory and 0600 atomic files', async () => {
  const current = await fixture({
    clock: () => new Date('2026-08-20T02:00:00.000Z'),
    uuid: () => 'boundary-1',
  })
  try {
    const queued = await current.spool.queue(event())
    assert.equal(queued.queued, true)
    assert.equal(queued.dropped, false)
    assert.equal((await stat(current.spoolDirectory)).mode & 0o777, 0o700)
    assert.equal((await stat(queued.path)).mode & 0o777, 0o600)
    assert.equal((await readdir(current.spoolDirectory)).some((name) => name.endsWith('.tmp')), false)

    await assert.rejects(
      current.spool.queue(event({ prompt: 'must never reach disk' })),
      (error) => error.code === 'EVENT_ENVELOPE_INVALID',
    )
    assert.equal((await current.spool.status()).backlog_files, 1)
  } finally {
    await current.cleanup()
  }
})

test('coalesces heartbeat per execution identity instead of growing the backlog', async () => {
  const current = await fixture({ clock: () => new Date('2026-08-20T02:01:00.000Z') })
  try {
    const first = await current.spool.queue(event({
      event_type: 'execution.heartbeat',
      external_event_id: 'heartbeat-1',
      payload: { activity: 'tool_use', coalesced_count: 1 },
    }))
    const second = await current.spool.queue(event({
      event_type: 'execution.heartbeat',
      external_event_id: 'heartbeat-2',
      observed_at: '2026-08-20T02:01:00.000Z',
      payload: { activity: 'tool_use', coalesced_count: 2 },
    }))
    assert.equal(first.path, second.path)
    assert.equal(second.coalesced, true)
    assert.equal((await current.spool.status()).backlog_files, 1)
    const stored = JSON.parse((await readFile(second.path, 'utf8')).trim())
    assert.equal(stored.external_event_id, 'heartbeat-2')
    assert.equal(stored.payload.coalesced_count, 2)
  } finally {
    await current.cleanup()
  }
})

test('enforces hard file and byte caps while preferring lifecycle boundaries', async () => {
  let uuid = 0
  const current = await fixture({
    maxFiles: 2,
    maxBytes: 16 * 1024,
    clock: () => new Date('2026-08-20T02:02:00.000Z'),
    uuid: () => `event-${uuid += 1}`,
  })
  try {
    for (const index of [1, 2]) {
      await current.spool.queue(event({
        event_type: 'execution.heartbeat',
        external_event_id: `heartbeat-${index}`,
        source_session_key: `session-${index}`,
        source_turn_key: `turn-${index}`,
        payload: { activity: 'host_event', coalesced_count: 1 },
      }))
    }
    const boundary = await current.spool.queue(event({
      external_event_id: 'boundary-3',
      source_session_key: 'session-3',
      source_turn_key: 'turn-3',
    }))
    assert.equal(boundary.queued, true)
    assert.equal(boundary.evicted, 1)
    const status = await current.spool.status()
    assert.equal(status.backlog_files, 2)
    assert.equal(status.boundary_files, 1)
    assert.equal(status.heartbeat_files, 1)
    assert.ok(status.backlog_bytes <= 16 * 1024)
  } finally {
    await current.cleanup()
  }
})

test('serializes concurrent hook writers so the configured hard cap cannot be exceeded', async () => {
  const current = await fixture({ maxFiles: 3, maxBytes: 24 * 1024 })
  const secondWriter = createEventSpool({
    directory: current.spoolDirectory,
    maxFiles: 3,
    maxBytes: 24 * 1024,
  })
  try {
    await Promise.all(Array.from({ length: 12 }, (_, index) => (
      (index % 2 === 0 ? current.spool : secondWriter).queue(event({
        external_event_id: `boundary-${index}`,
        source_session_key: `session-${index}`,
        source_turn_key: `turn-${index}`,
      }))
    )))
    const status = await current.spool.status()
    assert.equal(status.backlog_files, 3)
    assert.ok(status.backlog_bytes <= 24 * 1024)
  } finally {
    await current.cleanup()
  }
})

test('expires old records before admitting a new event', async () => {
  let now = Date.now()
  let uuid = 0
  const current = await fixture({
    maxAgeMs: 1_000,
    clock: () => new Date(now),
    uuid: () => `event-${uuid += 1}`,
  })
  try {
    await current.spool.queue(event({ external_event_id: 'old-event' }))
    now += 2_000
    const queued = await current.spool.queue(event({ external_event_id: 'new-event' }))
    assert.equal(queued.expired, 1)
    assert.equal((await current.spool.status()).backlog_files, 1)
  } finally {
    await current.cleanup()
  }
})

test('replay deletes only acknowledged events and retains the first transport failure', async () => {
  let now = Date.parse('2026-08-20T02:03:00.000Z')
  let uuid = 0
  const current = await fixture({
    clock: () => new Date(now += 1_000),
    uuid: () => `event-${uuid += 1}`,
  })
  try {
    await current.spool.queue(event({ external_event_id: 'event-1' }))
    await current.spool.queue(event({
      event_type: 'execution.stop',
      external_event_id: 'event-2',
      observed_at: '2026-08-20T02:04:00.000Z',
      payload: { end_reason: 'completed' },
    }))
    const sent = []
    const partial = await current.spool.replay(async (envelope) => {
      sent.push(envelope.external_event_id)
      if (envelope.external_event_id === 'event-2') throw new Error('taskd unavailable')
    })
    assert.deepEqual(sent, ['event-1', 'event-2'])
    assert.equal(partial.replayed, 1)
    assert.equal(partial.pending, 1)
    assert.equal(partial.last_error, 'SPOOL_REPLAY_SEND_FAILED')
    assert.equal((await current.spool.status()).last_replay_error, 'SPOOL_REPLAY_SEND_FAILED')

    const recovered = await current.spool.replay(async () => {})
    assert.equal(recovered.replayed, 1)
    assert.equal(recovered.pending, 0)
    assert.equal((await current.spool.status()).last_replay_error, null)
  } finally {
    await current.cleanup()
  }
})

test('replay isolates a permanent send rejection and continues with later events', async () => {
  let uuid = 0
  const current = await fixture({ uuid: () => `event-${uuid += 1}` })
  try {
    await current.spool.queue(event({ external_event_id: 'conflicting-event' }))
    await current.spool.queue(event({
      external_event_id: 'later-event',
      source_session_key: 'session-2',
      source_turn_key: 'turn-2',
    }))
    const sent = []
    const result = await current.spool.replay(async (envelope) => {
      sent.push(envelope.external_event_id)
      if (envelope.external_event_id === 'conflicting-event') {
        const error = new Error('observation identity changed on replay')
        error.code = 'OBSERVATION_IDENTITY_CONFLICT'
        throw error
      }
    }, {
      isPermanentError: (error) => error.code === 'OBSERVATION_IDENTITY_CONFLICT',
    })

    assert.deepEqual(sent, ['conflicting-event', 'later-event'])
    assert.equal(result.replayed, 1)
    assert.equal(result.isolated, 1)
    assert.equal(result.pending, 0)
    assert.equal(result.last_error, null)
    assert.equal((await current.spool.status()).last_replay_error, null)
    assert.equal((await readdir(current.spoolDirectory)).some((name) => name.endsWith('.invalid')), true)
  } finally {
    await current.cleanup()
  }
})

test('replay acknowledgement cannot delete a newer coalesced heartbeat', async () => {
  const current = await fixture()
  try {
    const heartbeat = {
      event_type: 'execution.heartbeat',
      payload: { activity: 'tool_use', coalesced_count: 1 },
    }
    await current.spool.queue(event({
      ...heartbeat,
      external_event_id: 'heartbeat-old',
    }))
    let releaseSend
    let markSendStarted
    const sendStarted = new Promise((resolve) => { markSendStarted = resolve })
    const replay = current.spool.replay(async () => {
      markSendStarted()
      await new Promise((resolve) => { releaseSend = resolve })
    })
    await sendStarted
    await current.spool.queue(event({
      ...heartbeat,
      external_event_id: 'heartbeat-new',
      observed_at: '2026-08-20T02:06:00.000Z',
      payload: { activity: 'tool_use', coalesced_count: 2 },
    }))
    releaseSend()
    await replay

    assert.equal((await current.spool.status()).backlog_files, 1)
    const [name] = await readdir(current.spoolDirectory)
    const stored = JSON.parse((await readFile(join(current.spoolDirectory, name), 'utf8')).trim())
    assert.equal(stored.external_event_id, 'heartbeat-new')
  } finally {
    await current.cleanup()
  }
})

test('replay recovers a stale claim left by a crashed process', async () => {
  const current = await fixture({ lockStaleMs: 10 })
  try {
    const queued = await current.spool.queue(event())
    const claimed = `${queued.path}.replaying-crashed-process`
    await rename(queued.path, claimed)
    const old = new Date(Date.now() - 60_000)
    await utimes(claimed, old, old)

    const sent = []
    const result = await current.spool.replay(async (envelope) => {
      sent.push(envelope.external_event_id)
    })
    assert.deepEqual(sent, ['codex:session-1:turn-1:start'])
    assert.equal(result.replayed, 1)
    assert.equal(result.recovered_claims, 1)
    assert.equal((await current.spool.status()).claim_files, 0)
  } finally {
    await current.cleanup()
  }
})

test('isolates a corrupt record and continues replaying later valid events', async () => {
  const current = await fixture({
    clock: () => new Date('2026-08-20T02:05:00.000Z'),
    uuid: () => 'valid-1',
  })
  try {
    await current.spool.queue(event())
    await writeFile(join(current.spoolDirectory, '0000000000000-boundary-corrupt.ndjson'), '{bad', {
      mode: 0o600,
    })
    const sent = []
    const result = await current.spool.replay(async (envelope) => {
      sent.push(envelope.external_event_id)
    })
    assert.deepEqual(sent, ['codex:session-1:turn-1:start'])
    assert.equal(result.replayed, 1)
    assert.equal(result.isolated, 1)
    assert.equal(result.pending, 0)
    assert.equal((await readdir(current.spoolDirectory)).some((name) => name.endsWith('.invalid')), true)
  } finally {
    await current.cleanup()
  }
})
