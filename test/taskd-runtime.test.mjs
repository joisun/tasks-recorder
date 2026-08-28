import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmod, link, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createJournalStore } from '../mcp/src/journal-store.mjs'
import {
  AUTO_ARCHIVE_SWEEP_MS,
  startTaskd,
} from '../server/src/taskd-runtime.mjs'
import { createCodexRuntimeDefinition } from '../server/src/runtime/adapters/codex.mjs'

function scheduleDefinition(id, title, workspace) {
  return `---
type: tasks-recorder/schedule
id: ${id}
title: ${title}
workspace: ${workspace}
schedule:
  kind: daily
  at: "09:00"
---

Review the project.
`
}

test('taskd runtime composes one store, serves health, and closes the database once', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tasks-recorder-runtime-'))
  const stores = []
  const codexRuntimeOptions = []
  let closeCalls = 0
  let runtime
  try {
    runtime = await startTaskd({
      config: {
        databasePath: join(directory, 'tasks.sqlite'),
        outputDir: directory,
        serverHost: '127.0.0.1',
        serverPort: 0,
      },
      dashboardPath: join(directory, 'index.html'),
      dashboardHtml: '<!doctype html><title>Taskd runtime</title>',
      createStore(options) {
        stores.push(options)
        const store = createJournalStore(options)
        return {
          ...store,
          close() {
            closeCalls += 1
            store.close()
          },
        }
      },
      createCodexRuntime(options) {
        codexRuntimeOptions.push(options)
        return createCodexRuntimeDefinition(options)
      },
      gitResolver: async () => ({}),
      renderer: async () => ({}),
      dashboardAdapter: () => ({ generated_at: '2026-08-12T08:00:00.000Z', tasks: [], warnings: [] }),
    })

    assert.deepEqual(stores, [{ databasePath: join(directory, 'tasks.sqlite') }])
    assert.equal(typeof codexRuntimeOptions[0].runtimeEnvironment.childEnvironment, 'function')
    assert.equal((await fetch(`${runtime.address.url}/health/ready`).then((response) => response.json())).ready, true)
    await runtime.close()
    await runtime.close()
    assert.equal(closeCalls, 1)
  } finally {
    await runtime?.close().catch(() => {})
    await rm(directory, { recursive: true, force: true })
  }
})
test('settings relocates the live Schedule registry, persists the path, and archives the old definition without restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tasks-recorder-runtime-relocation-'))
  const sourceRoot = join(directory, 'source-schedules')
  const targetRoot = join(directory, 'target-schedules')
  const workspace = join(directory, 'workspace')
  const configPath = join(directory, 'config.json')
  const scheduleId = '11111111-1111-4111-8111-111111111111'
  const monitorRoots = []
  let runtime
  try {
    await mkdir(sourceRoot)
    await mkdir(targetRoot)
    await mkdir(workspace)
    const canonicalSourceRoot = await realpath(sourceRoot)
    const canonicalTargetRoot = await realpath(targetRoot)
    await writeFile(join(sourceRoot, 'review.md'), scheduleDefinition(scheduleId, 'Review', workspace))
    await writeFile(configPath, `${JSON.stringify({
      output_dir: '.', server_port: 0, schedule_definitions_dir: sourceRoot,
    }, null, 2)}\n`)
    runtime = await startTaskd({
      config: {
        configPath,
        databasePath: join(directory, 'tasks.sqlite'), outputDir: directory,
        serverHost: '127.0.0.1', serverPort: 0,
        scheduleDefinitionsDirectory: sourceRoot,
        schedulerDatabasePath: join(directory, 'scheduler.sqlite'),
        schedulerLocksDirectory: join(directory, 'locks'),
        schedulerLogsDirectory: join(directory, 'schedule-logs'),
        schedulerSpoolDirectory: join(directory, 'schedule-spool'),
      },
      dashboardPath: join(directory, 'index.html'), dashboardHtml: '<!doctype html>',
      prepareStartup: async () => {},
      createLauncher: () => ({
        options: async () => [{ id: 'terminal', label: 'Terminal.app', available: true }],
        launch: async () => ({}),
      }),
      createSchedulerBackend: () => ({
        capability: async () => ({ backend: 'test', supported: true }),
        listOwned: async () => [],
        reconcile: async () => ({ action: 'installed' }),
        trigger: async () => ({ action: 'triggered' }),
      }),
      createSchedulerDefinitionMonitor: ({ repository, onDiff }) => {
        monitorRoots.push(repository.rootDirectory)
        return {
          async start({ emitInitial = true } = {}) {
            if (emitInitial) await onDiff({ added: await repository.list(), changed: [], removed: [], invalid: [] })
          },
          async close() {},
        }
      },
      createSchedulerSpool: () => ({
        replay: async () => ({ pending: 0, last_error: null }),
        status: async () => ({ pending_files: 0, backlog_files: 0 }),
      }),
      recoverSchedulerStaleRuns: async () => ({ recovered: [] }),
      createSchedulerProtocol: () => ({ start: async () => {}, close: async () => {} }),
      gitResolver: async () => ({}), renderer: async () => ({}),
      dashboardAdapter: () => ({ generated_at: '2026-08-26T04:00:00.000Z', tasks: [], warnings: [] }),
      clock: () => new Date('2026-08-26T04:00:00.000Z'),
    })
    assert.equal(runtime.scheduler.ready, true, JSON.stringify(runtime.scheduler))

    const response = await fetch(`${runtime.address.url}/api/v1/settings`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ schedule_definitions_dir: targetRoot }),
    })
    const result = await response.json()
    assert.equal(response.status, 200, JSON.stringify(result))
    assert.equal(result.restart_required, false)
    assert.deepEqual(result.relocation, { moved_count: 1, merged_count: 0, cleanup_warning: null })
    assert.equal(JSON.parse(await readFile(configPath, 'utf8')).schedule_definitions_dir, canonicalTargetRoot)
    const schedules = await fetch(`${runtime.address.url}/api/v1/schedules`).then((value) => value.json())
    assert.equal(schedules.jobs[0].id, scheduleId)
    assert.equal(schedules.jobs[0].source_path, join(canonicalTargetRoot, 'review.md'))
    assert.deepEqual(monitorRoots, [canonicalSourceRoot, canonicalTargetRoot])
    await assert.rejects(readFile(join(sourceRoot, 'review.md'), 'utf8'), { code: 'ENOENT' })
    assert.match(
      await readFile(join(sourceRoot, '.trash', 'migrated-2026-08-26T04-00-00-000Z', 'review.md'), 'utf8'),
      /title: Review/,
    )
  } finally {
    await runtime?.close().catch(() => {})
    await rm(directory, { recursive: true, force: true })
  }
})

