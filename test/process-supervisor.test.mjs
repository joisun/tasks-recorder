import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { delimiter } from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'

import { createProcessSupervisor } from '../server/src/runtime/process-supervisor.mjs'

function fakeChild({ pid = 4242 } = {}) {
  const child = new EventEmitter()
  child.pid = pid
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

const INVOCATION = Object.freeze({
  command: '/opt/tasks/bin/codex',
  args: Object.freeze(['exec', '--json', '-']),
  cwd: '/tmp/project',
  stdin: 'private prompt',
  env: Object.freeze({ TASKS_RECORDER_RUN: '1' }),
  timeout_ms: 60_000,
})

function parseFakeEvent(line) {
  if (line === '{malformed') throw new Error('bad json')
  const event = JSON.parse(line)
  return [event]
}

test('supervisor normalizes a successful process without shell execution', async () => {
  const spawnCalls = []
  const emitted = []
  const spawned = []
  const stdout = []
  const stderr = []
  let logCloses = 0
  const child = fakeChild()
  const supervisor = createProcessSupervisor({
    spawnImpl(command, args, options) {
      spawnCalls.push({ command, args, options })
      queueMicrotask(() => {
        child.emit('spawn')
        child.stdout.write(`${JSON.stringify({
          type: 'session',
          payload: { session_id: 'session-1' },
        })}\n`)
        child.stdout.write(`${JSON.stringify({
          type: 'text_delta',
          payload: { text: 'Done.' },
        })}\n`)
        child.stderr.write('bounded warning\n')
        child.emit('close', 0, null)
      })
      return child
    },
  })

  const result = await supervisor.start({
    invocation: INVOCATION,
    parseEvent: parseFakeEvent,
    emit: (event) => emitted.push(event),
    onSpawn: (value) => spawned.push(value),
    signal: new AbortController().signal,
    logs: {
      writeStdout: async (chunk) => stdout.push(Buffer.from(chunk)),
      writeStderr: async (chunk) => stderr.push(Buffer.from(chunk)),
      close: async () => { logCloses += 1 },
    },
  })

  assert.equal(spawnCalls[0].options.shell, false)
  assert.deepEqual(spawnCalls[0].options.stdio, ['pipe', 'pipe', 'pipe'])
  assert.equal(spawnCalls[0].options.cwd, INVOCATION.cwd)
  assert.equal(spawnCalls[0].options.env.TASKS_RECORDER_RUN, '1')
  assert.deepEqual(spawned, [{ pid: 4242 }])
  assert.equal(emitted.length, 2)
  assert.equal(Buffer.concat(stdout).includes('session-1'), true)
  assert.equal(Buffer.concat(stderr).toString('utf8'), 'bounded warning\n')
  assert.equal(logCloses, 1)
  assert.deepEqual(result, {
    status: 'succeeded',
    exit_code: 0,
    error_code: null,
    duration_ms: result.duration_ms,
    session_id: 'session-1',
    final_message: 'Done.',
    usage: null,
    file_changes: [],
  })
})

test('supervisor repairs a stripped child PATH with user toolchain directories', async () => {
  const child = fakeChild()
  let spawnedEnvironment = null
  const supervisor = createProcessSupervisor({
    processEnvironment: {
      HOME: '/Users/tester',
      PATH: '/usr/bin:/bin',
    },
    spawnImpl(command, args, options) {
      spawnedEnvironment = options.env
      queueMicrotask(() => {
        child.emit('spawn')
        child.emit('close', 0, null)
      })
      return child
    },
  })

  await supervisor.start({
    invocation: INVOCATION,
    parseEvent: parseFakeEvent,
    emit: () => {},
    onSpawn: () => {},
    signal: new AbortController().signal,
  })

  assert.equal(spawnedEnvironment.TASKS_RECORDER_RUN, '1')
  assert.equal(
    spawnedEnvironment.PATH.split(delimiter).includes('/Users/tester/.local/bin'),
    true,
  )
})

test('supervisor delegates child environment construction to the runtime environment', async () => {
  const child = fakeChild()
  let invocationEnvironment = null
  let spawnedEnvironment = null
  const supervisor = createProcessSupervisor({
    runtimeEnvironment: {
      childEnvironment(overrides) {
        invocationEnvironment = overrides
        return { PATH: '/runtime/bin', ...overrides }
      },
    },
    spawnImpl(command, args, options) {
      spawnedEnvironment = options.env
      queueMicrotask(() => {
        child.emit('spawn')
        child.emit('close', 0, null)
      })
      return child
    },
  })

  await supervisor.start({
    invocation: INVOCATION,
    parseEvent: parseFakeEvent,
    emit: () => {},
    onSpawn: () => {},
    signal: new AbortController().signal,
  })

  assert.deepEqual(invocationEnvironment, INVOCATION.env)
  assert.equal(spawnedEnvironment.PATH, '/runtime/bin')
  assert.equal(spawnedEnvironment.TASKS_RECORDER_RUN, '1')
})

test('supervisor treats malformed runtime output as noise, not a false terminal state', async () => {
  const child = fakeChild()
  const supervisor = createProcessSupervisor({
    spawnImpl() {
      queueMicrotask(() => {
        child.emit('spawn')
        child.stdout.write('{malformed\n')
        child.emit('close', 0, null)
      })
      return child
    },
  })

  const result = await supervisor.start({
    invocation: INVOCATION,
    parseEvent: parseFakeEvent,
    emit: () => {},
    onSpawn: () => {},
    signal: new AbortController().signal,
  })
  assert.equal(result.status, 'succeeded')
  assert.equal(result.error_code, null)
})

test('supervisor returns a typed spawn failure', async () => {
  const supervisor = createProcessSupervisor({
    spawnImpl() {
      throw Object.assign(new Error('private executable path'), { code: 'ENOENT' })
    },
  })
  const result = await supervisor.start({
    invocation: INVOCATION,
    parseEvent: parseFakeEvent,
    emit: () => {},
    onSpawn: () => {},
    signal: new AbortController().signal,
  })
  assert.equal(result.status, 'failed')
  assert.equal(result.error_code, 'RUNTIME_SPAWN_FAILED')
  assert.equal(JSON.stringify(result).includes('private executable'), false)
})

test('supervisor times out with SIGINT followed by bounded SIGKILL', async () => {
  const timers = []
  const child = fakeChild()
  const supervisor = createProcessSupervisor({
    spawnImpl: () => child,
    setTimer(callback, delay) {
      const timer = { callback, delay, cleared: false, unref() {} }
      timers.push(timer)
      return timer
    },
    clearTimer(timer) {
      if (timer) timer.cleared = true
    },
    forceKillAfterMs: 2_000,
  })

  const resultPromise = supervisor.start({
    invocation: INVOCATION,
    parseEvent: parseFakeEvent,
    emit: () => {},
    onSpawn: () => {},
    signal: new AbortController().signal,
  })
  child.emit('spawn')
  timers.find(({ delay }) => delay === INVOCATION.timeout_ms).callback()
  assert.deepEqual(child.kills, ['SIGINT'])
  timers.find(({ delay }) => delay === 2_000).callback()

  const result = await resultPromise
  assert.equal(result.status, 'timed_out')
  assert.equal(result.error_code, 'RUNTIME_TIMEOUT')
  assert.deepEqual(child.kills, ['SIGINT', 'SIGKILL'])
})

test('supervisor cancellation remains canceled when the process exits during grace', async () => {
  const child = fakeChild()
  const controller = new AbortController()
  const supervisor = createProcessSupervisor({ spawnImpl: () => child })
  const resultPromise = supervisor.start({
    invocation: INVOCATION,
    parseEvent: parseFakeEvent,
    emit: () => {},
    onSpawn: () => {},
    signal: controller.signal,
  })
  child.emit('spawn')
  controller.abort()
  child.emit('close', null, 'SIGINT')

  const result = await resultPromise
  assert.equal(result.status, 'canceled')
  assert.equal(result.error_code, 'RUN_CANCELED')
  assert.deepEqual(child.kills, ['SIGINT'])
})
