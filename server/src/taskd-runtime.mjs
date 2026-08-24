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
import { createDashboardSettings } from './dashboard-settings.mjs'
import { createCodexSessionInventory } from './codex/session-inventory.mjs'
import { prepareJournalStartup } from './journal-startup.mjs'
import { createRevisionHub } from './revision-hub.mjs'
import { createSessionResumeService } from './session-resume-service.mjs'
import { createStructuredLogger } from './structured-logger.mjs'
import { createTerminalLauncher } from './terminal-launcher.mjs'

export const AUTO_ARCHIVE_AFTER_MS = 5 * 24 * 60 * 60 * 1000
export const AUTO_ARCHIVE_SWEEP_MS = 60 * 60 * 1000

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
  createSettings = createDashboardSettings,
  createSessionInventory = createCodexSessionInventory,
  createResumeService = createSessionResumeService,
  createLauncher = createTerminalLauncher,
  prepareStartup = prepareJournalStartup,
  detectInactiveSessions = async () => [],
  gitResolver = discoverGitContext,
  renderer = renderProjections,
  dashboardAdapter = createJournalDashboardSnapshot,
  clock = () => new Date(),
  autoArchiveAfterMs = AUTO_ARCHIVE_AFTER_MS,
  autoArchiveSweepMs = AUTO_ARCHIVE_SWEEP_MS,
  scheduleInterval = setInterval,
  clearScheduledInterval = clearInterval,
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
  const terminalLauncher = createLauncher({
    runtimeDirectory: join(dataDirectory, 'runtime'),
  })
  const dashboardSettings = createSettings({
    configPath: config.configPath ?? join(dataDirectory, 'config.json'),
    terminalLauncher,
  })
  const sessionInventory = createSessionInventory()
  const sessionResume = createResumeService({
    store,
    settings: dashboardSettings,
    terminalLauncher,
    sessionInventory,
  })
  const resumableDashboardAdapter = async (snapshot) => dashboardAdapter(snapshot, {
    resumableSessionIds: await sessionInventory.ids(),
  })
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
    dashboardAdapter: resumableDashboardAdapter,
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
    dashboardSettings,
    sessionResume,
  })
  let closed = false
  let autoArchiveTimer = null
  let autoArchivePending = null

  function archiveCompletedRoots() {
    if (autoArchivePending) return autoArchivePending
    autoArchivePending = (async () => {
      const now = clock()
      const timestamp = now instanceof Date ? now : new Date(now)
      if (Number.isNaN(timestamp.valueOf())) throw new TypeError('clock must return a valid date')
      const completedBefore = new Date(timestamp.valueOf() - autoArchiveAfterMs).toISOString()
      return journalService.archiveCompletedRoots({ completed_before: completedBefore })
    })().catch(async (error) => {
      await logger.write('maintenance.failed', {
        operation: 'task.auto_archive',
        error_code: error?.code ?? 'AUTO_ARCHIVE_FAILED',
      }).catch(() => undefined)
      return { ok: false, persisted: false, error_code: error?.code ?? 'AUTO_ARCHIVE_FAILED' }
    }).finally(() => {
      autoArchivePending = null
    })
    return autoArchivePending
  }

  try {
    await prepareStartup({
      service: journalService,
      spool,
      detectInactiveSessions,
    })
    await archiveCompletedRoots()
    const address = await api.listen()
    autoArchiveTimer = scheduleInterval(() => archiveCompletedRoots(), autoArchiveSweepMs)
    autoArchiveTimer.unref?.()
    return {
      address,
      startup: { schema_version: store.check().schemaVersion },
      async close() {
        if (closed) return
        closed = true
        if (autoArchiveTimer) clearScheduledInterval(autoArchiveTimer)
        await autoArchivePending
        hub.close()
        try {
          await api.close()
        } finally {
          store.close()
        }
      },
    }
  } catch (error) {
    if (autoArchiveTimer) clearScheduledInterval(autoArchiveTimer)
    hub.close()
    store.close()
    throw error
  }
}
