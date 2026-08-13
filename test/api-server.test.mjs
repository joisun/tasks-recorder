import assert from 'node:assert/strict'
import { request as httpRequest } from 'node:http'
import test from 'node:test'

import { createTaskService } from '../mcp/src/task-service.mjs'
import { createApiServer } from '../server/src/api-server.mjs'
import { createRevisionHub } from '../server/src/revision-hub.mjs'
import { taskInput, temporaryStore } from './helpers.mjs'

async function fixture() {
  const temporary = await temporaryStore({ clock: () => new Date('2026-08-12T08:00:00.000Z') })
  const hub = createRevisionHub({ instanceId: 'server-test', keepaliveMs: 60_000 })
  const service = createTaskService({
    store: temporary.store,
    gitResolver: async () => ({ gitRoot: '/workspace', worktree: '/workspace', branch: 'main' }),
    renderer: async () => ({ tasksPath: '/tmp/Tasks.md', historyPath: '/tmp/History.md' }),
    outputDir: temporary.directory,
    dashboardPath: '/plugin/ui/dist/index.html',
    dashboardAdapter: (snapshot) => ({
      generated_at: '2026-08-12T08:00:00.000Z',
      tasks: snapshot.tasks,
      warnings: [],
    }),
    onChange: (change) => hub.publish(change),
  })
  const api = createApiServer({
    service,
    store: temporary.store,
    hub,
    host: '127.0.0.1',
    port: 0,
    dashboardHtml: '<!doctype html><title>Tasks Recorder</title>',
  })
  const address = await api.listen()
  return {
    ...temporary,
    hub,
    api,
    url: address.url,
    async cleanup() {
      await api.close()
      hub.close()
      await temporary.cleanup()
    },
  }
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

test('SSE test reader preserves a second event received in the same network chunk', async () => {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('retry: 1000\n\nevent: ready\ndata: {"revision":0}\n\n'))
      controller.close()
    },
  })
  const reader = stream.getReader()

  assert.equal(await readSseEvent(reader), 'retry: 1000\n\n')
  assert.equal(await readSseEvent(reader), 'event: ready\ndata: {"revision":0}\n\n')
})

async function rawRequest(url, headers) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { headers }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => resolve({
        status: response.statusCode,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      }))
    })
    request.on('error', reject)
    request.end()
  })
}

test('task commit publishes SSE invalidation and snapshot exposes the committed revision', async () => {
  const current = await fixture()
  let reader
  try {
    const stream = await fetch(`${current.url}/api/v1/events`)
    reader = stream.body.getReader()
    const ready = await readSseEvent(reader)
    assert.match(ready, /retry: 1000/)
    const readyEvent = await readSseEvent(reader)
    assert.match(readyEvent, /event: ready/)
    assert.match(readyEvent, /"revision":0/)

    const write = await fetch(`${current.url}/api/v1/tasks/example-task`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(taskInput()),
    })
    assert.equal(write.status, 200)
    assert.equal((await write.json()).change.revision, 1)

    const changed = await readSseEvent(reader)
    assert.match(changed, /event: changed/)
    assert.match(changed, /"revision":1/)

    const snapshot = await fetch(`${current.url}/api/v1/snapshot`).then((response) => response.json())
    assert.equal(snapshot.server_instance_id, 'server-test')
    assert.equal(snapshot.revision, 1)
    assert.equal(snapshot.tasks[0].id, 'example-task')
  } finally {
    await reader?.cancel().catch(() => {})
    await current.cleanup()
  }
})

test('local routes require loopback Host and same Origin without CORS', async () => {
  const current = await fixture()
  try {
    const localList = await fetch(`${current.url}/api/v1/tasks`)
    assert.equal(localList.status, 200)

    const wrongOrigin = await fetch(`${current.url}/api/v1/snapshot`, {
      headers: { Origin: 'https://attacker.example' },
    })
    assert.equal(wrongOrigin.status, 403)
    assert.equal((await wrongOrigin.json()).error.code, 'ORIGIN_REJECTED')

    const snapshot = await fetch(`${current.url}/api/v1/snapshot`)
    assert.equal(snapshot.status, 200)
    assert.equal(snapshot.headers.get('access-control-allow-origin'), null)

    const wrongHost = await rawRequest(`${current.url}/health/live`, { Host: 'attacker.example' })
    assert.equal(wrongHost.status, 403)
    assert.equal(wrongHost.body.error.code, 'HOST_REJECTED')
  } finally {
    await current.cleanup()
  }
})

