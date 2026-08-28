import { runtimeEvent } from '../runtime/runtime-event.mjs'
import {
  captureWorkspaceSnapshot,
  diffWorkspaceSnapshots,
  mergeFileChanges,
} from './workspace-change-tracker.mjs'

export function createRunService({
  runStore,
  registry,
  supervisor,
  eventHub,
  logStore,
  clock = () => new Date(),
  onChange = () => {},
} = {}) {
  if (!runStore?.create || !runStore?.get || !registry?.resolve || !registry?.get
    || !supervisor?.start || !eventHub?.publish || !eventHub?.subscribe
    || !eventHub?.replayState
    || !logStore?.open || typeof clock !== 'function' || typeof onChange !== 'function') {
    throw new TypeError('RunService dependencies are invalid')
  }

  const active = new Map()
  const sequences = new Map()
  let shuttingDown = false

  async function create(input) {
    if (shuttingDown) throw serviceError('RUN_SERVICE_STOPPING', 'RunService is stopping')
    const runtimeId = input.schedule?.agent ?? 'codex'
    const run = runStore.create({ ...input, runtime_id: runtimeId })
    if (!active.has(run.id) && ['queued', 'running'].includes(run.status)) {
      const controller = new AbortController()
      const execution = { controller, promise: null, session: null, turnRevision: null }
      active.set(run.id, execution)
      execution.promise = Promise.resolve()
        .then(() => launch(run.id, controller.signal))
        .catch(() => undefined)
        .finally(() => active.delete(run.id))
      publishStatus(run.id, 'queued')
    }
    changed(run.id)
    return { run: publicRun(run) }
  }

  async function launch(runId, signal) {
    let logs = null
    try {
      const queued = runStore.get(runId)
      if (queued.status !== 'queued') return
      const launchTarget = await abortable(registry.resolve(queued.runtime_id), signal)
      if (signal.aborted) return cancelQueuedIfOpen(runStore, runId)
      const definition = registry.get(queued.runtime_id)
      const workspaceBefore = await safeWorkspaceSnapshot(queued.snapshot.workspace)

      logs = await logStore.open({
        scheduleId: queued.schedule_id,
        runId: queued.id,
      })
      let sequence = sequences.get(runId) ?? 0
      const emitEvent = (event) => {
        sequences.set(runId, Math.max(sequences.get(runId) ?? 0, event.sequence))
        eventHub.publish(event)
      }
      const onSpawn = ({ pid }) => {
        runStore.markRunning(runId, {
          runtime_version: launchTarget.version,
          pid,
        })
        publishStatus(runId, 'running')
        changed(runId)
      }
      let result
      if (typeof definition.createInteractiveSession === 'function') {
        const session = definition.createInteractiveSession({
          launch: launchTarget,
          run: queued.snapshot,
          signal,
          onSpawn,
          emit(event) {
            sequence = Math.max(sequence, sequences.get(runId) ?? 0)
            const normalized = runtimeEvent({
              runId,
              sequence: ++sequence,
              observedAt: nowIso(clock),
              type: event.type,
              payload: event.payload,
            })
            if (normalized.type === 'turn_started') {
              const execution = active.get(runId)
              if (execution) execution.turnRevision = normalized.payload.turn_revision
            }
            emitEvent(normalized)
          },
        })
        const execution = active.get(runId)
        if (execution) execution.session = session
        result = await session.start()
      } else {
        const invocation = await definition.buildInvocation({
          launch: launchTarget,
          run: queued.snapshot,
        })
        if (signal.aborted) return cancelQueuedIfOpen(runStore, runId)
        result = await supervisor.start({
          invocation,
          signal,
          logs,
          parseEvent(line) {
            sequence = Math.max(sequence, sequences.get(runId) ?? 0)
            return definition.parseEvent(line, {
              runId,
              sequence: ++sequence,
              observedAt: nowIso(clock),
              workspace: queued.snapshot.workspace,
            })
          },
          emit: emitEvent,
          onSpawn,
        })
      }

      const workspaceAfter = await safeWorkspaceSnapshot(queued.snapshot.workspace)
      result = {
        ...result,
        file_changes: mergeFileChanges(
          result.file_changes,
          diffWorkspaceSnapshots(workspaceBefore, workspaceAfter),
        ),
      }

      const stdoutLogPath = logsPath(logs, 'stdout')
      const stderrLogPath = logsPath(logs, 'stderr')
      let logFailure = null
      try {
        await logs.close()
      } catch {
        logFailure = 'RUN_LOG_WRITE_FAILED'
      }
      logs = null
      const status = logFailure ? 'failed' : result.status
      const completed = runStore.complete(runId, {
        status,
        exit_code: result.exit_code,
        error_code: logFailure ?? mapProcessError(result.error_code),
        session_id: result.session_id,
        final_message: result.final_message,
        usage: result.usage,
        file_changes: result.file_changes,
        stdout_log_path: stdoutLogPath ?? logStorePath(queued, 'stdout'),
        stderr_log_path: stderrLogPath ?? logStorePath(queued, 'stderr'),
      })
      publishStatus(runId, completed.status)
      changed(runId)
    } catch (error) {
      try {
        const current = runStore.get(runId)
        if (['queued', 'running'].includes(current.status)) {
          const failed = runStore.complete(runId, {
            status: signal.aborted ? 'canceled' : 'failed',
            error_code: signal.aborted
              ? 'RUN_CANCELED'
              : stableErrorCode(error),
          })
          publishStatus(runId, failed.status)
          changed(runId)
        }
      } catch {}
    } finally {
      await logs?.close().catch(() => {})
    }
  }

  function cancel(runId) {
    const run = runStore.get(runId)
    const execution = active.get(run.id)
    execution?.controller.abort()
    execution?.session?.close?.()
    if (run.status === 'queued') {
      const canceled = runStore.cancelQueued(run.id)
      publishStatus(run.id, canceled.status)
      changed(run.id)
      return publicRun(canceled)
    }
    return publicRun(run)
  }

  function recover() {
    const interrupted = runStore.interruptOpen()
    if (interrupted > 0) onChange({ kind: 'runs', recovery: true })
    return interrupted
  }

  async function whenIdle() {
    while (active.size > 0) {
      await Promise.allSettled([...active.values()].map(({ promise }) => promise))
    }
  }

  async function shutdown() {
    if (shuttingDown) return whenIdle()
    shuttingDown = true
    for (const { controller } of active.values()) controller.abort()
    await whenIdle()
  }

  function publishStatus(runId, state) {
    const event = runtimeEvent({
      runId,
      sequence: (sequences.get(runId) ?? 0) + 1,
      observedAt: nowIso(clock),
      type: 'status',
      payload: { state },
    })
    sequences.set(runId, event.sequence)
    eventHub.publish(event)
  }

  function changed(id) {
    try { onChange({ kind: 'run', id }) } catch {}
  }

  async function steer(runId, input) {
    const { execution, revision } = currentInteractiveTurn(runId, input)
    await execution.session.steer({
      expectedTurnRevision: revision,
      text: input.text,
    })
    return { accepted: true, run_id: runId, turn_revision: revision }
  }

  async function stop(runId, input) {
    const { execution, revision } = currentInteractiveTurn(runId, input)
    await execution.session.interrupt({ expectedTurnRevision: revision })
    return { accepted: true, run_id: runId, turn_revision: revision }
  }

  function currentInteractiveTurn(runId, input) {
    const run = runStore.get(runId)
    if (run.status !== 'running') throw serviceError('RUN_NOT_ACTIVE', 'Run is not active')
    const execution = active.get(runId)
    if (!execution?.session) {
      throw serviceError('RUNTIME_NOT_INTERACTIVE', 'Run does not support intervention')
    }
    const revision = input?.expected_turn_revision
    if (!Number.isSafeInteger(revision) || revision < 1) {
      throw serviceError('INTERVENTION_INVALID', 'Turn revision is invalid')
    }
    if (revision !== execution.turnRevision) {
      throw serviceError('TURN_CHANGED', 'The active Turn changed')
    }
    return { execution, revision }
  }

  function readPublicRun(id) {
    const run = publicRun(runStore.get(id))
    const execution = active.get(id)
    return {
      ...run,
      interactive: Boolean(execution?.session),
      turn_revision: execution?.turnRevision ?? null,
    }
  }

  return Object.freeze({
    create,
    get: readPublicRun,
    list: (query) => runStore.list(query).map((run) => {
      const result = publicRun(run)
      const execution = active.get(run.id)
      return {
        ...result,
        interactive: Boolean(execution?.session),
        turn_revision: execution?.turnRevision ?? null,
      }
    }),
    latestOccurrence(scheduleId) {
      return runStore.list({ schedule_id: scheduleId, limit: 100 })
        .find(({ occurrence_key: occurrenceKey }) => occurrenceKey !== null) ?? null
    },
    cancel,
    steer,
    stop,
    markReviewed: (id) => publicRun(runStore.markReviewed(id)),
    resumeTarget(id) {
      const run = runStore.get(id)
      return {
        run_id: run.id,
        schedule_id: run.schedule_id,
        runtime_id: run.runtime_id,
        session_id: run.session_id,
        workspace: run.snapshot?.workspace ?? null,
        title: run.snapshot?.title ?? null,
      }
    },
    events: (runId, listener, options) => eventHub.subscribe(runId, listener, options),
    eventReplay: (runId, afterSequence) => eventHub.replayState(runId, afterSequence),
    recover,
    whenIdle,
    shutdown,
  })
}

