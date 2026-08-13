import assert from 'node:assert/strict'
import test from 'node:test'

import { createTaskService } from '../mcp/src/task-service.mjs'

test('dashboardSnapshot reads the authoritative store on every call without Git or rendering', async () => {
  let snapshotCalls = 0
  let gitCalls = 0
  let renderCalls = 0
  const service = createTaskService({
    store: {
      snapshot() {
        snapshotCalls += 1
        return { tasks: [{ id: `task-${snapshotCalls}` }], sessions: [] }
      },
    },
    gitResolver: async () => { gitCalls += 1; return {} },
    renderer: async () => { renderCalls += 1; return {} },
    outputDir: '/unused',
    dashboardAdapter: (snapshot) => snapshot,
  })

  assert.equal((await service.dashboardSnapshot()).tasks[0].id, 'task-1')
  assert.equal((await service.dashboardSnapshot()).tasks[0].id, 'task-2')
  assert.equal(snapshotCalls, 2)
  assert.equal(gitCalls, 0)
  assert.equal(renderCalls, 0)
})

test('task writes persist without touching legacy Markdown projections', async () => {
  let renderCalls = 0
  let persisted = false
  const changes = []
  const service = createTaskService({
    store: {
      upsert: (input) => {
        persisted = true
        return { task: { id: input.id }, session: { session_id: input.session_id } }
      },
    },
    gitResolver: async () => ({ gitRoot: '/workspace', worktree: '/workspace', branch: 'main' }),
    renderer: async () => { renderCalls += 1; throw new Error('legacy output unavailable') },
    outputDir: '/missing-legacy-output',
    access: async () => { throw new Error('not writable') },
    onChange: (change) => {
      assert.equal(persisted, true)
      changes.push(change)
      return { server_instance_id: 'server-a', revision: 7 }
    },
  })

  const result = await service.upsert({
    id: 'short-task', title: 'Short task', status: 'done',
    session_id: 'session-1', workfolder: '/workspace', agent: 'Codex',
  })
  assert.equal(result.ok, true)
  assert.equal(result.persisted, true)
  assert.deepEqual(result.change, { server_instance_id: 'server-a', revision: 7 })
  assert.deepEqual(changes, [{ type: 'tasks.changed', operation: 'upsert', task_id: 'short-task' }])
  assert.equal(renderCalls, 0)
})

test('failed task writes do not publish a change', async () => {
  let changeCalls = 0
  const service = createTaskService({
    store: { upsert: () => { throw new Error('rolled back') } },
    gitResolver: async () => ({ gitRoot: '/workspace', worktree: '/workspace', branch: 'main' }),
    renderer: async () => ({}),
    outputDir: '/unused',
    onChange: () => { changeCalls += 1 },
  })

  await assert.rejects(
    service.upsert({
      id: 'failed-task', title: 'Failed', status: 'active',
      session_id: 'session-1', workfolder: '/workspace',
    }),
    /rolled back/,
  )
  assert.equal(changeCalls, 0)
})

test('check reports the standalone dashboard build without mutating task state', async () => {
  let statCalls = 0
  const service = createTaskService({
    store: {
      check: () => ({ schemaVersion: 1, integrity: 'ok' }),
      snapshot: () => ({ tasks: [], sessions: [] }),
    },
    gitResolver: async () => ({}),
    renderer: async () => ({}),
    outputDir: '/legacy',
    dashboardPath: '/plugin/ui/dist/index.html',
    stat: async (path) => {
      statCalls += 1
      if (path.endsWith('index.html')) return { mtimeMs: Date.parse('2026-08-12T08:00:00.000Z') }
      const error = new Error('missing')
      error.code = 'ENOENT'
      throw error
    },
  })

  const health = await service.check()
  assert.deepEqual(health.dashboard, {
    available: true,
    build_path: '/plugin/ui/dist/index.html',
    built_at: '2026-08-12T08:00:00.000Z',
  })
  assert.equal(statCalls, 3)
})

test('status service publishes exactly once only for a committed change', async () => {
  const notifications = []
  const service = createTaskService({
    store: {
      updateStatus: ({ status }) => ({
        task: { id: 'task-a', status },
        affected_parent: status === 'blocked' ? { id: 'parent', status: 'active' } : null,
        changed: status !== 'planned',
      }),
    },
    gitResolver: async () => { throw new Error('must not resolve Git') },
    renderer: async () => { throw new Error('must not render') },
    outputDir: '/unused',
    onChange: (event) => {
      notifications.push(event)
      return { server_instance_id: 'server-a', revision: notifications.length }
    },
  })

  const changed = await service.updateStatus({ id: 'task-a', status: 'blocked' })
  assert.equal(changed.persisted, true)
  assert.equal(changed.changed, true)
  assert.equal(changed.change.revision, 1)
  assert.deepEqual(notifications, [{
    type: 'tasks.changed',
    operation: 'updateStatus',
    task_id: 'task-a',
    affected_parent_id: 'parent',
  }])

  const noop = await service.updateStatus({ id: 'task-a', status: 'planned' })
  assert.equal(noop.persisted, false)
  assert.equal(noop.changed, false)
  assert.equal('change' in noop, false)
  assert.equal(notifications.length, 1)
})
