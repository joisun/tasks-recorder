import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createSessionResumeService,
  resolveTaskResumeTarget,
} from '../server/src/session-resume-service.mjs'

const snapshot = {
  tasks: [
    { id: 'main', parent_id: null, title: 'Main delivery', deleted_at: null },
    { id: 'child', parent_id: 'main', title: 'Focused child', deleted_at: null },
  ],
  source_sessions: [
    { id: 'source-old', source: 'codex', external_session_id: 'session-old' },
    { id: 'source-new', source: 'codex', external_session_id: 'session-new' },
  ],
  executions: [
    { id: 'execution-old', source_session_id: 'source-old', workfolder: '/workspace/old', last_seen_at: '2026-08-20T08:00:00.000Z' },
    { id: 'execution-new', source_session_id: 'source-new', workfolder: '/workspace/new', last_seen_at: '2026-08-21T08:00:00.000Z' },
  ],
  segments: [
    { id: 'segment-old', execution_id: 'execution-old', task_id: 'main', attribution_id: 'attribution-old' },
    { id: 'segment-new', execution_id: 'execution-new', task_id: 'child', attribution_id: 'attribution-new' },
  ],
}

const SCHEDULED_RUN_ID = '22222222-2222-4222-8222-222222222222'
const SCHEDULED_JOB_ID = '11111111-1111-4111-8111-111111111111'

function scheduledRun(overrides = {}) {
  return {
    id: SCHEDULED_RUN_ID,
    job_id: SCHEDULED_JOB_ID,
    status: 'succeeded',
    thread_id: 'thread-scheduled',
    spec_json: JSON.stringify({
      title: 'Canonical scheduled title',
      workspace: '/canonical/scheduled-workspace',
      prompt: 'private scheduled prompt',
    }),
    ...overrides,
  }
}

test('main task resume target follows the newest recorded session across its child scope', () => {
  assert.deepEqual(resolveTaskResumeTarget(snapshot, 'main'), {
    task_id: 'main', session_id: 'session-new', session_source: 'codex',
    task_title: 'Main delivery', workspace: '/workspace/new',
  })
  assert.deepEqual(resolveTaskResumeTarget(snapshot, 'child'), {
    task_id: 'child', session_id: 'session-new', session_source: 'codex',
    task_title: 'Focused child', workspace: '/workspace/new',
  })
})

test('resume service resolves trusted server facts and applies the persisted terminal choice', async () => {
  const launches = []
  const service = createSessionResumeService({
    store: { snapshot: () => snapshot },
    settings: { get: async () => ({ settings: { resume_terminal: 'otty' } }) },
    sessionInventory: { has: async (sessionId) => sessionId === 'session-new' },
    terminalLauncher: {
      launch: async (input) => {
        launches.push(input)
        return { terminal: 'otty', terminal_label: 'Otty' }
      },
    },
  })

  const result = await service.resumeTask('main')
  assert.deepEqual(launches, [{
    terminal: 'otty', sessionId: 'session-new', workspace: '/workspace/new', title: 'Main delivery',
  }])
  assert.equal(result.ok, true)
  assert.equal(result.terminal_label, 'Otty')
  assert.equal(result.session_id, 'session-new')
})

test('resume target rejects tasks without attribution and explicit non-Codex sessions', () => {
  assert.throws(
    () => resolveTaskResumeTarget({ ...snapshot, segments: [] }, 'main'),
    (error) => error.code === 'TASK_NOT_RESUMABLE',
  )
  assert.throws(
    () => resolveTaskResumeTarget({
      ...snapshot,
      source_sessions: [{ id: 'source-new', source: 'claude', external_session_id: 'claude-session' }],
      executions: [snapshot.executions[1]],
      segments: [snapshot.segments[1]],
    }, 'child'),
    (error) => error.code === 'SESSION_SOURCE_UNSUPPORTED',
  )
})