function cancelQueuedIfOpen(runStore, runId) {
  const run = runStore.get(runId)
  if (run.status === 'queued') runStore.cancelQueued(runId)
}

function publicRun(run) {
  const result = { ...run }
  delete result.snapshot
  return result
}

function stableErrorCode(error) {
  return /^[A-Z][A-Z0-9_]{1,95}$/.test(error?.code)
    ? error.code
    : 'RUN_LAUNCH_FAILED'
}

function mapProcessError(code) {
  if (code === 'RUNTIME_SPAWN_FAILED') return 'RUN_SPAWN_FAILED'
  return code
}

function nowIso(clock) {
  const value = clock()
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.valueOf())) throw serviceError('CLOCK_INVALID', 'clock is invalid')
  return date.toISOString()
}

function serviceError(code, message) {
  return Object.assign(new Error(message), { code })
}

function abortable(promise, signal) {
  if (signal.aborted) {
    return Promise.reject(serviceError('RUN_CANCELED', 'Run was canceled'))
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(serviceError('RUN_CANCELED', 'Run was canceled'))
    signal.addEventListener('abort', onAbort, { once: true })
    Promise.resolve(promise).then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort)
    })
  })
}

function logsPath(logs, stream) {
  return logs?.[`${stream}_log_path`] ?? null
}

function logStorePath(run, stream) {
  const suffix = stream === 'stdout' ? 'stdout.jsonl' : 'stderr.log'
  return `${run.schedule_id}/${run.id}.${suffix}`
}

async function safeWorkspaceSnapshot(workspace) {
  try {
    return await captureWorkspaceSnapshot(workspace)
  } catch {
    return null
  }
}
