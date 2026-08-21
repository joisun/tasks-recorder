import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createJournalEventClient as createClaudeJournalEventClient } from '../adapters/claude/tasks-recorder/hooks/src/journal-client.mjs'
import { createJournalEventClient as createCodexJournalEventClient } from '../adapters/codex/tasks-recorder/hooks/src/journal-client.mjs'
import { createJournalEventClient } from '../hooks/src/journal-client.mjs'

function event(overrides = {}) {
  return {
    source: 'codex',
    event_type: 'execution.stop',
    external_event_id: 'session-1:turn-1:stop',
    observed_at: '2026-08-20T05:00:00.000Z',
    source_session_key: 'session-1',
    source_turn_key: 'turn-1',
    source_agent_key: null,
    workfolder: '/workspace/project-a',
    git_root: '/workspace/project-a',
    git_common_dir: '/workspace/project-a/.git',
    git_remote: null,
    worktree: '/workspace/project-a',
    branch: 'feature/a',
    payload: { end_reason: 'completed' },
    ...overrides,
  }
}

async function fixture(options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'tasks-recorder-delivery-'))
  return {
    directory,
    client: createJournalEventClient({
      baseUrl: 'http://127.0.0.1:43127',
      spoolDirectory: join(directory, 'spool'),
      ...options,
    }),
    async cleanup() {
      await rm(directory, { recursive: true, force: true })
    },
  }
}

test('root, Codex and Claude delivery clients keep the same fail-open contract', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tasks-recorder-delivery-parity-'))
  const implementations = [
    ['root', createJournalEventClient],
    ['codex', createCodexJournalEventClient],
    ['claude', createClaudeJournalEventClient],
  ]
  try {
    for (const [name, create] of implementations) {
      const client = create({
        baseUrl: 'http://127.0.0.1:43127',
        spoolDirectory: join(directory, name),
        fetchImpl: async () => { throw new Error('unavailable') },
      })
      const result = await client.deliver(event())
      assert.equal(result.ok, true)
      assert.equal(result.spooled, true)
      assert.equal((await client.spool.status()).backlog_files, 1)
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('delivers a validated boundary event directly with a bounded timeout', async () => {
  let request
  const current = await fixture({
    fetchImpl: async (url, options) => {
      request = { url, options }
      return { ok: true, status: 200, json: async () => ({ ok: true, persisted: true }) }
    },
  })
  try {
    const result = await current.client.deliver(event())
    assert.equal(result.delivered, true)
    assert.equal(result.spooled, false)
    assert.equal(request.url, 'http://127.0.0.1:43127/api/v1/events')
    assert.equal(request.options.method, 'POST')
    assert.ok(request.options.signal)
    assert.equal((await current.client.spool.status()).backlog_files, 0)
  } finally {
    await current.cleanup()
  }
})

test('fails open and spools the validated event when taskd is unavailable', async () => {
  const current = await fixture({ fetchImpl: async () => { throw new Error('unavailable') } })
  try {
    const result = await current.client.deliver(event())
    assert.deepEqual(result, {
      ok: true,
      delivered: false,
      spooled: true,
      dropped: false,
      error_code: 'TASKD_UNAVAILABLE',
    })
    assert.equal((await current.client.spool.status()).backlog_files, 1)
  } finally {
    await current.cleanup()
  }
})

test('does not poison the spool with invalid or permanent 4xx events', async () => {
  let fetchCalls = 0
  const current = await fixture({
    fetchImpl: async () => {
      fetchCalls += 1
      return { ok: false, status: 409, json: async () => ({ ok: false }) }
    },
  })
  try {
    const invalid = await current.client.deliver(event({ prompt: 'private' }))
    assert.equal(invalid.dropped, true)
    assert.equal(invalid.error_code, 'EVENT_ENVELOPE_INVALID')
    assert.equal(fetchCalls, 0)

    const rejected = await current.client.deliver(event())
    assert.equal(rejected.dropped, true)
    assert.equal(rejected.error_code, 'TASKD_EVENT_REJECTED')
    assert.equal(rejected.http_status, 409)
    assert.equal((await current.client.spool.status()).backlog_files, 0)
  } finally {
    await current.cleanup()
  }
})

test('spool failure remains fail-open and returns only a stable diagnostic code', async () => {
  const current = await fixture({
    fetchImpl: async () => { throw new Error('unavailable') },
    createSpool: () => ({
      queue: async () => { throw new Error('disk full with secret path') },
      status: async () => ({}),
    }),
  })
  try {
    assert.deepEqual(await current.client.deliver(event()), {
      ok: true,
      delivered: false,
      spooled: false,
      dropped: true,
      error_code: 'SPOOL_WRITE_FAILED',
    })
  } finally {
    await current.cleanup()
  }
})
