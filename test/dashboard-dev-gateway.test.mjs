import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import test from 'node:test'

import {
  createDashboardDevGateway,
  injectDashboardReloadClient,
  resolveDashboardDevConfig,
} from '../ui/dev-gateway.mjs'

test('dev config defaults to a distinct loopback listener and taskd upstream', () => {
  const config = resolveDashboardDevConfig({ env: {} })
  assert.deepEqual(
    { host: config.host, port: config.port, upstream: config.upstream.href },
    { host: '127.0.0.1', port: 43128, upstream: 'http://127.0.0.1:43127/' },
  )
})

test('dev config accepts valid overrides and rejects unsafe endpoints', () => {
  const overridden = resolveDashboardDevConfig({
    env: {
      TASKS_RECORDER_DEV_PORT: '44128',
      TASKS_RECORDER_DEV_UPSTREAM: 'http://127.0.0.1:44127',
    },
  })
  assert.equal(overridden.port, 44128)
  assert.equal(overridden.upstream.href, 'http://127.0.0.1:44127/')

  for (const env of [
    { TASKS_RECORDER_DEV_PORT: '0' },
    { TASKS_RECORDER_DEV_PORT: '43127' },
    { TASKS_RECORDER_DEV_UPSTREAM: 'http://0.0.0.0:43127' },
    { TASKS_RECORDER_DEV_UPSTREAM: 'https://127.0.0.1:43127' },
    { TASKS_RECORDER_DEV_UPSTREAM: 'http://user:pass@127.0.0.1:43127' },
    { TASKS_RECORDER_DEV_UPSTREAM: 'http://127.0.0.1:43127/api' },
  ]) assert.throws(() => resolveDashboardDevConfig({ env }), /dev|port|upstream|loopback/i)
})

test('reload client is injected once and remains absent from source HTML', () => {
  const source = '<!doctype html><body><main>Dashboard</main></body>'
  const injected = injectDashboardReloadClient(source)
  assert.doesNotMatch(source, /__tasks_recorder_dev/)
  assert.equal((injected.match(/__tasks_recorder_dev\/reload/g) ?? []).length, 1)
  assert.match(injected, /new EventSource/)
  assert.match(injected, /addEventListener\(['"]reload['"]/)
  assert.match(injected, /location\.reload/)
  assert.equal(injectDashboardReloadClient(injected), injected)
})

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address()
  return `http://127.0.0.1:${port}`
}

async function close(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
  })
}

async function rawStatus(url, headers) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { headers }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => resolve({
        status: response.statusCode,
        body: Buffer.concat(chunks).toString('utf8'),
      }))
    })
    request.on('error', reject)
    request.end()
  })
}

const sseReaderStates = new WeakMap()

async function readSseEvent(reader) {
  let state = sseReaderStates.get(reader)
  if (!state) {
    state = { source: '', decoder: new TextDecoder() }
    sseReaderStates.set(reader, state)
  }
  while (!state.source.includes('\n\n')) {
    const { value, done } = await reader.read()
    if (done) throw new Error('SSE stream ended before an event arrived')
    state.source += state.decoder.decode(value, { stream: true })
  }
  const boundary = state.source.indexOf('\n\n') + 2
  const event = state.source.slice(0, boundary)
  state.source = state.source.slice(boundary)
  return event
}

test('gateway serves HTML and securely proxies methods, origins, bodies, and SSE', async (t) => {
  const seen = []
  const upstreamServer = createServer((request, response) => {
    if (request.url === '/api/v1/events') {
      response.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
      })
      response.write('event: ready\ndata: {"revision":0}\n\n')
      return
    }
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      seen.push({
        method: request.method,
        url: request.url,
        host: request.headers.host,
        origin: request.headers.origin,
        body: Buffer.concat(chunks).toString('utf8'),
      })
      response.writeHead(207, {
        'Content-Type': 'application/json',
        'X-Upstream': 'taskd',
      })
      response.end('{"ok":true}')
    })
  })
  const upstreamUrl = await listen(upstreamServer)
  t.after(async () => {
    if (upstreamServer.listening) await close(upstreamServer)
  })
  const upstream = new URL(upstreamUrl)
  const gateway = createDashboardDevGateway({
    host: '127.0.0.1',
    port: 0,
    upstream,
    getHtml: () => '<!doctype html><body>source</body>',
  })
  const address = await gateway.listen()
  let eventReader
  try {
    const htmlResponse = await fetch(address.url)
    assert.equal(htmlResponse.headers.get('content-type'), 'text/html; charset=utf-8')
    assert.equal(htmlResponse.headers.get('cache-control'), 'no-cache')
    assert.match(htmlResponse.headers.get('content-security-policy'), /connect-src 'self'/)
    const html = await htmlResponse.text()
    assert.match(html, /source/)
    assert.match(html, /__tasks_recorder_dev\/reload/)

    const mutation = await fetch(`${address.url}/api/v1/tasks/example`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Origin: address.url },
      body: '{"status":"done"}',
    })
    assert.equal(mutation.status, 207)
    assert.equal(mutation.headers.get('x-upstream'), 'taskd')
    assert.deepEqual(seen[0], {
      method: 'PATCH',
      url: '/api/v1/tasks/example',
      host: upstream.host,
      origin: upstream.origin,
      body: '{"status":"done"}',
    })

    assert.equal((await rawStatus(`${address.url}/health/live`, {
      Host: 'attacker.example',
    })).status, 403)
    assert.equal((await rawStatus(`${address.url}/health/live`, {
      Host: new URL(address.url).host,
      Origin: 'https://attacker.example',
    })).status, 403)

    const events = await fetch(`${address.url}/api/v1/events`)
    eventReader = events.body.getReader()
    assert.match(await readSseEvent(eventReader), /event: ready/)

    assert.equal((await fetch(`${address.url}/missing`)).status, 404)
  } finally {
    await eventReader?.cancel().catch(() => {})
    await gateway.close()
  }
})

test('gateway returns bounded 502 and keeps serving HTML when upstream is unavailable', async () => {
  const closedServer = createServer()
  const closedUrl = await listen(closedServer)
  await close(closedServer)
  const gateway = createDashboardDevGateway({
    host: '127.0.0.1',
    port: 0,
    upstream: new URL(closedUrl),
    getHtml: () => '<!doctype html><body>last good</body>',
  })
  const address = await gateway.listen()
  try {
    const unavailable = await fetch(`${address.url}/api/v1/snapshot`)
    assert.equal(unavailable.status, 502)
    assert.deepEqual(await unavailable.json(), {
      ok: false,
      error: {
        code: 'DEV_UPSTREAM_UNAVAILABLE',
        message: 'Tasks Recorder upstream is unavailable',
      },
    })
    assert.match(await fetch(address.url).then((response) => response.text()), /last good/)
  } finally {
    await gateway.close()
  }
})

test('gateway broadcasts one reload event on the dedicated dev SSE channel', async () => {
  const gateway = createDashboardDevGateway({
    host: '127.0.0.1',
    port: 0,
    upstream: new URL('http://127.0.0.1:43127'),
    getHtml: () => '<!doctype html><body>source</body>',
  })
  const address = await gateway.listen()
  let reader
  try {
    const response = await fetch(`${address.url}/__tasks_recorder_dev/reload`)
    reader = response.body.getReader()
    assert.match(await readSseEvent(reader), /event: ready/)
    gateway.broadcastReload()
    assert.match(await readSseEvent(reader), /event: reload/)
  } finally {
    await reader?.cancel().catch(() => {})
    await gateway.close()
  }
})