test('legacy source sessions resume only when a matching local Codex transcript exists', async () => {
  const legacySnapshot = {
    ...snapshot,
    source_sessions: [{ id: 'source-new', source: 'legacy', external_session_id: 'session-new' }],
    executions: [snapshot.executions[1]],
    segments: [snapshot.segments[1]],
  }
  const launches = []
  const service = createSessionResumeService({
    store: { snapshot: () => legacySnapshot },
    settings: { get: async () => ({ settings: { resume_terminal: 'terminal' } }) },
    sessionInventory: { has: async () => true },
    terminalLauncher: { launch: async (input) => launches.push(input) && { terminal: 'terminal' } },
  })

  const result = await service.resumeTask('child')
  assert.equal(result.session_source, 'legacy')
  assert.equal(launches.length, 1)

  const unavailable = createSessionResumeService({
    store: { snapshot: () => legacySnapshot },
    settings: { get: async () => ({ settings: { resume_terminal: 'terminal' } }) },
    sessionInventory: { has: async () => false },
    terminalLauncher: { launch: async () => assert.fail('launcher must not run') },
  })
  await assert.rejects(
    unavailable.resumeTask('child'),
    (error) => error.code === 'CODEX_SESSION_NOT_FOUND',
  )
})

test('scheduled Run resume uses only canonical Run facts and returns privacy-bounded metadata', async () => {
  const requests = []
  const launches = []
  const service = createSessionResumeService({
    store: { snapshot: () => snapshot },
    settings: { get: async () => ({ settings: { resume_terminal: 'otty' } }) },
    schedulerService: {
      getRun: async (...args) => {
        requests.push(args)
        return { run: scheduledRun() }
      },
    },
    sessionInventory: { has: async (sessionId) => sessionId === 'thread-scheduled' },
    terminalLauncher: {
      launch: async (input) => {
        launches.push(input)
        return {
          terminal: 'otty', terminal_label: 'Otty', session_id: input.sessionId,
          workspace: input.workspace, window_title: input.title,
        }
      },
    },
  })

  const result = await service.resumeScheduledRun(SCHEDULED_RUN_ID, {
    thread_id: 'browser-thread', workspace: '/browser/workspace', title: 'Browser title',
  })

  assert.deepEqual(requests, [[SCHEDULED_RUN_ID]])
  assert.deepEqual(launches, [{
    terminal: 'otty', sessionId: 'thread-scheduled',
    workspace: '/canonical/scheduled-workspace', title: 'Canonical scheduled title',
  }])
  assert.deepEqual(result, {
    ok: true, run_id: SCHEDULED_RUN_ID, job_id: SCHEDULED_JOB_ID,
    terminal: 'otty', terminal_label: 'Otty',
  })
  assert.equal('session_id' in result, false)
  assert.equal('workspace' in result, false)
})

test('scheduled Run resume rejects a missing or invalid thread before lookup or launch', async () => {
  let threadId = null
  const service = createSessionResumeService({
    store: { snapshot: () => snapshot },
    settings: { get: async () => assert.fail('settings must not be read') },
    schedulerService: { getRun: async () => ({ run: scheduledRun({ thread_id: threadId }) }) },
    sessionInventory: { has: async () => assert.fail('inventory must not be read') },
    terminalLauncher: { launch: async () => assert.fail('launcher must not run') },
  })

  for (const value of [null, 'invalid thread id']) {
    threadId = value
    await assert.rejects(
      service.resumeScheduledRun(SCHEDULED_RUN_ID),
      (error) => error.code === 'SCHEDULE_RUN_NOT_RESUMABLE',
    )
  }
})

test('scheduled Run resume rejects a missing local transcript before launch', async () => {
  const service = createSessionResumeService({
    store: { snapshot: () => snapshot },
    settings: { get: async () => assert.fail('settings must not be read') },
    schedulerService: { getRun: async () => ({ run: scheduledRun() }) },
    sessionInventory: { has: async () => false },
    terminalLauncher: { launch: async () => assert.fail('launcher must not run') },
  })

  await assert.rejects(
    service.resumeScheduledRun(SCHEDULED_RUN_ID),
    (error) => error.code === 'CODEX_SESSION_NOT_FOUND',
  )
})

test('scheduled Run resume preserves typed terminal launch errors', async () => {
  const terminalError = Object.assign(new Error('Otty is unavailable'), { code: 'TERMINAL_UNAVAILABLE' })
  const service = createSessionResumeService({
    store: { snapshot: () => snapshot },
    settings: { get: async () => ({ settings: { resume_terminal: 'otty' } }) },
    schedulerService: { getRun: async () => ({ run: scheduledRun() }) },
    sessionInventory: { has: async () => true },
    terminalLauncher: { launch: async () => { throw terminalError } },
  })

  await assert.rejects(
    service.resumeScheduledRun(SCHEDULED_RUN_ID),
    (error) => error === terminalError,
  )
})
