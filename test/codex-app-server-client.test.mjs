import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import test from 'node:test'

import { createCodexAppServerClient } from '../server/src/runtime/codex-app-server-client.mjs'

function fakeChildProcess() {
  const child = new EventEmitter()
  child.pid = 43127
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.kills = []
  child.kill = (signal) => {
    child.kills.push(signal)
    return true
  }
  return child
}

function readWrittenLine(stream) {
  return new Promise((resolve) => {
    stream.once('data', (chunk) => resolve(chunk.toString('utf8').trim()))
  })
}

test('app-server client correlates a JSON-RPC response without shell execution', async (t) => {
  const child = fakeChildProcess()
  const spawns = []
  const client = createCodexAppServerClient({
    executable: '/opt/tasks/bin/codex',
    cwd: '/tmp/project',
    spawnImpl(command, args, options) {
      spawns.push({ command, args, options })
      return child
    },
    runtimeEnvironment: {
      childEnvironment: (env) => ({ PATH: '/opt/tasks/bin', ...env }),
    },
  })
  t.after(() => client.close())

  const written = readWrittenLine(child.stdin)
  const pending = client.request('initialize', {
    clientInfo: { name: 'tasks-recorder', version: 'source' },
  })

  assert.deepEqual(spawns, [{
    command: '/opt/tasks/bin/codex',
    args: ['app-server', '--listen', 'stdio://'],
    options: {
      cwd: '/tmp/project',
      env: { PATH: '/opt/tasks/bin' },
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    },
  }])
  assert.deepEqual(JSON.parse(await written), {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { clientInfo: { name: 'tasks-recorder', version: 'source' } },
  })

  child.stdout.write(`${JSON.stringify({
    jsonrpc: '2.0', id: 1, result: { userAgent: 'codex-cli 0.150.0' },
  })}\n`)

  assert.deepEqual(await pending, { userAgent: 'codex-cli 0.150.0' })
})

test('app-server client applies only bounded trusted capability launch options', () => {
  const child = fakeChildProcess()
  const spawns = []
  const client = createCodexAppServerClient({
    executable: '/opt/tasks/bin/codex',
    cwd: '/tmp/project',
    disabledFeatures: ['plugins'],
    configOverrides: [
      'apps._default.enabled=false',
      'mcp_servers.project-tools.enabled=false',
    ],
    spawnImpl(command, args, options) {
      spawns.push({ command, args, options })
      return child
    },
    runtimeEnvironment: { childEnvironment: () => ({}) },
  })
  client.close()

  assert.deepEqual(spawns[0].args, [
    'app-server',
    '--disable', 'plugins',
    '-c', 'apps._default.enabled=false',
    '-c', 'mcp_servers.project-tools.enabled=false',
    '--listen', 'stdio://',
  ])
  assert.throws(() => createCodexAppServerClient({
    executable: '/opt/tasks/bin/codex', cwd: '/tmp/project',
    disabledFeatures: ['plugins', '--listen'],
    spawnImpl: () => child,
    runtimeEnvironment: { childEnvironment: () => ({}) },
  }), /options are invalid/)
})

test('app-server client preserves split notification frames and writes notifications', async (t) => {
  const child = fakeChildProcess()
  const client = createCodexAppServerClient({
    executable: '/opt/tasks/bin/codex',
    cwd: '/tmp/project',
    spawnImpl: () => child,
    runtimeEnvironment: { childEnvironment: () => ({}) },
  })
  t.after(() => client.close())
  const notifications = []
  client.onNotification((notification) => notifications.push(notification))

  const written = readWrittenLine(child.stdin)
  client.notify('initialized', {})
  assert.deepEqual(JSON.parse(await written), {
    jsonrpc: '2.0', method: 'initialized', params: {},
  })

  const line = `${JSON.stringify({
    jsonrpc: '2.0', method: 'item/agentMessage/delta',
    params: { itemId: 'message-1', delta: '检查中' },
  })}\n`
  const bytes = Buffer.from(line)
  child.stdout.write(bytes.subarray(0, bytes.length - 2))
  assert.deepEqual(notifications, [])
  child.stdout.write(bytes.subarray(bytes.length - 2))

  assert.deepEqual(notifications, [{
    method: 'item/agentMessage/delta',
    params: { itemId: 'message-1', delta: '检查中' },
  }])
})

