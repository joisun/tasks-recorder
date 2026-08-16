import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { readCodexTranscriptMetadata } from '../adapters/codex/tasks-recorder/hooks/src/codex-transcript.mjs'
import {
  fetchSessionContext,
  sendLifecycle,
} from '../adapters/codex/tasks-recorder/hooks/src/taskd-client.mjs'

async function transcriptFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'tasks-recorder-codex-transcript-'))
  const sessionsRoot = join(directory, 'sessions')
  await mkdir(sessionsRoot)
  return {
    directory,
    sessionsRoot,
    path(name) { return join(sessionsRoot, name) },
    async cleanup() { await rm(directory, { recursive: true, force: true }) },
  }
}

test('reads root and child session metadata without returning transcript content', async () => {
  const fixture = await transcriptFixture()
  try {
    const rootPath = fixture.path('root.jsonl')
    await writeFile(rootPath, [
      JSON.stringify({
        timestamp: '2026-08-14T01:00:00.000Z',
        type: 'session_meta',
        payload: {
          id: 'root-session', cwd: '/workspace/root',
          git: { branch: 'main', repository_url: 'git@example.test:root.git' },
          source: 'cli',
        },
      }),
      JSON.stringify({ type: 'response_item', payload: { content: 'must-not-leak' } }),
    ].join('\n'))
    const childPath = fixture.path('child.jsonl')
    await writeFile(childPath, JSON.stringify({
      type: 'session_meta',
      payload: {
        id: 'child-session', cwd: '/workspace/root',
        source: {
          subagent: {
            thread_spawn: {
              parent_thread_id: 'root-session',
              agent_path: '/root/researcher',
              agent_type: 'explorer',
            },
          },
        },
      },
    }))

    const root = await readCodexTranscriptMetadata(rootPath, { sessionsRoot: fixture.sessionsRoot })
    assert.deepEqual(root, {
      metadata: {
        session_id: 'root-session',
        parent_session_id: null,
        agent_path: null,
        agent_type: null,
        workfolder: '/workspace/root',
        branch: 'main',
        repository: 'git@example.test:root.git',
        transcript_path: await realpath(rootPath),
      },
      warnings: [],
    })
    assert.equal(JSON.stringify(root).includes('must-not-leak'), false)

    const child = await readCodexTranscriptMetadata(childPath, { sessionsRoot: fixture.sessionsRoot })
    assert.equal(child.metadata.session_id, 'child-session')
    assert.equal(child.metadata.parent_session_id, 'root-session')
    assert.equal(child.metadata.agent_path, '/root/researcher')
    assert.equal(child.metadata.agent_type, 'explorer')
  } finally {
    await fixture.cleanup()
  }
})

test('returns structured warnings for missing, malformed, truncated, and escaped transcripts', async () => {
  const fixture = await transcriptFixture()
  try {
    const malformedPath = fixture.path('malformed.jsonl')
    await writeFile(malformedPath, '{not-json}\n')
    const truncatedPath = fixture.path('truncated.jsonl')
    await writeFile(truncatedPath, `${'x'.repeat(128)}\n${JSON.stringify({
      type: 'session_meta', payload: { id: 'too-late', cwd: '/workspace' },
    })}\n`)
    const outsidePath = join(fixture.directory, 'outside.jsonl')
    await writeFile(outsidePath, JSON.stringify({
      type: 'session_meta', payload: { id: 'outside', cwd: '/outside' },
    }))
    const escapedPath = fixture.path('escaped.jsonl')
    await symlink(outsidePath, escapedPath)

    const missing = await readCodexTranscriptMetadata(fixture.path('missing.jsonl'), {
      sessionsRoot: fixture.sessionsRoot,
    })
    assert.equal(missing.metadata, null)
    assert.deepEqual(missing.warnings.map(({ code }) => code), ['TRANSCRIPT_UNAVAILABLE'])

    const malformed = await readCodexTranscriptMetadata(malformedPath, {
      sessionsRoot: fixture.sessionsRoot,
    })
    assert.equal(malformed.metadata, null)
    assert.deepEqual(malformed.warnings.map(({ code }) => code), ['SESSION_META_MALFORMED'])

    const truncated = await readCodexTranscriptMetadata(truncatedPath, {
      sessionsRoot: fixture.sessionsRoot,
      maxBytes: 64,
    })
    assert.equal(truncated.metadata, null)
    assert.deepEqual(truncated.warnings.map(({ code }) => code), ['TRANSCRIPT_METADATA_LIMIT'])

    const escaped = await readCodexTranscriptMetadata(escapedPath, {
      sessionsRoot: fixture.sessionsRoot,
    })
    assert.equal(escaped.metadata, null)
    assert.deepEqual(escaped.warnings.map(({ code }) => code), ['TRANSCRIPT_PATH_REJECTED'])
  } finally {
    await fixture.cleanup()
  }
})

test('lifecycle client sends bounded loopback requests and fetches session context', async () => {
  const requests = []
  const server = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    requests.push({
      method: request.method,
      url: request.url,
      body: chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null,
    })
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify(request.method === 'GET'
      ? { root_session_id: 'root-session', active_execution_count: 1 }
      : { changed: true }))
  })
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  const { port } = server.address()
  const env = { AGENT_TASKS_SERVER_URL: `http://127.0.0.1:${port}` }
  try {
    assert.deepEqual(await sendLifecycle('turn-start', {
      root_session_id: 'root-session', session_id: 'root-session', turn_id: 'turn-1',
    }, env), { changed: true })
    assert.deepEqual(await fetchSessionContext('root-session', env), {
      root_session_id: 'root-session', active_execution_count: 1,
    })
    assert.deepEqual(requests, [
      {
        method: 'POST',
        url: '/api/v1/lifecycle/turn-start',
        body: { root_session_id: 'root-session', session_id: 'root-session', turn_id: 'turn-1' },
      },
      { method: 'GET', url: '/api/v1/sessions/root-session/context', body: null },
    ])
  } finally {
    await new Promise((resolveClose, reject) => server.close((error) => (
      error ? reject(error) : resolveClose()
    )))
  }
})

test('lifecycle client rejects unknown events and non-loopback origins', async () => {
  await assert.rejects(
    sendLifecycle('unknown-event', {}, { AGENT_TASKS_SERVER_URL: 'http://127.0.0.1:43127' }),
    /lifecycle event/,
  )
  await assert.rejects(
    fetchSessionContext('session-1', { AGENT_TASKS_SERVER_URL: 'http://localhost:43127' }),
    /127\.0\.0\.1/,
  )
})
