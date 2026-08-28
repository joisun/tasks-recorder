import { createJournalDashboardSnapshot } from '../../mcp/src/dashboard-data.mjs'
import { execFile } from 'node:child_process'
import { dirname, join } from 'node:path'
import { constants } from 'node:fs'
import { access, realpath, stat } from 'node:fs/promises'
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
import { createRunEventHub } from './runs/run-event-hub.mjs'
import { createRunService } from './runs/run-service.mjs'
import { createRunStore } from './runs/run-store.mjs'
import { createCodexRuntimeDefinition } from './runtime/adapters/codex.mjs'
import { createExecutableResolver } from './runtime/executable-resolver.mjs'
import { createProcessSupervisor } from './runtime/process-supervisor.mjs'
import { createRuntimeAgentRegistry } from './runtime/runtime-agent-registry.mjs'
import { createRuntimeEnvironment as createRuntimeEnvironmentService } from './runtime/runtime-environment.mjs'
import { createRunLogStore, createScheduledRunLogs } from './scheduler/scheduled-run-logs.mjs'
import { createScheduleDefinitionMonitor } from './scheduler/schedule-definition-monitor.mjs'
import { createScheduleDefinitionRepository } from './scheduler/schedule-definition-repository.mjs'
import {
  createSwitchableScheduleDefinitionRepository,
  stageScheduleDefinitionRelocation,
} from './scheduler/schedule-definition-relocation.mjs'
import { migrateSchedulerV1, migrateSchedulerV4 } from './scheduler/scheduler-migration.mjs'
import { createDefinitionScheduleService } from './scheduler/scheduler-service.mjs'
import { createSchedulerClock } from './scheduler/scheduler-clock.mjs'

export const AUTO_ARCHIVE_AFTER_MS = 5 * 24 * 60 * 60 * 1000
export const AUTO_ARCHIVE_SWEEP_MS = 60 * 60 * 1000

const MAX_SCHEDULER_STATUS_COUNT = 1_000_000

function schedulerError(code) {
  const error = new Error(code)
  error.code = code
  return error
}

function schedulerErrorCode(error, fallback = 'SCHEDULER_STARTUP_FAILED') {
  return typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{1,95}$/.test(error.code)
    ? error.code
    : fallback
}


function schedulerPaths(config, dataDirectory) {
  return {
    databasePath: config.schedulerDatabasePath ?? join(dataDirectory, 'scheduler.sqlite'),
    logsDirectory: config.schedulerLogsDirectory ?? join(dataDirectory, 'schedules', 'logs'),
    logMaxFileBytes: config.schedulerLogMaxFileBytes ?? 1024 * 1024,
    logMaxFiles: config.schedulerLogMaxFiles ?? 8,
    logMaxAgeMs: config.schedulerLogMaxAgeMs ?? 7 * 24 * 60 * 60 * 1000,
  }
}

async function canonicalRuntimeExecutable(path) {
  const canonical = await realpath(path)
  const metadata = await stat(canonical)
  if (!metadata.isFile()) throw schedulerError('RUNTIME_EXECUTABLE_INVALID')
  await access(canonical, constants.X_OK)
  return canonical
}

function probeRuntimeExecutable(executable, probe, { cwd, execFileImpl = execFile } = {}) {
  return new Promise((resolve, reject) => {
    execFileImpl(executable, [...(probe?.args ?? ['--version'])], {
      cwd,
      encoding: 'utf8',
      timeout: probe?.timeout_ms ?? 5_000,
      maxBuffer: 64 * 1024,
      windowsHide: true,
      shell: false,
    }, (error, stdout, stderr) => {
      if (error) {
        reject(error)
        return
      }
      const version = String(stdout || stderr || '').trim().slice(0, 512)
      if (!version) {
        reject(schedulerError('RUNTIME_VERSION_INVALID'))
        return
      }
      resolve({ version })
    })
  })
}

function boundedSchedulerCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? Math.min(value, MAX_SCHEDULER_STATUS_COUNT) : 0
}


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
  createApi = createApiServer,
  createSchedulerDefinitions = createScheduleDefinitionRepository,
  createSchedulerDefinitionMonitor = createScheduleDefinitionMonitor,
  stageSchedulerDefinitionRelocation = stageScheduleDefinitionRelocation,
  migrateSchedulerStore = migrateSchedulerV1,
  migrateRunLedger = migrateSchedulerV4,
  createRunLedger = createRunStore,
  createRuntimeEnvironment = createRuntimeEnvironmentService,
  createRuntimeResolver = createExecutableResolver,
  createRuntimeRegistry = createRuntimeAgentRegistry,
  createCodexRuntime = createCodexRuntimeDefinition,
  createSupervisor = createProcessSupervisor,
  createRunEvents = createRunEventHub,
  createRuns = createRunService,
  createRunLogs = createRunLogStore,
  createClockScheduler = createSchedulerClock,
  runtimeExecFile = execFile,
  createDefinitionScheduleService: createScheduleService = createDefinitionScheduleService,
  createScheduledRunLogs: createScheduleLogs = createScheduledRunLogs,
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
  const schedulePaths = schedulerPaths(config, dataDirectory)
  let schedulerState = {
    capability: null,
    ready: false,
    degraded: false,
    error_code: null,
    backlog: 0,
    count: 0,
  }
  let schedulerStore = null
  let schedulerDefinitions = null
  let schedulerMonitor = null
  let schedulerService = null
  let schedulerClock = null
  let runtimeRegistry = null
  let runService = null
  let runEventHub = null
  let scheduledRunLogs = null
  let schedulerClosed = false

  function newSchedulerMonitor(onDiff = async () => {
    schedulerClock?.notifyDefinitionsChanged()
    hub.publish()
  }) {
    return createSchedulerDefinitionMonitor({
      repository: schedulerDefinitions,
      onDiff,
    })
  }

  async function restoreSchedulerMonitor() {
    const monitor = newSchedulerMonitor()
    await monitor.start({ emitInitial: false })
    schedulerMonitor = monitor
  }

  async function relocateDefinitionsDirectory({ directory, persist }) {
    if (!schedulerDefinitions?.current || typeof persist !== 'function') {
      throw schedulerError('SCHEDULE_RELOCATION_UNAVAILABLE')
    }
    const oldRepository = schedulerDefinitions.current()
    const oldMonitor = schedulerMonitor
    await oldMonitor?.close()
    schedulerMonitor = null
    let transaction = null
    let nextMonitor = null
    let swapped = false
    try {
      transaction = await stageSchedulerDefinitionRelocation({
        sourceRepository: oldRepository,
        targetDirectory: directory,
        createRepository: createSchedulerDefinitions,
        clock,
      })
      await transaction.verifySource()
      await transaction.candidateRepository.list()
      schedulerDefinitions.replace(transaction.candidateRepository)
      swapped = true
      nextMonitor = newSchedulerMonitor()
      await nextMonitor.start({ emitInitial: false })
      schedulerMonitor = nextMonitor
      await persist()
      const committed = await transaction.commit()
      schedulerClock?.notifyDefinitionsChanged()
      hub.publish()
      return {
        moved_count: transaction.movedCount,
        merged_count: transaction.mergedCount,
        cleanup_warning: committed.cleanupWarning,
      }
    } catch (error) {
      await nextMonitor?.close().catch(() => undefined)
      if (schedulerMonitor === nextMonitor) schedulerMonitor = null
      if (swapped) schedulerDefinitions.replace(oldRepository)
      await transaction?.rollback().catch(() => undefined)
      await restoreSchedulerMonitor().catch(() => undefined)
      throw error
    }
  }
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
  const diagnostics = createDiagnostics({
    store,
    spool,
    logger,
    scheduler: async () => {
      let count = schedulerState.count
      if (schedulerDefinitions?.list && runService?.list) {
        try { count = (await schedulerDefinitions.list()).length + runService.list({ limit: 1_000 }).length } catch {}
      }
      return { ...schedulerState, count }
    },
  })
  const terminalLauncher = createLauncher({
    runtimeDirectory: join(dataDirectory, 'runtime'),
  })
  const dashboardSettings = createSettings({
    configPath: config.configPath ?? join(dataDirectory, 'config.json'),
    terminalLauncher,
    relocateDefinitionsDirectory,
  })
  const sessionInventory = createSessionInventory()
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
  let closed = false
  let autoArchiveTimer = null
  let autoArchivePending = null
  let api = null
  async function closeScheduler() {
    if (schedulerClosed) return
    schedulerClosed = true
    try {
      await schedulerClock?.close()
      await runService?.shutdown()
      await schedulerMonitor?.close()
    } finally {
      schedulerClock = null
      schedulerMonitor = null
      schedulerService = null
      schedulerDefinitions = null
      scheduledRunLogs = null
      runService = null
      runtimeRegistry = null
      runEventHub?.close()
      runEventHub = null
      try { schedulerStore?.close() } finally { schedulerStore = null }
    }
  }


  async function startScheduler() {
    let startupCount = 0
    try {
      const definitionsDirectory = config.scheduleDefinitionsDirectory ?? join(dataDirectory, 'schedules')
      const initialDefinitions = createSchedulerDefinitions({
        rootDirectory: definitionsDirectory,
        clock,
        hardenRoot: definitionsDirectory === join(dataDirectory, 'schedules'),
      })
      await initialDefinitions.scan()
      await migrateSchedulerStore({
        databasePath: schedulePaths.databasePath,
        repository: initialDefinitions,
        clock,
      })
      migrateRunLedger({ databasePath: schedulePaths.databasePath, clock })
      schedulerDefinitions = createSwitchableScheduleDefinitionRepository(initialDefinitions)
      schedulerStore = createRunLedger({
        databasePath: schedulePaths.databasePath,
        clock,
      })
      const resolverEnvironment = { ...process.env }
      if (typeof config.codexPath === 'string' && config.codexPath.length > 0) {
        resolverEnvironment.CODEX_BIN = config.codexPath
      }
      const runtimeEnvironment = createRuntimeEnvironment({ env: resolverEnvironment })
      const runtimeResolver = createRuntimeResolver({
        env: resolverEnvironment,
        runtimeEnvironment,
        canonicalize: canonicalRuntimeExecutable,
        probe: (executable, probe) => probeRuntimeExecutable(executable, probe, {
          cwd: dataDirectory,
          execFileImpl: runtimeExecFile,
        }),
      })
      runtimeRegistry = createRuntimeRegistry({
        definitions: [createCodexRuntime({
          execFileImpl: runtimeExecFile,
          runtimeEnvironment,
        })],
        resolver: runtimeResolver,
      })
      runEventHub = createRunEvents({ maximumEventsPerRun: 256 })
      const runLogStore = createRunLogs({
        root: schedulePaths.logsDirectory,
        maxFileBytes: schedulePaths.logMaxFileBytes,
        maxFiles: schedulePaths.logMaxFiles,
        maxAgeMs: schedulePaths.logMaxAgeMs,
      })
      scheduledRunLogs = createScheduleLogs({
        store: schedulerStore,
        root: schedulePaths.logsDirectory,
      })
      runService = createRuns({
        runStore: schedulerStore,
        registry: runtimeRegistry,
        supervisor: createSupervisor({ runtimeEnvironment }),
        eventHub: runEventHub,
        logStore: runLogStore,
        clock,
        onChange: (change) => hub.publish(change),
      })
      runService.recover()
      schedulerService = createScheduleService({
        definitions: schedulerDefinitions,
        runtimeRegistry,
        runService,
        clock,
      })
      schedulerClock = createClockScheduler({
        definitions: schedulerDefinitions,
        runService,
        clock,
      })
      schedulerMonitor = newSchedulerMonitor()
      await schedulerMonitor.start()
      schedulerClock.start()
      startupCount = boundedSchedulerCount(
        (await schedulerDefinitions.list()).length + runService.list({ limit: 1_000 }).length,
      )
      schedulerState = {
        capability: { backend: 'taskd-clock', supported: true },
        ready: true,
        degraded: false,
        error_code: null,
        backlog: 0,
        count: startupCount,
      }
    } catch (error) {
      const code = schedulerErrorCode(error)
      try {
        startupCount = boundedSchedulerCount((schedulerDefinitions?.list ? (await schedulerDefinitions.list()).length : 0)
          + (runService?.list?.({ limit: 1_000 })?.length ?? 0))
      } catch {}
      await closeScheduler().catch(() => {})
      schedulerState = {
        capability: null,
        ready: false,
        degraded: true,
        error_code: code,
        backlog: 0,
        count: startupCount,
      }
    }
  }

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
    await startScheduler()
    const sessionResume = createResumeService({
      store,
      settings: dashboardSettings,
      terminalLauncher,
      sessionInventory,
      runService,
    })
    api = createApi({
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
      schedulerService,
      scheduledRunLogs,
      runtimeRegistry,
      runService,
      schedulerClock,
      packageVersion: config.packageVersion ?? 'source',
    })
    const address = await api.listen()
    autoArchiveTimer = scheduleInterval(() => archiveCompletedRoots(), autoArchiveSweepMs)
    autoArchiveTimer.unref?.()
    return {
      address,
      startup: { schema_version: store.check().schemaVersion },
      scheduler: { ...schedulerState },
      async close() {
        if (closed) return
        closed = true
        if (autoArchiveTimer) clearScheduledInterval(autoArchiveTimer)
        await autoArchivePending
        hub.close()
        try {
          await api?.close()
        } finally {
          try { await closeScheduler() } finally { store.close() }
        }
      },
    }
  } catch (error) {
    if (autoArchiveTimer) clearScheduledInterval(autoArchiveTimer)
    hub.close()
    try { await api?.close() } catch {}
    try { await closeScheduler() } finally { store.close() }
    throw error
  }
}
