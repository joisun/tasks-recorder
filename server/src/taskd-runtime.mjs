import { createJournalDashboardSnapshot } from '../../mcp/src/dashboard-data.mjs'
import { dirname, join } from 'node:path'
import { discoverGitContext } from '../../mcp/src/git-context.mjs'
import { createJournalDiagnostics } from '../../mcp/src/journal-diagnostics.mjs'
import { createJournalService } from '../../mcp/src/journal-service.mjs'
import { createJournalStore } from '../../mcp/src/journal-store.mjs'
import { renderProjections } from '../../mcp/src/renderer.mjs'
import { createV3CompatibilityService } from '../../mcp/src/v3-compatibility-service.mjs'
import { createEventSpool } from '../../hooks/src/event-spool.mjs'
import { createApiServer } from './api-server.mjs'
import { prepareJournalStartup } from './journal-startup.mjs'
import { createRevisionHub } from './revision-hub.mjs'
import { createStructuredLogger } from './structured-logger.mjs'

export async function startTaskd({
  config,
  dashboardPath,
  dashboardHtml,
  createStore = createJournalStore,
  createJournal = createJournalService,
  createCompatibility = createV3CompatibilityService,
  createSpool = createEventSpool,
  createLogger = createStructuredLogger,
  createDiagnostics = createJournalDiagnostics,
  prepareStartup = prepareJournalStartup,
  detectInactiveSessions = async () => [],
  gitResolver = discoverGitContext,
  renderer = renderProjections,
  dashboardAdapter = createJournalDashboardSnapshot,
}) {
  const store = createStore({ databasePath: config.databasePath })
  const hub = createRevisionHub()
  const dataDirectory = dirname(config.databasePath)
  const spool = createSpool({
    directory: config.spoolDirectory ?? join(dataDirectory, 'spool'),
    maxBytes: config.spoolMaxBytes ?? 4 * 1024 * 1024,
    maxFiles: config.spoolMaxFiles ?? 512,
    maxAgeMs: config.spoolMaxAgeMs ?? 7 * 24 * 60 * 60 * 1000,
  })
  const logger = createLogger({
    directory: config.logsDirectory ?? join(dataDirectory, 'logs'),
    maxFileBytes: config.logMaxFileBytes ?? 1024 * 1024,
    maxFiles: config.logMaxFiles ?? 5,
    maxAgeMs: config.logMaxAgeMs ?? 14 * 24 * 60 * 60 * 1000,
  })
  const diagnostics = createDiagnostics({ store, spool, logger })
  const journalService = createJournal({
    store,
    logger,
    diagnostics,
    onChange: (change) => hub.publish(change),
  })
  const service = createCompatibility({
    store,
    journalService,
    gitResolver,
    renderer,
    outputDir: config.outputDir,
    dashboardPath,
    dashboardAdapter,
    onChange: () => hub.publish(),
  })
  const api = createApiServer({
    service,
    journalService,
    journalDiagnostics: diagnostics,
    store,
    hub,
    host: config.serverHost,
    port: config.serverPort,
    dashboardHtml,
  })
  let closed = false
  try {
    await prepareStartup({
      service: journalService,
      spool,
      detectInactiveSessions,
    })
    const address = await api.listen()
    return {
      address,
      startup: { schema_version: store.check().schemaVersion },
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
