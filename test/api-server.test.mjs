import assert from 'node:assert/strict'
import { request as httpRequest } from 'node:http'
import test from 'node:test'

import { createTaskService } from '../mcp/src/task-service.mjs'
import { createApiServer } from '../server/src/api-server.mjs'
import { createRevisionHub } from '../server/src/revision-hub.mjs'
import { taskInput, temporaryStore } from './helpers.mjs'

async function fixture(apiOverrides = {}) {
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
    ...apiOverrides,
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

test('settings and task resume routes expose only their typed local operations', async () => {
  const calls = []
  const current = await fixture({
    dashboardSettings: {
      get: async () => ({ settings: { resume_terminal: 'terminal' }, terminal_options: [] }),
      update: async (input) => {
        calls.push(['settings', input])
        return { settings: input, terminal_options: [] }
      },
    },
    sessionResume: {
      resumeTask: async (taskId) => {
        calls.push(['resume', taskId])
        return { ok: true, task_id: taskId, terminal: 'terminal' }
      },
    },
  })
  try {
    const settings = await fetch(`${current.url}/api/v1/settings`).then((response) => response.json())
    assert.equal(settings.settings.resume_terminal, 'terminal')
    const updated = await fetch(`${current.url}/api/v1/settings`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resume_terminal: 'otty' }),
    }).then((response) => response.json())
    assert.equal(updated.settings.resume_terminal, 'otty')
    const resumed = await fetch(`${current.url}/api/v1/tasks/task-a/resume`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    }).then((response) => response.json())
    assert.equal(resumed.task_id, 'task-a')
    assert.deepEqual(calls, [
      ['settings', { resume_terminal: 'otty' }],
      ['resume', 'task-a'],
    ])
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
    assert.equal(checked.schemaVersion, 2)
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

