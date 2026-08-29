import assert from 'node:assert/strict'
import test from 'node:test'

import { createCodexInteractiveSessionFactory } from '../server/src/runtime/adapters/codex-interactive-session.mjs'

function fakeClient() {
  const notifications = new Set()
  const requests = []
  const client = {
    pid: 7401,
    started: Promise.resolve({ pid: 7401 }),
    requests,
    closed: false,
    async request(method, params) {
      requests.push({ method, params })
      if (method === 'initialize') return { userAgent: 'codex-cli 0.150.0' }
      if (method === 'thread/start') {
        return {
          thread: { id: 'private-thread', turns: [] },
          model: 'gpt-5', cwd: '/tmp/project', approvalPolicy: 'never',
          approvalsReviewer: 'user', sandbox: { type: 'readOnly' }, modelProvider: 'openai',
        }
      }
      if (method === 'turn/start') {
        return { turn: { id: 'private-turn', status: 'inProgress', items: [] } }
      }
      if (method === 'turn/steer' || method === 'turn/interrupt') return {}
      throw new Error(`unexpected method ${method}`)
    },
    notify() {},
    onNotification(listener) {
      notifications.add(listener)
      return () => notifications.delete(listener)
    },
    emit(method, params) {
      for (const listener of notifications) listener({ method, params })
    },
    close() { client.closed = true },
  }
  return client
}

const RUN = Object.freeze({
  id: 'run-1',
  title: 'Review migration',
  prompt: 'Review the migration.',
  workspace: '/tmp/project',
  sandbox_mode: 'read-only',
  model: 'gpt-5',
  reasoning_effort: 'high',
  timeout_seconds: 7_200,
})

test('Codex interactive session streams a private Turn and steers it through a public revision', async () => {
  const client = fakeClient()
  const events = []
  const spawns = []
  const factory = createCodexInteractiveSessionFactory({ createClient: () => client })
  const session = factory.create({
    launch: { executable: '/opt/tasks/bin/codex', version: 'codex-cli 0.150.0' },
    run: RUN,
    signal: new AbortController().signal,
    emit: (event) => events.push(event),
    onSpawn: (spawned) => spawns.push(spawned),
  })

  const completion = session.start()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()

  assert.deepEqual(spawns, [{ pid: 7401 }])
  assert.deepEqual(events.slice(0, 2), [
    { type: 'session', payload: { session_id: 'private-thread' } },
    { type: 'user_message', payload: { kind: 'prompt', text: 'Review the migration.' } },
  ])
  assert.deepEqual(client.requests.slice(0, 3), [
    {
      method: 'initialize',
      params: { clientInfo: { name: 'tasks-recorder', title: 'Tasks Recorder', version: 'source' } },
    },
    {
      method: 'thread/start',
      params: {
        cwd: '/tmp/project', model: 'gpt-5', approvalPolicy: 'never',
        sandbox: 'read-only', ephemeral: false,
      },
    },
    {
      method: 'turn/start',
      params: {
        threadId: 'private-thread',
        input: [{ type: 'text', text: 'Review the migration.' }],
        cwd: '/tmp/project', model: 'gpt-5', effort: 'high',
      },
    },
  ])

  client.emit('turn/started', {
    threadId: 'private-thread',
    turn: { id: 'private-turn', status: 'inProgress', items: [] },
  })
  client.emit('item/agentMessage/delta', {
    threadId: 'private-thread', turnId: 'private-turn',
    itemId: 'message-1', delta: 'Checking the schema.',
  })
  client.emit('item/completed', {
    threadId: 'private-thread', turnId: 'private-turn', completedAtMs: 1,
    item: {
      id: 'file-1', type: 'fileChange', status: 'completed',
      changes: [
        { path: '/tmp/project/report.md', kind: 'update' },
        { path: '/tmp/outside.md', kind: 'delete' },
      ],
    },
  })

  assert.deepEqual(events.filter(({ type }) => ['turn_started', 'assistant_delta'].includes(type)).slice(-2), [
    { type: 'turn_started', payload: { turn_revision: 1 } },
    {
      type: 'assistant_delta',
      payload: { turn_revision: 1, item_id: 'message-1', delta: 'Checking the schema.' },
    },
  ])
  assert.doesNotMatch(JSON.stringify(events), /private-turn/)

  await session.steer({ expectedTurnRevision: 1, text: 'Check rollback too.' })
  assert.deepEqual(client.requests.at(-1), {
    method: 'turn/steer',
    params: {
      threadId: 'private-thread', expectedTurnId: 'private-turn',
      input: [{ type: 'text', text: 'Check rollback too.' }],
    },
  })
  assert.deepEqual(events.at(-1), {
    type: 'intervention_accepted',
    payload: { turn_revision: 1, text: 'Check rollback too.' },
  })

  client.emit('turn/completed', {
    threadId: 'private-thread',
    turn: { id: 'private-turn', status: 'completed', items: [] },
  })
  assert.deepEqual(await completion, {
    status: 'succeeded', exit_code: 0, error_code: null,
    session_id: 'private-thread', final_message: 'Checking the schema.',
    usage: null, file_changes: [{ path: 'report.md', kind: 'update' }],
  })
  assert.equal(client.closed, true)
})

test('Codex interactive session closes promptly when taskd aborts the Run', async () => {
  const client = fakeClient()
  const controller = new AbortController()
  const factory = createCodexInteractiveSessionFactory({ createClient: () => client })
  const session = factory.create({
    launch: { executable: '/opt/tasks/bin/codex', version: 'codex-cli 0.150.0' },
    run: RUN,
    signal: controller.signal,
    emit: () => {},
    onSpawn: () => {},
  })

  const completion = session.start()
  await Promise.resolve()
  controller.abort()

  assert.deepEqual(await completion, {
    status: 'canceled', exit_code: null, error_code: 'RUN_CANCELED',
    session_id: null, final_message: null, usage: null, file_changes: [],
  })
  assert.equal(client.closed, true)
})

test('Codex interactive session enforces the durable Run timeout', async () => {
  const client = fakeClient()
  let expire
  const factory = createCodexInteractiveSessionFactory({
    createClient: () => client,
    setTimer(callback, delay) {
      assert.equal(delay, 7_200_000)
      expire = callback
      return 19
    },
    clearTimer() {},
  })
  const session = factory.create({
    launch: { executable: '/opt/tasks/bin/codex', version: 'codex-cli 0.150.0' },
    run: RUN,
    signal: new AbortController().signal,
    emit: () => {},
    onSpawn: () => {},
  })

  const completion = session.start()
  await Promise.resolve()
  expire()

  assert.deepEqual(await completion, {
    status: 'timed_out', exit_code: null, error_code: 'RUNTIME_TIMEOUT',
    session_id: null, final_message: null, usage: null, file_changes: [],
  })
  assert.equal(client.closed, true)
})