test('app-server client bounds requests and rejects every pending call after process close', async () => {
  const child = fakeChildProcess()
  const timers = []
  const client = createCodexAppServerClient({
    executable: '/opt/tasks/bin/codex',
    cwd: '/tmp/project',
    spawnImpl: () => child,
    runtimeEnvironment: { childEnvironment: () => ({}) },
    requestTimeoutMs: 10_000,
    setTimer(callback) {
      timers.push(callback)
      return timers.length
    },
    clearTimer() {},
  })

  const timedOut = client.request('initialize', { clientInfo: { name: 'x', version: '1' } })
  timers[0]()
  await assert.rejects(timedOut, { code: 'RUNTIME_PROTOCOL_TIMEOUT' })

  const closed = client.request('thread/start', {})
  child.emit('close', 1, null)
  await assert.rejects(closed, { code: 'RUNTIME_PROTOCOL_CLOSED' })
  assert.equal(client.closed, true)
})

test('app-server client exposes one authoritative spawned PID', async (t) => {
  const child = fakeChildProcess()
  const client = createCodexAppServerClient({
    executable: '/opt/tasks/bin/codex',
    cwd: '/tmp/project',
    spawnImpl: () => child,
    runtimeEnvironment: { childEnvironment: () => ({}) },
  })
  t.after(() => client.close())

  child.emit('spawn')
  assert.deepEqual(await client.started, { pid: 43127 })
})

test('app-server client rejects an unbounded protocol frame', async () => {
  const child = fakeChildProcess()
  const client = createCodexAppServerClient({
    executable: '/opt/tasks/bin/codex',
    cwd: '/tmp/project',
    spawnImpl: () => child,
    runtimeEnvironment: { childEnvironment: () => ({}) },
    maximumLineBytes: 32,
  })

  const pending = client.request('initialize', {})
  child.stdout.write('x'.repeat(33))

  await assert.rejects(pending, { code: 'RUNTIME_PROTOCOL_FRAME_TOO_LARGE' })
  assert.equal(client.closed, true)
  assert.deepEqual(child.kills, ['SIGINT'])
})

test('app-server client escalates shutdown when SIGINT is ignored', () => {
  const child = fakeChildProcess()
  const timers = []
  const client = createCodexAppServerClient({
    executable: '/opt/tasks/bin/codex',
    cwd: '/tmp/project',
    spawnImpl: () => child,
    runtimeEnvironment: { childEnvironment: () => ({}) },
    setTimer(callback, delay) {
      timers.push({ callback, delay })
      return timers.length
    },
    clearTimer() {},
  })

  client.close()
  assert.deepEqual(child.kills, ['SIGINT'])
  assert.equal(timers[0].delay, 2_000)
  timers[0].callback()
  assert.deepEqual(child.kills, ['SIGINT', 'SIGKILL'])
})

test('app-server client maps Codex activeTurnNotSteerable without exposing RPC data', async (t) => {
  const child = fakeChildProcess()
  const client = createCodexAppServerClient({
    executable: '/opt/tasks/bin/codex',
    cwd: '/tmp/project',
    spawnImpl: () => child,
    runtimeEnvironment: { childEnvironment: () => ({}) },
  })
  t.after(() => client.close())

  const pending = client.request('turn/steer', {})
  child.stdout.write(`${JSON.stringify({
    jsonrpc: '2.0', id: 1,
    error: {
      code: -32600,
      message: 'turn cannot be steered',
      data: { codexError: { code: 'activeTurnNotSteerable', secret: 'not-public' } },
    },
  })}\n`)

  await assert.rejects(pending, (error) => {
    assert.equal(error.code, 'TURN_NOT_STEERABLE')
    assert.doesNotMatch(error.message, /secret|not-public/)
    return true
  })
})
