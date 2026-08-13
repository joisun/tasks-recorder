import { createDashboardSnapshot } from '../../mcp/src/dashboard-data.mjs'
import { discoverGitContext } from '../../mcp/src/git-context.mjs'
import { renderProjections } from '../../mcp/src/renderer.mjs'
import { createTaskService } from '../../mcp/src/task-service.mjs'
import { createTaskStore } from '../../mcp/src/task-store.mjs'
import { createApiServer } from './api-server.mjs'
import { createRevisionHub } from './revision-hub.mjs'

export async function startTaskd({
  config,
  dashboardPath,
  dashboardHtml,
  createStore = createTaskStore,
  gitResolver = discoverGitContext,
  renderer = renderProjections,
  dashboardAdapter = createDashboardSnapshot,
}) {
  const store = createStore({ databasePath: config.databasePath })
  const hub = createRevisionHub()
  const service = createTaskService({
    store,
    gitResolver,
    renderer,
    outputDir: config.outputDir,
    dashboardPath,
    dashboardAdapter,
    onChange: () => hub.publish(),
  })
  const api = createApiServer({
    service,
    store,
    hub,
    host: config.serverHost,
    port: config.serverPort,
    dashboardHtml,
  })
  let closed = false
  try {
    const address = await api.listen()
    return {
      address,
      async close() {
        if (closed) return
        closed = true
        hub.close()
        try {
          await api.close()
        } finally {
          store.close()
        }
      },
    }
  } catch (error) {
    hub.close()
    store.close()
    throw error
  }
}