test('API routes cover context, list, show, complete, heartbeat, render, check, health and static UI', async () => {
  const current = await fixture()
  try {
    const html = await fetch(`${current.url}/`)
    assert.equal(html.headers.get('content-type'), 'text/html; charset=utf-8')
    assert.match(await html.text(), /Tasks Recorder/)
    const favicon = await fetch(`${current.url}/favicon.ico`)
    assert.equal(favicon.status, 204)
    assert.equal(await favicon.text(), '')
    const live = await fetch(`${current.url}/health/live`).then((response) => response.json())
    assert.equal(live.ok, true)
    assert.equal(live.service, 'tasks-recorder')
    assert.equal((await fetch(`${current.url}/health/ready`).then((response) => response.json())).ready, true)

    await fetch(`${current.url}/api/v1/tasks/example-task`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(taskInput()),
    })
    const list = await fetch(`${current.url}/api/v1/tasks?status=active`).then((response) => response.json())
    assert.equal(list.tasks.length, 1)
    const shown = await fetch(`${current.url}/api/v1/tasks/example-task`).then((response) => response.json())
    assert.equal(shown.task.id, 'example-task')
    const context = await fetch(`${current.url}/api/v1/context`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: 'session-1', workfolder: '/workspace/example' }),
    }).then((response) => response.json())
    assert.equal(context.candidates[0].task.id, 'example-task')
    const heartbeat = await fetch(`${current.url}/api/v1/heartbeat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: 'session-1', minimum_interval_ms: 0 }),
    }).then((response) => response.json())
    assert.equal(heartbeat.updated, true)
    const completed = await fetch(`${current.url}/api/v1/tasks/example-task/complete`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: 'session-1', workfolder: '/workspace/example' }),
    }).then((response) => response.json())
    assert.equal(completed.task.status, 'done')
    const rendered = await fetch(`${current.url}/api/v1/render`, { method: 'POST' }).then((response) => response.json())
    assert.equal(rendered.projection_updated, true)
    const checked = await fetch(`${current.url}/api/v1/check`).then((response) => response.json())
    assert.equal(checked.schemaVersion, 1)
  } finally {
    await current.cleanup()
  }
})

test('invalid writes return stable errors without publishing a revision', async () => {
  const current = await fixture()
  try {
    const invalid = await fetch(`${current.url}/api/v1/tasks/Bad-ID`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{"id":"Bad-ID"}',
    })
    assert.equal(invalid.status, 400)
    assert.equal((await invalid.json()).error.code, 'TASK_ID_INVALID')
    assert.equal(current.hub.current().revision, 0)

    const malformed = await fetch(`${current.url}/api/v1/context`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{',
    })
    assert.equal(malformed.status, 400)
    assert.equal((await malformed.json()).error.code, 'JSON_INVALID')
    assert.equal(current.hub.current().revision, 0)
  } finally {
    await current.cleanup()
  }
})

test('status PATCH validates version and publishes one revision', async () => {
  const current = await fixture()
  try {
    const created = await fetch(`${current.url}/api/v1/tasks/example-task`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(taskInput()),
    }).then((response) => response.json())

    const response = await fetch(`${current.url}/api/v1/tasks/example-task/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Origin: current.url },
      body: JSON.stringify({
        status: 'blocked',
        expected_updated_at: created.task.updated_at,
      }),
    })
    const body = await response.json()
    assert.equal(response.status, 200)
    assert.equal(body.task.status, 'blocked')
    assert.equal(body.changed, true)
    assert.equal(body.change.revision, 2)

    const stale = await fetch(`${current.url}/api/v1/tasks/example-task/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Origin: current.url },
      body: JSON.stringify({ status: 'done', expected_updated_at: created.task.updated_at }),
    })
    assert.equal(stale.status, 409)
    assert.equal((await stale.json()).error.code, 'TASK_VERSION_CONFLICT')
    assert.equal(current.hub.current().revision, 2)
  } finally {
    await current.cleanup()
  }
})

test('status PATCH preserves transport guards and stable domain errors', async () => {
  const current = await fixture()
  try {
    const parent = await fetch(`${current.url}/api/v1/tasks/parent`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(taskInput({ id: 'parent', title: 'Parent' })),
    }).then((response) => response.json())
    await fetch(`${current.url}/api/v1/tasks/child`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(taskInput({ id: 'child', parent_id: 'parent', title: 'Child' })),
    })
    const revision = current.hub.current().revision

    const cases = [
      {
        name: 'content type',
        expectedStatus: 415,
        expectedCode: 'CONTENT_TYPE_REQUIRED',
        options: { method: 'PATCH', body: '{}' },
      },
      {
        name: 'malformed json',
        expectedStatus: 400,
        expectedCode: 'JSON_INVALID',
        options: { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{' },
      },
      {
        name: 'invalid status',
        expectedStatus: 400,
        expectedCode: 'TASK_STATUS_INVALID',
        options: {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'stale', expected_updated_at: parent.task.updated_at }),
        },
      },
      {
        name: 'missing task',
        path: 'missing',
        expectedStatus: 404,
        expectedCode: 'TASK_NOT_FOUND',
        options: {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'done', expected_updated_at: parent.task.updated_at }),
        },
      },
      {
        name: 'incomplete children',
        expectedStatus: 409,
        expectedCode: 'CHILD_TASKS_INCOMPLETE',
        options: {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'done', expected_updated_at: parent.task.updated_at }),
        },
      },
      {
        name: 'wrong origin',
        expectedStatus: 403,
        expectedCode: 'ORIGIN_REJECTED',
        options: {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Origin: 'https://attacker.example' },
          body: JSON.stringify({ status: 'blocked', expected_updated_at: parent.task.updated_at }),
        },
      },
    ]

    for (const currentCase of cases) {
      const response = await fetch(
        `${current.url}/api/v1/tasks/${currentCase.path ?? 'parent'}/status`,
        currentCase.options,
      )
      assert.equal(response.status, currentCase.expectedStatus, currentCase.name)
      assert.equal((await response.json()).error.code, currentCase.expectedCode, currentCase.name)
    }
    assert.equal(current.hub.current().revision, revision)
  } finally {
    await current.cleanup()
  }
})
