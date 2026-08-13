import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'

import { createTaskClient } from '../mcp/src/task-client.mjs'
import { taskInput } from './helpers.mjs'

async function recordingServer() {
  const requests = []
  const server = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    requests.push({
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization,
      body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null,
    })
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ ok: true, tasks: [], candidates: [] }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    requests,
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  }
}

test('task client maps every operation to the token-free versioned HTTP contract', async () => {
  const recorder = await recordingServer()
  const client = createTaskClient({ baseUrl: recorder.url, timeoutMs: 1_000 })
  try {
    await client.context({ session_id: 'session-1', workfolder: '/workspace' })
    await client.list({ status: 'active', branch: 'feature/a' })
    await client.show('task-a')
    await client.upsert(taskInput({ id: 'task-a' }))
    await client.complete({ id: 'task-a', session_id: 'session-1', workfolder: '/workspace' })
    await client.render()
    await client.check()
    await client.updateStatus({
      id: 'task-a',
      status: 'blocked',
      expected_updated_at: '2026-08-12T08:00:00.000Z',
    })

    assert.deepEqual(
      recorder.requests.map(({ method, url }) => [method, url]),
      [
        ['POST', '/api/v1/context'],
        ['GET', '/api/v1/tasks?status=active&branch=feature%2Fa'],
        ['GET', '/api/v1/tasks/task-a'],
        ['PUT', '/api/v1/tasks/task-a'],
        ['POST', '/api/v1/tasks/task-a/complete'],
        ['POST', '/api/v1/render'],
        ['GET', '/api/v1/check'],
        ['PATCH', '/api/v1/tasks/task-a/status'],
      ],
    )
    assert.ok(recorder.requests.every(({ authorization }) => authorization === undefined))
    assert.equal(recorder.requests[3].body.id, 'task-a')
    assert.deepEqual(recorder.requests.at(-1).body, {
      status: 'blocked',
      expected_updated_at: '2026-08-12T08:00:00.000Z',
    })
  } finally {
    await recorder.close()
  }
})

test('task client preserves domain codes and normalizes connectivity errors', async () => {
  const unavailable = createTaskClient({
    baseUrl: 'http://127.0.0.1:1',
    fetchImpl: async () => { throw new Error('low-level connection detail') },
  })
  await assert.rejects(
    unavailable.list({}),
    (error) => error.code === 'SERVICE_UNAVAILABLE'
      && !error.message.includes('low-level connection detail'),
  )

  const domain = createTaskClient({
    baseUrl: 'http://127.0.0.1:1',
    fetchImpl: async () => new Response(JSON.stringify({
      ok: false,
      error: { code: 'TASK_NOT_FOUND', message: 'task missing', details: { id: 'missing' } },
    }), { status: 404, headers: { 'Content-Type': 'application/json' } }),
  })
  await assert.rejects(
    domain.show('missing'),
    (error) => error.code === 'TASK_NOT_FOUND' && error.details.id === 'missing',
  )
})
