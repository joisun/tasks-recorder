import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createRunEventHub } from '../server/src/runs/run-event-hub.mjs'
import { createRunService } from '../server/src/runs/run-service.mjs'
import { createRunStore } from '../server/src/runs/run-store.mjs'

const SCHEDULE = Object.freeze({
  id: '11111111-1111-4111-8111-111111111111',
  etag: 'a'.repeat(64),
  title: 'Daily review',
  prompt: 'Review the project.',
  workspace: '/tmp/project',
  cadence: Object.freeze({
    kind: 'daily',
    hour: 9,
    minute: 30,
    timezone_mode: 'system',
  }),
  enabled: true,
  agent: 'codex',
  sandbox_mode: 'read-only',
  model: null,
  reasoning_effort: null,
  timeout_seconds: 7_200,
})

const RESOLVED_CODEX = Object.freeze({
  runtime_id: 'codex',
  executable: '/opt/tasks/bin/codex',
  version: 'codex-cli 0.150.0',
  source: 'path',
})

function deferred() {
  let resolve
  let reject
  const promise = new Promise((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

async function fixture(t, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'tasks-recorder-run-service-'))
  let nextId = 0
  const runStore = createRunStore({
    databasePath: join(root, 'runs.sqlite'),
    clock: () => new Date('2026-08-27T09:00:00.000Z'),
    createId: () => `00000000-0000-4000-8000-${String(++nextId).padStart(12, '0')}`,
  })
  const eventHub = createRunEventHub()
  const definition = {
    id: 'codex',
    buildInvocation: async ({ run }) => ({
      command: '/opt/tasks/bin/codex',
      args: ['exec', '--json', '-'],
      cwd: run.workspace,
      stdin: run.prompt,
      timeout_ms: 60_000,
    }),
    parseEvent: () => [],
  }
  const dependencies = {
    runStore,
    eventHub,
    registry: {
      resolve: async () => RESOLVED_CODEX,
      get: () => definition,
    },
    supervisor: {
      start: async ({ onSpawn }) => {
        onSpawn({ pid: 123 })
        return {
          status: 'succeeded',
          exit_code: 0,
          error_code: null,
          duration_ms: 5,
          session_id: 'session-1',
          final_message: 'Done.',
          usage: null,
          file_changes: [{ path: 'README.md', kind: 'update' }],
        }
      },
    },
    logStore: {
      open: async ({ scheduleId, runId }) => ({
        stdout_log_path: `${scheduleId}/${runId}.stdout.jsonl`,
        stderr_log_path: `${scheduleId}/${runId}.stderr.log`,
        writeStdout: async () => {},
        writeStderr: async () => {},
        close: async () => {},
      }),
    },
    clock: () => new Date('2026-08-27T09:00:00.000Z'),
    ...overrides,
  }
  const service = createRunService(dependencies)
  t.after(async () => {
    await service.shutdown()
    eventHub.close()
    runStore.close()
    await rm(root, { recursive: true, force: true })
  })
  return { service, runStore, dependencies, root }
}

test('RunService returns a queued Run before runtime resolution settles', async (t) => {
  const resolution = deferred()
  const current = await fixture(t, {
    registry: {
      resolve: () => resolution.promise,
      get: () => ({
        id: 'codex',
        buildInvocation: async ({ run }) => ({
          command: RESOLVED_CODEX.executable,
          args: ['exec', '--json', '-'],
          cwd: run.workspace,
          stdin: run.prompt,
          timeout_ms: 60_000,
        }),
        parseEvent: () => [],
      }),
    },
  })

  const result = await current.service.create({
    schedule: SCHEDULE,
    origin: 'manual',
    occurrence_key: null,
    scheduled_for: null,
    idempotency_key: '33333333-3333-4333-8333-333333333333',
  })
  assert.equal(result.run.status, 'queued')
  assert.equal(current.runStore.get(result.run.id).status, 'queued')

  resolution.resolve(RESOLVED_CODEX)
  await current.service.whenIdle()
  const completed = current.runStore.get(result.run.id)
  assert.equal(completed.status, 'succeeded')
  assert.equal(completed.session_id, 'session-1')
  assert.deepEqual(completed.file_changes, [
    { path: 'README.md', kind: 'update' },
  ])
})

test('RunService records workspace file changes when the runtime omits fileChange events', async (t) => {
  const completion = deferred()
  const current = await fixture(t, {
    registry: {
      resolve: async () => RESOLVED_CODEX,
      get: () => ({
        id: 'codex',
        createInteractiveSession({ onSpawn }) {
          return {
            async start() {
              onSpawn({ pid: 7401 })
              return completion.promise
            },
            close() {},
          }
        },
      }),
    },
  })
  const workspace = join(current.root, 'workspace')
  await mkdir(workspace)
  await writeFile(join(workspace, 'updated.md'), 'before')
  await writeFile(join(workspace, 'deleted.md'), 'remove me')

  const { run } = await current.service.create({
    schedule: { ...SCHEDULE, workspace },
    origin: 'manual',
    occurrence_key: null,
    scheduled_for: null,
    idempotency_key: 'workspace-file-changes',
  })
  while (current.runStore.get(run.id).status !== 'running') {
    await new Promise((resolve) => setImmediate(resolve))
  }
  await writeFile(join(workspace, 'created.md'), 'new report')
  await writeFile(join(workspace, 'updated.md'), 'updated report is longer')
  await rm(join(workspace, 'deleted.md'))
  completion.resolve({
    status: 'succeeded', exit_code: 0, error_code: null,
    session_id: 'session-1', final_message: 'Done.', usage: null, file_changes: [],
  })
  await current.service.whenIdle()

  assert.deepEqual(current.runStore.get(run.id).file_changes, [
    { path: 'created.md', kind: 'add' },
    { path: 'deleted.md', kind: 'delete' },
    { path: 'updated.md', kind: 'update' },
  ])
})

test('runtime discovery failure terminates the durable queued Run', async (t) => {
  const current = await fixture(t, {
    registry: {
      resolve: async () => {
        throw Object.assign(new Error('missing'), { code: 'RUNTIME_UNAVAILABLE' })
      },
      get: () => {
        throw new Error('unreachable')
      },
    },
  })
  const { run } = await current.service.create({
    schedule: SCHEDULE,
    origin: 'manual',
    occurrence_key: null,
    scheduled_for: null,
    idempotency_key: 'runtime-missing',
  })

  await current.service.whenIdle()
  const failed = current.runStore.get(run.id)
  assert.equal(failed.status, 'failed')
  assert.equal(failed.error_code, 'RUNTIME_UNAVAILABLE')
})

test('canceling during runtime resolution prevents process launch', async (t) => {
  const resolution = deferred()
  let launches = 0
  const current = await fixture(t, {
    registry: {
      resolve: () => resolution.promise,
      get: () => current.dependencies.registry.get('codex'),
    },
    supervisor: {
      start: async () => {
        launches += 1
        throw new Error('must not launch')
      },
    },
  })
  const { run } = await current.service.create({
    schedule: SCHEDULE,
    origin: 'manual',
    occurrence_key: null,
    scheduled_for: null,
    idempotency_key: 'cancel-before-launch',
  })
  assert.equal(current.service.cancel(run.id).status, 'canceled')
  resolution.resolve(RESOLVED_CODEX)
  await current.service.whenIdle()

  assert.equal(current.runStore.get(run.id).status, 'canceled')
  assert.equal(launches, 0)
})

test('shutdown does not wait for a runtime resolution that never settles', async (t) => {
  const resolution = deferred()
  const current = await fixture(t, {
    registry: {
      resolve: () => resolution.promise,
      get: () => current.dependencies.registry.get('codex'),
    },
  })
  const { run } = await current.service.create({
    schedule: SCHEDULE,
    origin: 'manual',
    occurrence_key: null,
    scheduled_for: null,
    idempotency_key: 'shutdown-during-resolution',
  })

  await current.service.shutdown()

  const canceled = current.runStore.get(run.id)
  assert.equal(canceled.status, 'canceled')
  assert.equal(canceled.error_code, 'RUN_CANCELED')
})

test('recover marks abandoned queued and running rows interrupted', async (t) => {
  const current = await fixture(t)
  const queued = current.runStore.create({
    schedule: SCHEDULE,
    runtime_id: 'codex',
    origin: 'manual',
    occurrence_key: null,
    scheduled_for: null,
    idempotency_key: 'recovery',
  })

  assert.equal(current.service.recover(), 1)
  assert.equal(current.runStore.get(queued.id).status, 'interrupted')
  assert.equal(current.service.recover(), 0)
})

test('spawn failures use the unified Run error code', async (t) => {
  const current = await fixture(t, {
    supervisor: {
      start: async () => ({
        status: 'failed',
        exit_code: null,
        error_code: 'RUNTIME_SPAWN_FAILED',
        duration_ms: 0,
        session_id: null,
        final_message: null,
        usage: null,
        file_changes: [],
      }),
    },
  })
  const { run } = await current.service.create({
    schedule: SCHEDULE,
    origin: 'manual',
    occurrence_key: null,
    scheduled_for: null,
    idempotency_key: 'spawn-failure',
  })
  await current.service.whenIdle()

  const failed = current.runStore.get(run.id)
  assert.equal(failed.status, 'failed')
  assert.equal(failed.error_code, 'RUN_SPAWN_FAILED')
})

test('RunService steers the current interactive Turn without persisting guidance', async (t) => {
  const sessionReady = deferred()
  const completion = deferred()
  t.after(() => completion.resolve({
    status: 'canceled', exit_code: null, error_code: 'RUN_CANCELED',
    session_id: null, final_message: null, usage: null, file_changes: [],
  }))
  const steers = []
  let sessionOptions = null
  const definition = {
    id: 'codex',
    createInteractiveSession(options) {
      sessionOptions = options
      sessionReady.resolve()
      return {
        async start() {
          options.onSpawn({ pid: 7401 })
          return completion.promise
        },
        async steer(input) {
          steers.push(input)
          return { accepted: true, turnRevision: input.expectedTurnRevision }
        },
        async interrupt() {},
        close() {},
      }
    },
  }
  const current = await fixture(t, {
    registry: {
      resolve: async () => RESOLVED_CODEX,
      get: () => definition,
    },
  })
  const { run } = await current.service.create({
    schedule: SCHEDULE,
    origin: 'manual',
    occurrence_key: null,
    scheduled_for: null,
    idempotency_key: 'interactive-run',
  })
  const interactiveStarted = await Promise.race([
    sessionReady.promise.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 1_000)),
  ])
  assert.equal(interactiveStarted, true)
  sessionOptions.emit({ type: 'turn_started', payload: { turn_revision: 1 } })

  const activeRun = current.service.get(run.id)
  assert.equal(activeRun.status, 'running')
  assert.equal(activeRun.interactive, true)
  assert.equal(activeRun.turn_revision, 1)
  assert.equal(Object.hasOwn(activeRun, 'snapshot'), false)
  assert.deepEqual(await current.service.steer(run.id, {
    expected_turn_revision: 1,
    text: 'Verify rollback before editing.',
  }), {
    accepted: true,
    run_id: run.id,
    turn_revision: 1,
  })
  assert.deepEqual(steers, [{
    expectedTurnRevision: 1,
    text: 'Verify rollback before editing.',
  }])
  assert.doesNotMatch(JSON.stringify(current.runStore.get(run.id)), /Verify rollback/)

  completion.resolve({
    status: 'succeeded', exit_code: 0, error_code: null,
    session_id: 'session-1', final_message: 'Done.', usage: null, file_changes: [],
  })
  await current.service.whenIdle()
  assert.equal(current.service.get(run.id).interactive, false)
})
