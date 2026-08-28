import assert from 'node:assert/strict'
import test from 'node:test'

import { createApiServer } from '../server/src/api-server.mjs'
import { createRevisionHub } from '../server/src/revision-hub.mjs'

const SCHEDULE_ID = '11111111-1111-4111-8111-111111111111'
const RUN_ID = '22222222-2222-4222-8222-222222222222'

function schedule() {
  return {
    id: SCHEDULE_ID,
    etag: 'a'.repeat(64),
    title: 'Daily review',
    prompt: 'Private prompt loaded by taskd.',
    workspace: '/tmp/project',
    cadence: { kind: 'daily', hour: 9, minute: 30, timezone_mode: 'system' },
    enabled: true,
    agent: 'codex',
    sandbox_mode: 'read-only',
    timeout_seconds: 7_200,
  }
}

async function fixture() {
  const calls = []
  const run = {
    id: RUN_ID,
    schedule_id: SCHEDULE_ID,
    runtime_id: 'codex',
    origin: 'manual',
    status: 'queued',
    interactive: true,
    turn_revision: 2,
    created_at: '2026-08-27T09:00:00.000Z',
  }
  const runService = {
    create: async (input) => {
      calls.push(['create', input])
      return { run }
    },
    list: () => [run],
    get: () => run,
    cancel: () => ({ ...run, status: 'canceled' }),
    steer: async (id, input) => {
      calls.push(['steer', id, input])
      return { accepted: true, run_id: id, turn_revision: input.expected_turn_revision }
    },
    stop: async (id, input) => {
      calls.push(['stop', id, input])
      return { accepted: true, run_id: id, turn_revision: input.expected_turn_revision }
    },
    markReviewed: () => ({ ...run, status: 'succeeded', reviewed_at: 'now' }),
    events: (id, listener, options) => {
      calls.push(['events', id, options])
      listener({
        runId: id,
        sequence: 3,
        observedAt: '2026-08-27T09:00:03.000Z',
        type: 'status',
        payload: { state: 'running' },
      })
      return () => calls.push(['unsubscribe', id])
    },
  }
  const schedulerService = {
    getJob: async (id) => {
      assert.equal(id, SCHEDULE_ID)
      return { job: schedule() }
    },
  }
  const hub = createRevisionHub({ instanceId: 'run-api-test', keepaliveMs: 60_000 })
  const api = createApiServer({
    service: {},
    store: {},
    hub,
    host: '127.0.0.1',
    port: 0,
    dashboardHtml: '<!doctype html>',
    schedulerService,
    runService,
    apiVersion: 4,
  })
  const address = await api.listen()
  return {
    url: address.url,
    calls,
    async close() {
      await api.close()
      hub.close()
    },
  }
}

async function json(url, path, { method = 'GET', body } = {}) {
  const response = await fetch(`${url}${path}`, {
    method,
    ...(body === undefined ? {} : {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  })
  return { status: response.status, body: await response.json() }
}

test('POST /runs loads the trusted Schedule and returns its durable queued Run', async () => {
  const current = await fixture()
  try {
    const result = await json(current.url, '/api/v1/runs', {
      method: 'POST',
      body: {
        schedule_id: SCHEDULE_ID,
        origin: 'manual',
        idempotency_key: '33333333-3333-4333-8333-333333333333',
      },
    })
    assert.equal(result.status, 202)
    assert.equal(result.body.run.status, 'queued')
    assert.equal(current.calls[0][1].schedule.prompt, 'Private prompt loaded by taskd.')
    assert.equal(JSON.stringify(result.body).includes('Private prompt'), false)
  } finally {
    await current.close()
  }
})

test('POST /runs rejects browser-provided process authority', async () => {
  const current = await fixture()
  try {
    const result = await json(current.url, '/api/v1/runs', {
      method: 'POST',
      body: {
        schedule_id: SCHEDULE_ID,
        origin: 'manual',
        idempotency_key: 'request-1',
        command: 'rm -rf /',
      },
    })
    assert.equal(result.status, 400)
    assert.equal(current.calls.length, 0)
  } finally {
    await current.close()
  }
})

test('Run SSE emits reset before replay when the requested sequence has a gap', async () => {
  const current = await fixture()
  const controller = new AbortController()
  try {
    const response = await fetch(`${current.url}/api/v1/runs/${RUN_ID}/events?after=1`, {
      signal: controller.signal,
    })
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type'), /text\/event-stream/)
    const reader = response.body.getReader()
    let text = ''
    while (!text.includes('id: 3')) {
      const { value, done } = await reader.read()
      if (done) break
      text += new TextDecoder().decode(value)
    }
    assert.match(text, /event: reset/)
    assert.match(text, /id: 3/)
    assert.match(text, /"state":"running"/)
    controller.abort()
    await reader.cancel().catch(() => {})
  } finally {
    controller.abort()
    await current.close()
  }
})

test('Run control routes accept only a public Turn revision and never echo guidance', async () => {
  const current = await fixture()
  try {
    const steered = await json(current.url, `/api/v1/runs/${RUN_ID}/steer`, {
      method: 'POST',
      body: {
        expected_turn_revision: 3,
        text: 'Inspect rollback before editing.',
      },
    })
    assert.equal(steered.status, 202)
    assert.deepEqual(steered.body, {
      accepted: true, run_id: RUN_ID, turn_revision: 3,
    })
    assert.equal(JSON.stringify(steered.body).includes('rollback'), false)
    assert.deepEqual(current.calls.at(-1), [
      'steer', RUN_ID,
      { expected_turn_revision: 3, text: 'Inspect rollback before editing.' },
    ])

    const stopped = await json(current.url, `/api/v1/runs/${RUN_ID}/stop`, {
      method: 'POST', body: { expected_turn_revision: 3 },
    })
    assert.equal(stopped.status, 202)
    assert.deepEqual(current.calls.at(-1), [
      'stop', RUN_ID, { expected_turn_revision: 3 },
    ])

    const rejected = await json(current.url, `/api/v1/runs/${RUN_ID}/steer`, {
      method: 'POST',
      body: { expected_turn_revision: 3, text: '   ', thread_id: 'private' },
    })
    assert.equal(rejected.status, 400)
    assert.equal(current.calls.filter(([kind]) => kind === 'steer').length, 1)
  } finally {
    await current.close()
  }
})

test('Scheduled Run compatibility detail preserves ephemeral Live Session capability', async () => {
  const current = await fixture()
  try {
    const detail = await json(current.url, `/api/v1/scheduled-runs/${RUN_ID}`)
    assert.equal(detail.status, 200)
    assert.equal(detail.body.run.interactive, true)
    assert.equal(detail.body.run.turn_revision, 2)
  } finally {
    await current.close()
  }
})