test('taskd runtime closes an active SSE response before waiting for HTTP shutdown', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tasks-recorder-runtime-'))
  let storeCloseCalls = 0
  let runtime
  let reader
  let closing
  try {
    runtime = await startTaskd({
      config: { databasePath: join(directory, 'tasks.sqlite'), outputDir: directory, serverHost: '127.0.0.1', serverPort: 0 },
      dashboardPath: join(directory, 'index.html'),
      dashboardHtml: '<!doctype html>',
      createStore: (options) => {
        const store = createJournalStore(options)
        return {
          ...store,
          close() {
            storeCloseCalls += 1
            store.close()
          },
        }
      },
      gitResolver: async () => ({}), renderer: async () => ({}),
      dashboardAdapter: () => ({ generated_at: '2026-08-12T08:00:00.000Z', tasks: [], warnings: [] }),
    })
    const response = await fetch(`${runtime.address.url}/api/v1/events`)
    reader = response.body.getReader()
    await reader.read()

    closing = runtime.close()
    const closedPromptly = await Promise.race([
      closing.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 100)),
    ])
    assert.equal(closedPromptly, true)
    assert.equal(storeCloseCalls, 1)
  } finally {
    await reader?.cancel().catch(() => {})
    await closing?.catch(() => {})
    await runtime?.close().catch(() => {})
    await rm(directory, { recursive: true, force: true })
  }
})

test('taskd sweeps continuously and archives a root after five completed days', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tasks-recorder-runtime-archive-'))
  const databasePath = join(directory, 'tasks.sqlite')
  let now = new Date('2026-08-23T23:00:00.000Z')
  let scheduledSweep
  let scheduledDelay
  let clearedTimer = null
  let runtime
  let activeStore
  try {
    const seed = createJournalStore({
      databasePath,
      clock: () => new Date('2026-08-19T00:00:00.000Z'),
    })
    seed.projects.create({ id: 'project-a', name: 'Project A' })
    seed.tasks.create({
      id: 'independent-task', project_id: 'project-a', title: 'Independent task',
      lifecycle: 'done',
    })
    seed.close()

    const timer = { unrefCalled: false, unref() { this.unrefCalled = true } }
    runtime = await startTaskd({
      config: {
        databasePath,
        outputDir: directory,
        serverHost: '127.0.0.1',
        serverPort: 0,
      },
      dashboardPath: join(directory, 'index.html'),
      dashboardHtml: '<!doctype html>',
      createStore(options) {
        activeStore = createJournalStore({ ...options, clock: () => now })
        return activeStore
      },
      clock: () => now,
      scheduleInterval(callback, delay) {
        scheduledSweep = callback
        scheduledDelay = delay
        return timer
      },
      clearScheduledInterval(value) {
        clearedTimer = value
      },
      gitResolver: async () => ({}), renderer: async () => ({}),
      dashboardAdapter: () => ({ generated_at: now.toISOString(), tasks: [], warnings: [] }),
    })

    assert.equal(activeStore.tasks.show('independent-task').task.archived_at, null)
    assert.equal(scheduledDelay, AUTO_ARCHIVE_SWEEP_MS)
    assert.equal(timer.unrefCalled, true)

    now = new Date('2026-08-24T01:00:00.000Z')
    await scheduledSweep()
    assert.equal(
      activeStore.tasks.show('independent-task').task.archived_at,
      '2026-08-24T01:00:00.000Z',
    )

    await runtime.close()
    assert.equal(clearedTimer, timer)
  } finally {
    await runtime?.close().catch(() => {})
    await rm(directory, { recursive: true, force: true })
  }
})
