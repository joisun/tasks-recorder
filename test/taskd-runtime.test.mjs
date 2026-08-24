import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createJournalStore } from '../mcp/src/journal-store.mjs'
import {
  AUTO_ARCHIVE_SWEEP_MS,
  startTaskd,
} from '../server/src/taskd-runtime.mjs'

test('taskd runtime composes one store, serves health, and closes the database once', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tasks-recorder-runtime-'))
  const stores = []
  let closeCalls = 0
  try {
    const runtime = await startTaskd({
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
      gitResolver: async () => ({}),
      renderer: async () => ({}),
      dashboardAdapter: () => ({ generated_at: '2026-08-12T08:00:00.000Z', tasks: [], warnings: [] }),
    })

    assert.deepEqual(stores, [{ databasePath: join(directory, 'tasks.sqlite') }])
    assert.equal((await fetch(`${runtime.address.url}/health/ready`).then((response) => response.json())).ready, true)
    await runtime.close()
    await runtime.close()
    assert.equal(closeCalls, 1)
  } finally {
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
