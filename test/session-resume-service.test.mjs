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
