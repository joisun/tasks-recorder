import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createTaskStore } from '../mcp/src/task-store.mjs'
import { createTaskService } from '../mcp/src/task-service.mjs'
import { createApiServer } from '../server/src/api-server.mjs'
import { createRevisionHub } from '../server/src/revision-hub.mjs'

export async function temporaryStore(options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'tasks-recorder-test-'))
  const databasePath = join(directory, 'tasks.sqlite')
  const store = createTaskStore({ databasePath, ...options })
  return {
    databasePath,
    directory,
    store,
    async cleanup() {
      store.close()
      await rm(directory, { recursive: true, force: true })
    },
  }
}

export function taskInput(overrides = {}) {
  return {
    id: 'example-task',
    title: 'Example task',
    status: 'active',
    session_id: 'session-1',
    workfolder: '/workspace/example',
    agent: 'Codex',
    ...overrides,
  }
}

export async function temporaryApi({ clock = () => new Date() } = {}) {
  const temporary = await temporaryStore({ clock })
  const hub = createRevisionHub({ instanceId: 'test-taskd', keepaliveMs: 60_000 })
  const service = createTaskService({
    store: temporary.store,
    gitResolver: async (workfolder) => ({ gitRoot: workfolder, worktree: workfolder, branch: 'main' }),
    renderer: async () => ({ tasksPath: join(temporary.directory, 'Tasks.md'), historyPath: join(temporary.directory, 'History.md') }),
    outputDir: temporary.directory,
    dashboardPath: join(temporary.directory, 'index.html'),
    onChange: () => hub.publish(),
  })
  const api = createApiServer({
    service,
    store: temporary.store,
    hub,
    host: '127.0.0.1',
    port: 0,
    dashboardHtml: '<!doctype html><title>Tasks Recorder</title>',
  })
  const address = await api.listen()
  return {
    ...temporary,
    api,
    hub,
    url: address.url,
    async cleanup() {
      await api.close()
      hub.close()
      await temporary.cleanup()
    },
  }
}