test('execution import previews without writes and publishes once after an atomic apply', async () => {
  const current = await fixture()
  const record = {
    external_key: 'codex:turn:import-session:turn-1:0',
    kind: 'main',
    root_session_id: 'import-session',
    session_id: 'import-session',
    turn_id: 'turn-1',
    agent_id: null,
    agent_type: 'Codex',
    agent_path: null,
    parent_external_key: null,
    transcript_path: '/sessions/import-session.jsonl',
    task_id: null,
    classification: 'unknown',
    workfolder: '/workspace/import',
    git_root: null,
    worktree: '/workspace/import',
    branch: 'main',
    status: 'completed',
    started_at: '2026-08-14T01:00:00.000Z',
    last_seen_at: '2026-08-14T01:10:00.000Z',
    ended_at: '2026-08-14T01:10:00.000Z',
  }
  const records = Array.from({ length: 278 }, (_, index) => ({
    ...record,
    external_key: `codex:turn:import-session:turn-${index}:0`,
    turn_id: `turn-${index}`,
  }))
  try {
    const previewResponse = await fetch(`${current.url}/api/v1/import/executions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source: 'codex', dry_run: true, session_id: 'import-session',
        root_turns: 278, subagent_executions: 0, records, warnings: [],
      }),
    })
    const preview = await previewResponse.json()
    assert.equal(previewResponse.status, 200)
    assert.equal(preview.would_create, 278)
    assert.equal(preview.persisted, false)
    assert.equal(current.store.listExecutions().length, 0)
    assert.equal(current.hub.current().revision, 0)

    const applyResponse = await fetch(`${current.url}/api/v1/import/executions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source: 'codex', dry_run: false, session_id: 'import-session',
        root_turns: 278, subagent_executions: 0, records, warnings: [],
      }),
    })
    const applied = await applyResponse.json()
    assert.equal(applyResponse.status, 200)
    assert.equal(applied.created, 278)
    assert.equal(applied.persisted, true)
    assert.equal(applied.change.revision, 1)
    assert.equal(current.store.listExecutions().length, 278)

    const replay = await fetch(`${current.url}/api/v1/import/executions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source: 'codex', dry_run: false, session_id: 'import-session',
        root_turns: 278, subagent_executions: 0, records, warnings: [],
      }),
    }).then((response) => response.json())
    assert.equal(replay.skipped, 278)
    assert.equal(replay.persisted, false)
    assert.equal(current.hub.current().revision, 1)
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
    await fetch(`${current.url}/api/v1/tasks/parent`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(taskInput({ id: 'parent', title: 'Parent' })),
    })
    await fetch(`${current.url}/api/v1/tasks/child`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(taskInput({ id: 'child', parent_id: 'parent', title: 'Child' })),
    })
    const parent = await fetch(`${current.url}/api/v1/tasks/parent`)
      .then((response) => response.json())
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

test('lifecycle, tree sync, session context, and execution routes share one revisioned API', async () => {
  const current = await fixture()
  const jsonHeaders = { 'Content-Type': 'application/json', Origin: current.url }
  try {
    const turnResponse = await fetch(`${current.url}/api/v1/lifecycle/turn-start`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({
        external_key: 'codex:turn:session-1:turn-1:0',
        root_session_id: 'session-1',
        session_id: 'session-1',
        turn_id: 'turn-1',
        workfolder: '/workspace',
      }),
    })
    assert.equal(turnResponse.status, 200)
    const turn = await turnResponse.json()
    assert.equal(turn.execution.classification, 'unknown')
    assert.equal(turn.change.revision, 1)

    const syncResponse = await fetch(`${current.url}/api/v1/tasks/sync-tree`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({
        session_id: 'session-1',
        turn_id: 'turn-1',
        workfolder: '/workspace',
        expected_revision: null,
        root: { id: 'root', title: 'Root', status: 'active' },
        children: [],
        focus_task_id: 'root',
      }),
    })
    assert.equal(syncResponse.status, 200)
    const synced = await syncResponse.json()
    assert.equal(synced.bound_execution.task_id, 'root')
    assert.equal(synced.change.revision, 2)

    const session = await fetch(`${current.url}/api/v1/sessions/session-1/context`)
      .then((response) => response.json())
    assert.equal(session.active_execution_count, 1)
    assert.equal(session.unassigned_execution_count, 0)
    const executions = await fetch(
      `${current.url}/api/v1/executions?root_session_id=session-1`,
    ).then((response) => response.json())
    assert.equal(executions.executions[0].task_id, 'root')

    const endResponse = await fetch(`${current.url}/api/v1/lifecycle/session-end`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ root_session_id: 'session-1' }),
    })
    assert.equal(endResponse.status, 200)
    const ended = await endResponse.json()
    assert.equal(ended.executions[0].status, 'completed')
    assert.equal(ended.change.revision, 3)
  } finally {
    await current.cleanup()
  }
})

test('execution batch assignment is atomic and publishes one revision', async () => {
  const current = await fixture()
  const headers = { 'Content-Type': 'application/json' }
  try {
    const first = await fetch(`${current.url}/api/v1/lifecycle/turn-start`, {
      method: 'POST', headers,
      body: JSON.stringify({
        external_key: 'codex:turn:batch-session:turn-1:0',
        root_session_id: 'batch-session', session_id: 'batch-session', turn_id: 'turn-1',
        workfolder: '/workspace',
      }),
    }).then((response) => response.json())
    const second = await fetch(`${current.url}/api/v1/lifecycle/subagent-start`, {
      method: 'POST', headers,
      body: JSON.stringify({
        external_key: 'codex:subagent:batch-child', root_session_id: 'batch-session',
        session_id: 'batch-child', parent_session_id: 'batch-session', turn_id: 'turn-1',
        agent_id: 'batch-child', agent_path: '/root/worker', workfolder: '/workspace',
      }),
    }).then((response) => response.json())
    for (const id of ['task-a', 'task-b']) {
      await fetch(`${current.url}/api/v1/tasks/${id}`, {
        method: 'PUT', headers,
        body: JSON.stringify(taskInput({ id, title: id })),
      })
    }
    const revisionBeforeBatch = current.hub.current().revision

    const assignedResponse = await fetch(`${current.url}/api/v1/executions/tasks`, {
      method: 'PATCH', headers,
      body: JSON.stringify({
        actor: 'user',
        changes: [first.execution, second.execution].map((execution) => ({
          id: execution.id,
          expected_task_id: null,
          expected_classification: 'unknown',
          task_id: 'task-a',
          classification: 'work',
        })),
      }),
    })
    assert.equal(assignedResponse.status, 200)
    const assigned = await assignedResponse.json()
    assert.equal(assigned.executions.length, 2)
    assert.equal(assigned.change.revision, revisionBeforeBatch + 1)
    assert.deepEqual(assigned.executions.map(({ task_id }) => task_id), ['task-a', 'task-a'])

    const conflictResponse = await fetch(`${current.url}/api/v1/executions/tasks`, {
      method: 'PATCH', headers,
      body: JSON.stringify({
        actor: 'user',
        changes: [
          {
            id: first.execution.id, expected_task_id: null, expected_classification: 'unknown',
            task_id: 'task-b', classification: 'work',
          },
          {
            id: second.execution.id, expected_task_id: 'task-a', expected_classification: 'work',
            task_id: 'task-b', classification: 'work',
          },
        ],
      }),
    })
    assert.equal(conflictResponse.status, 409)
    const conflict = await conflictResponse.json()
    assert.equal(conflict.error.code, 'EXECUTION_BATCH_CONFLICT')
    assert.equal(conflict.error.details.conflicts[0].id, first.execution.id)
    const afterConflict = await fetch(
      `${current.url}/api/v1/executions?root_session_id=batch-session`,
    ).then((response) => response.json())
    assert.deepEqual(afterConflict.executions.map(({ task_id }) => task_id), ['task-a', 'task-a'])
  } finally {
    await current.cleanup()
  }
})
