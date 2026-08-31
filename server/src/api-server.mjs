import { createServer } from 'node:http'

import { TaskRecorderError } from '../../mcp/src/errors.mjs'
import { readJson, sendJson } from './http-utils.mjs'

const IMPORT_BODY_LIMIT = 8 * 1024 * 1024
const SCHEDULE_LOG_TAIL_MAX = 64 * 1024
const RUN_INTERVENTION_TEXT_LIMIT = 16 * 1024
const RUN_INTERVENTION_BODY_LIMIT = RUN_INTERVENTION_TEXT_LIMIT + 256
const PUBLIC_SERVICE_ERRORS = new Set([
  'CODEX_MODEL_CATALOG_UNAVAILABLE',
  'CODEX_MODEL_UNAVAILABLE',
  'CODEX_REASONING_UNSUPPORTED',
  'SCHEDULE_RESUME_UNAVAILABLE',
  'SCHEDULER_BACKEND_UNSUPPORTED',
  'MODEL_CATALOG_UNAVAILABLE',
  'RUNTIME_UNAVAILABLE',
  'RUNTIME_PROTOCOL_UNAVAILABLE',
])

function httpError(code, message, statusCode) {
  const error = new Error(message)
  error.code = code
  error.statusCode = statusCode
  return error
}

function statusFor(error) {
  if (error.statusCode) return error.statusCode
  if (error.code === 'CODEX_MODEL_CATALOG_UNAVAILABLE') return 503
  if (error.code === 'MODEL_CATALOG_UNAVAILABLE' || error.code === 'RUNTIME_UNAVAILABLE') return 503
  if (error.code === 'RUNTIME_PROTOCOL_UNAVAILABLE') return 503
  if (
    error.code === 'TASK_NOT_FOUND'
    || error.code === 'PARENT_NOT_FOUND'
    || error.code === 'EXECUTION_NOT_FOUND'
    || error.code === 'SCHEDULE_NOT_FOUND'
    || error.code === 'SCHEDULE_RUN_NOT_FOUND'
    || error.code === 'SCHEDULE_LOG_NOT_FOUND'
    || error.code === 'RUN_NOT_FOUND'
    || error.code === 'RUNTIME_NOT_FOUND'
  ) return 404
  if (
    error.code === 'TASK_VERSION_CONFLICT'
    || error.code === 'TASK_TREE_VERSION_CONFLICT'
    || error.code === 'CHILD_TASKS_INCOMPLETE'
    || error.code === 'EXECUTION_ASSIGNMENT_CONFLICT'
    || error.code === 'EXECUTION_CLASSIFICATION_CONFLICT'
    || error.code === 'EXECUTION_BATCH_CONFLICT'
    || error.code === 'OBSERVATION_IDENTITY_CONFLICT'
    || error.code === 'TASK_STRUCTURE_CONFLICT'
    || error.code === 'EXECUTION_INTENT_CONFLICT'
    || error.code === 'PROJECT_VERSION_CONFLICT'
    || error.code === 'SOURCE_SESSION_PROJECT_CONFLICT'
    || error.code === 'TASK_NOT_RESUMABLE'
    || error.code === 'CODEX_SESSION_NOT_FOUND'
    || error.code === 'SESSION_SOURCE_UNSUPPORTED'
    || error.code === 'TERMINAL_UNAVAILABLE'
    || error.code === 'TERMINAL_LAUNCH_FAILED'
    || error.code === 'CODEX_UNAVAILABLE'
    || error.code === 'CODEX_MODEL_UNAVAILABLE'
    || error.code === 'CODEX_REASONING_UNSUPPORTED'
    || error.code === 'WORKSPACE_INVALID'
    || error.code === 'WORKSPACE_NOT_FOUND'
    || error.code === 'SCHEDULE_VERSION_CONFLICT'
    || error.code === 'SCHEDULE_IDEMPOTENCY_CONFLICT'
    || error.code === 'SCHEDULE_RUN_ACTIVE'
    || error.code === 'SCHEDULE_RUN_NOT_REVIEWABLE'
    || error.code === 'SCHEDULE_DELETED'
    || error.code === 'SCHEDULE_NOT_CLAIMABLE'
    || error.code === 'RUN_ALREADY_ACTIVE'
    || error.code === 'RUN_IDEMPOTENCY_CONFLICT'
    || error.code === 'RUN_STATE_CONFLICT'
    || error.code === 'RUN_NOT_ACTIVE'
    || error.code === 'TURN_CHANGED'
    || error.code === 'TURN_NOT_STEERABLE'
    || error.code === 'RUNTIME_NOT_INTERACTIVE'
    || error.code === 'RUNTIME_CONVERSATION_UNAVAILABLE'
    || error.code === 'RUNTIME_CONVERSATION_UNSUPPORTED'
  ) return 409
  if (typeof error.code === 'string' && (
    error.code.startsWith('SCHEDULE_')
    || error.code.startsWith('SCHEDULER_')
    || error.code.startsWith('RUN_')
    || error.code.startsWith('RUNTIME_')
  )) return 400
  if (error instanceof TaskRecorderError) return 400
  return 500
}

function sendApiError(response, error) {
  const statusCode = statusFor(error)
  const known = statusCode < 500 || PUBLIC_SERVICE_ERRORS.has(error.code)
  sendJson(response, statusCode, {
    ok: false,
    error: {
      code: known ? error.code : 'INTERNAL_ERROR',
      message: known ? error.message : 'internal server error',
      ...(known && error.details !== undefined ? { details: error.details } : {}),
    },
  })
}

function requireJson(request) {
  const contentType = request.headers['content-type'] ?? ''
  if (!contentType.toLowerCase().startsWith('application/json')) {
    throw httpError('CONTENT_TYPE_REQUIRED', 'content-type must be application/json', 415)
  }
}

function exactBody(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw httpError('SCHEDULE_INPUT_INVALID', `${label} body must be an object`, 400)
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw httpError('SCHEDULE_INPUT_INVALID', `unsupported ${label} field: ${key}`, 400)
    }
  }
  return value
}

function safeSegment(value) {
  try {
    return decodeURIComponent(value)
  } catch {
    throw httpError('SCHEDULE_INPUT_INVALID', 'route ID is not valid percent-encoded text', 400)
  }
}

function scheduleCapability(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.supported !== 'boolean') {
    throw httpError('SCHEDULER_CAPABILITY_INVALID', 'Scheduler capability is unavailable', 503)
  }
  return value
}

function scheduleJob(row, { detail = false, runSummary = null } = {}) {
  if (!row || typeof row !== 'object') return row
  const cadence = typeof row.cadence_json === 'string' ? JSON.parse(row.cadence_json) : row.cadence
  return {
    id: row.id,
    title: row.title,
    ...(detail ? { prompt: row.prompt } : {}),
    workspace: row.workspace,
    agent: row.agent ?? 'codex',
    cadence,
    timezone_mode: row.timezone_mode,
    thread_mode: row.thread_mode,
    sandbox_mode: row.sandbox_mode,
    model: row.model,
    reasoning_effort: row.reasoning_effort,
    timeout_seconds: row.timeout_seconds,
    capabilities: row.capabilities ?? { skills: 'inherit', integrations: 'inherit' },
    enabled: row.enabled === true || row.enabled === 1,
    etag: row.etag,
    source_path: row.source_path,
    schedule_generation: row.schedule_generation,
    sync_state: row.sync_state,
    sync_error_code: row.sync_error_code ?? null,
    next_run_at: row.next_run_at ?? null,
    last_run_at: row.last_run_at ?? null,
    ...(runSummary === null ? {} : {
      unread_run_count: runSummary.unread_run_count,
      last_run: runSummary.last_run,
      current_execution: runSummary.current_execution ?? null,
    }),
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

function scheduleRunSummaries(runs = []) {
  const terminal = new Set(['succeeded', 'failed', 'timed_out', 'skipped_overlap', 'canceled', 'lost', 'interrupted'])
  const summaries = new Map()
  for (const run of runs) {
    const scheduleId = run?.schedule_id ?? run?.job_id
    if (typeof scheduleId !== 'string') continue
    const current = summaries.get(scheduleId) ?? { unread_run_count: 0, last_run: null, last_run_time: Number.NEGATIVE_INFINITY }
    if (terminal.has(run.status) && run.reviewed_at === null) current.unread_run_count += 1
    const candidateTime = Date.parse(run.finished_at ?? run.started_at ?? run.created_at ?? '')
    if (current.last_run === null || (Number.isFinite(candidateTime) && candidateTime > current.last_run_time)) {
      current.last_run = {
        id: run.id,
        status: run.status,
        finished_at: run.finished_at ?? null,
        reviewed_at: run.reviewed_at ?? null,
      }
      current.last_run_time = Number.isFinite(candidateTime) ? candidateTime : current.last_run_time
    }
    summaries.set(scheduleId, current)
  }
  return summaries
}

const DISPATCH_CLAIM_TIMEOUT_MS = 60_000

function scheduleDispatch(row, observedAt = new Date()) {
  if (!row || typeof row !== 'object') return row
  const attemptAt = row.last_attempted_at ?? row.requested_at
  const attemptTime = Date.parse(attemptAt)
  const observedTime = new Date(observedAt).getTime()
  const claimDeadlineTime = Number.isFinite(attemptTime) ? attemptTime + DISPATCH_CLAIM_TIMEOUT_MS : NaN
  const hasDispatchError = typeof row.last_error_code === 'string' && row.last_error_code !== ''
  const stalled = !hasDispatchError && Number.isFinite(observedTime) && Number.isFinite(claimDeadlineTime) && observedTime >= claimDeadlineTime
  return {
    kind: 'dispatch',
    id: row.id,
    job_id: row.job_id,
    trigger: row.trigger,
    status: hasDispatchError ? 'dispatch_failed' : (stalled ? 'dispatch_stalled' : 'queued'),
    requested_at: row.requested_at,
    last_attempted_at: row.last_attempted_at ?? null,
    ...(!hasDispatchError && Number.isFinite(claimDeadlineTime) ? { claim_deadline_at: new Date(claimDeadlineTime).toISOString() } : {}),
    error_code: row.last_error_code ?? (stalled ? 'RUNNER_CLAIM_TIMEOUT' : null),
    attempt_count: Number.isSafeInteger(row.attempt_count) ? row.attempt_count : 0,
  }
}

function runExecutionSummary(run) {
  let outputCount = 0
  if (Array.isArray(run.file_changes)) outputCount = run.file_changes.length
  else try { const parsed = JSON.parse(run.file_changes_json ?? '[]'); outputCount = Array.isArray(parsed) ? parsed.length : 0 } catch {}
  return {
    kind: 'run',
    id: run.id,
    status: run.status,
    started_at: run.started_at ?? null,
    finished_at: run.finished_at ?? null,
    error_code: run.error_code ?? null,
    output_count: outputCount,
  }
}

function scheduleExecutionSummaries(runs = [], dispatches = [], observedAt = new Date()) {
  const summaries = scheduleRunSummaries(runs)
  for (const run of runs) {
    const scheduleId = run?.schedule_id ?? run?.job_id
    if (typeof scheduleId !== 'string' || !['queued', 'claimed', 'running'].includes(run.status)) continue
    const current = summaries.get(scheduleId) ?? { unread_run_count: 0, last_run: null }
    current.current_execution = runExecutionSummary(run)
    summaries.set(scheduleId, current)
  }
  for (const dispatch of dispatches) {
    if (!dispatch || dispatch.state !== 'pending' || typeof dispatch.job_id !== 'string') continue
    const current = summaries.get(dispatch.job_id) ?? { unread_run_count: 0, last_run: null }
    if (!current.current_execution) {
      const { job_id: _jobId, ...execution } = scheduleDispatch(dispatch, observedAt)
      current.current_execution = execution
    }
    summaries.set(dispatch.job_id, current)
  }
  for (const current of summaries.values()) {
    if (current.current_execution || !current.last_run) continue
    const latest = runs.find(({ id }) => id === current.last_run.id)
    if (latest) current.current_execution = runExecutionSummary(latest)
  }
  return summaries
}

function scheduleMutationResult(result, { detail = true } = {}) {
  if (!result || typeof result !== 'object' || !result.job) return result
  return { ...result, job: scheduleJob(result.job, { detail }) }
}

function reconcileState(row) {
  return JSON.stringify([
    row?.etag ?? null,
    row?.sync_state ?? null,
    row?.sync_error_code ?? null,
    row?.next_run_at ?? null,
  ])
}

function boundedSchedulerErrorCode(value, fallback = 'SCHEDULER_RECONCILE_FAILED') {
  return typeof value === 'string' && /^[A-Z][A-Z0-9_]{1,95}$/.test(value) ? value : fallback
}

function reconcileJobResult(id, result) {
  const reconciled = result?.reconciled === true
  return {
    id,
    reconciled,
    error_code: reconciled ? null : boundedSchedulerErrorCode(result?.error_code ?? result?.job?.sync_error_code),
  }
}

function scheduledRun(row) {
  if (!row || typeof row !== 'object') return row
  let fileChanges = Array.isArray(row.file_changes) ? row.file_changes : []
  if (!Array.isArray(row.file_changes)) {
    try { const parsed = JSON.parse(row.file_changes_json ?? '[]'); if (Array.isArray(parsed)) fileChanges = parsed }
    catch {}
  }
  return {
    id: row.id,
    job_id: row.schedule_id ?? row.job_id,
    definition_etag: row.definition_etag,
    runtime_id: row.runtime_id ?? 'codex',
    interactive: row.interactive === true,
    turn_revision: Number.isSafeInteger(row.turn_revision) ? row.turn_revision : null,
    trigger: row.origin ?? row.trigger,
    status: row.status,
    thread_id: row.session_id ?? row.thread_id ?? null,
    scheduled_for: row.scheduled_for ?? null,
    claimed_at: row.created_at ?? row.claimed_at ?? null,
    started_at: row.started_at ?? null,
    heartbeat_at: row.heartbeat_at ?? null,
    finished_at: row.finished_at ?? null,
    exit_code: row.exit_code ?? null,
    error_code: row.error_code ?? null,
    final_message: row.final_message ?? null,
    file_changes: fileChanges,
    has_stdout_log: typeof row.stdout_log_path === 'string' && row.stdout_log_path !== '',
    has_stderr_log: typeof row.stderr_log_path === 'string' && row.stderr_log_path !== '',
    reviewed_at: row.reviewed_at ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

function parseLogTail(url) {
  const stream = url.searchParams.get('stream')
  const rawTail = url.searchParams.get('tail')
  const tail = rawTail === null ? 16 * 1024 : Number(rawTail)
  if (!['stdout', 'stderr'].includes(stream) || !Number.isSafeInteger(tail) || tail < 1 || tail > SCHEDULE_LOG_TAIL_MAX) {
    throw httpError('SCHEDULE_LOG_QUERY_INVALID', `stream and tail (1-${SCHEDULE_LOG_TAIL_MAX}) are required`, 400)
  }
  return { stream, tail }
}

function parseEventSequence(request, url) {
  const raw = url.searchParams.get('after') ?? request.headers['last-event-id'] ?? '0'
  if (!/^\d{1,15}$/.test(raw)) {
    throw httpError('RUN_EVENT_SEQUENCE_INVALID', 'Run event sequence is invalid', 400)
  }
  const sequence = Number(raw)
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw httpError('RUN_EVENT_SEQUENCE_INVALID', 'Run event sequence is invalid', 400)
  }
  return sequence
}

function validateRunControl(action, value) {
  const allowed = action === 'steer'
    ? new Set(['expected_turn_revision', 'text'])
    : new Set(['expected_turn_revision'])
  const input = exactBody(value, allowed, `Run ${action}`)
  if (!Number.isSafeInteger(input.expected_turn_revision) || input.expected_turn_revision < 1) {
    throw httpError('INTERVENTION_INVALID', 'expected_turn_revision must be a positive integer', 400)
  }
  if (action === 'steer') {
    if (typeof input.text !== 'string' || input.text.trim() === ''
      || input.text.includes('\0')
      || Buffer.byteLength(input.text) > RUN_INTERVENTION_TEXT_LIMIT) {
      throw httpError('INTERVENTION_INVALID', 'intervention text is invalid', 400)
    }
  }
  return input
}

export function createApiServer({
  service,
  journalService = null,
  journalDiagnostics = null,
  store,
  hub,
  host = '127.0.0.1',
  port,
  dashboardHtml,
  dashboardSettings = null,
  sessionResume = null,
  schedulerService = null,
  scheduledRunLogs = null,
  runtimeRegistry = null,
  runService = null,
  packageVersion = 'unknown',
  apiVersion = 4,
  schedulerClock = null,
  clock = () => new Date(),
}) {
  let expectedHost = `${host}:${port}`
  let origin = `http://${expectedHost}`

  const server = createServer(async (request, response) => {
    try {
      if (request.headers.host !== expectedHost) {
        throw httpError('HOST_REJECTED', 'request host is not allowed', 403)
      }
      if (request.headers.origin && request.headers.origin !== origin) {
        throw httpError('ORIGIN_REJECTED', 'request origin is not allowed', 403)
      }

      const url = new URL(request.url, origin)
      const { pathname } = url

      if (request.method === 'GET' && pathname === '/') {
        response.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Length': Buffer.byteLength(dashboardHtml),
          'Cache-Control': 'no-cache',
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self' data:; frame-ancestors 'none'",
        })
        response.end(dashboardHtml)
        return
      }
      if (request.method === 'GET' && pathname === '/favicon.ico') {
        response.writeHead(204, { 'Cache-Control': 'public, max-age=86400' })
        response.end()
        return
      }
      if (request.method === 'GET' && pathname === '/health/live') {
        sendJson(response, 200, { ok: true, service: 'tasks-recorder' })
        return
      }
      if (request.method === 'GET' && pathname === '/health/ready') {
        const check = store.check()
        const ready = check.integrityCheck === 'ok'
          && check.foreignKeyViolations.length === 0
          && (check.invariantViolations?.length ?? 0) === 0
        sendJson(response, ready ? 200 : 503, { ok: ready, ready, service: 'tasks-recorder', check })
        return
      }
      if (request.method === 'GET' && pathname === '/api/v1/meta') {
        sendJson(response, 200, {
          service: 'tasks-recorder',
          service_version: packageVersion,
          api_version: apiVersion,
          capabilities: {
            runtime_registry: runtimeRegistry !== null,
            unified_runs: runService !== null,
            internal_scheduler: schedulerClock !== null,
          },
        })
        return
      }
      if (request.method === 'GET' && pathname === '/api/v1/runtimes' && runtimeRegistry) {
        sendJson(response, 200, { runtimes: await runtimeRegistry.list() })
        return
      }
      if (request.method === 'POST' && pathname === '/api/v1/runtimes/refresh' && runtimeRegistry) {
        requireJson(request)
        exactBody(await readJson(request), new Set(), 'Runtime refresh')
        runtimeRegistry.refresh()
        sendJson(response, 200, { runtimes: await runtimeRegistry.list() })
        return
      }
      const runtimeModels = pathname.match(/^\/api\/v1\/runtimes\/([^/]+)\/models$/)
      if (request.method === 'GET' && runtimeModels && runtimeRegistry) {
        const runtimeId = safeSegment(runtimeModels[1])
        runtimeRegistry.get(runtimeId)
        const result = await runtimeRegistry.models(runtimeId)
        if (result.source === 'unavailable') {
          throw httpError(
            'MODEL_CATALOG_UNAVAILABLE',
            'Runtime model catalog is unavailable',
            503,
          )
        }
        sendJson(response, 200, result)
        return
      }
      if (request.method === 'GET' && pathname === '/api/v1/runs' && runService) {
        const query = {}
        const scheduleId = url.searchParams.get('schedule_id')
        const status = url.searchParams.get('status')
        if (scheduleId !== null) query.schedule_id = scheduleId
        if (status !== null) query.status = status
        sendJson(response, 200, { runs: runService.list(query) })
        return
      }
      if (request.method === 'POST' && pathname === '/api/v1/runs' && runService) {
        requireJson(request)
        const input = exactBody(await readJson(request), new Set([
          'schedule_id', 'origin', 'idempotency_key',
        ]), 'Run')
        if (input.origin !== 'manual') {
          throw httpError('RUN_INPUT_INVALID', 'browser Runs must use manual origin', 400)
        }
        const loaded = await schedulerService?.getJob(safeSegment(input.schedule_id))
        if (!loaded?.job) {
          throw httpError('SCHEDULE_NOT_FOUND', 'Schedule does not exist', 404)
        }
        const result = await runService.create({
          schedule: loaded.job,
          origin: 'manual',
          occurrence_key: null,
          scheduled_for: null,
          idempotency_key: input.idempotency_key ?? null,
        })
        sendJson(response, 202, result)
        return
      }
      const runControl = pathname.match(/^\/api\/v1\/runs\/([^/]+)\/(steer|stop)$/)
      if (request.method === 'POST' && runControl && runService) {
        requireJson(request)
        const runId = safeSegment(runControl[1])
        const input = validateRunControl(
          runControl[2],
          await readJson(request, { limit: RUN_INTERVENTION_BODY_LIMIT }),
        )
        const result = runControl[2] === 'steer'
          ? await runService.steer(runId, input)
          : await runService.stop(runId, input)
        sendJson(response, 202, result)
        return
      }
      const runAction = pathname.match(/^\/api\/v1\/runs\/([^/]+)\/(cancel|review|resume)$/)
      if (request.method === 'POST' && runAction && runService) {
        requireJson(request)
        exactBody(await readJson(request), new Set(), `Run ${runAction[2]}`)
        const runId = safeSegment(runAction[1])
        if (runAction[2] === 'cancel') {
          sendJson(response, 200, { run: runService.cancel(runId) })
          return
        }
        if (runAction[2] === 'review') {
          sendJson(response, 200, { run: runService.markReviewed(runId) })
          return
        }
        const resumed = await sessionResume?.resumeScheduledRun(runId)
        if (!resumed) {
          throw httpError('SCHEDULE_RESUME_UNAVAILABLE', 'Run resume is unavailable', 503)
        }
        sendJson(response, 200, resumed)
        return
      }
      const runEvents = pathname.match(/^\/api\/v1\/runs\/([^/]+)\/events$/)
      if (request.method === 'GET' && runEvents && runService) {
        const runId = safeSegment(runEvents[1])
        runService.get(runId)
        const afterSequence = parseEventSequence(request, url)
        response.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Content-Type-Options': 'nosniff',
        })
        response.flushHeaders?.()
        if (runService.eventReplay?.(runId, afterSequence)?.reset_required === true) {
          response.write(`event: reset\ndata: ${JSON.stringify({ run_id: runId })}\n\n`)
        }
        let first = true
        const unsubscribe = runService.events(runId, (event) => {
          if (first && !runService.eventReplay && event.sequence > afterSequence + 1) {
            response.write(`event: reset\ndata: ${JSON.stringify({ run_id: runId })}\n\n`)
          }
          first = false
          response.write(
            `id: ${event.sequence}\nevent: run\ndata: ${JSON.stringify(event)}\n\n`,
          )
        }, { afterSequence })
        request.once('close', unsubscribe)
        return
      }
      const runConversation = pathname.match(/^\/api\/v1\/runs\/([^/]+)\/conversation$/)
      if (request.method === 'GET' && runConversation && runService?.conversation) {
        const runId = safeSegment(runConversation[1])
        sendJson(response, 200, await runService.conversation(runId))
        return
      }
      const runLog = pathname.match(/^\/api\/v1\/runs\/([^/]+)\/log$/)
      if (request.method === 'GET' && runLog && runService && scheduledRunLogs) {
        const runId = safeSegment(runLog[1])
        runService.get(runId)
        sendJson(response, 200, await scheduledRunLogs.read({
          runId,
          ...parseLogTail(url),
        }))
        return
      }
      const runDetail = pathname.match(/^\/api\/v1\/runs\/([^/]+)$/)
      if (request.method === 'GET' && runDetail && runService) {
        sendJson(response, 200, { run: runService.get(safeSegment(runDetail[1])) })
        return
      }
      if (request.method === 'GET' && pathname === '/api/v1/snapshot') {
        sendJson(response, 200, { ...hub.current(), ...await service.dashboardSnapshot() })
        return
      }
      if (request.method === 'GET' && pathname === '/api/v1/settings' && dashboardSettings) {
        sendJson(response, 200, await dashboardSettings.get())
        return
      }
      if (request.method === 'PATCH' && pathname === '/api/v1/settings' && dashboardSettings) {
        requireJson(request)
        sendJson(response, 200, await dashboardSettings.update(await readJson(request)))
        return
      }
      if (request.method === 'GET' && pathname === '/api/v1/events') {
        hub.subscribe(request, response)
        return
      }
      if (request.method === 'GET' && pathname === '/api/v1/status' && journalDiagnostics) {
        const status = await journalDiagnostics.status()
        sendJson(response, status.ready ? 200 : 503, status)
        return
      }
      if (request.method === 'POST' && pathname === '/api/v1/scheduler/reconcile' && schedulerService) {
        requireJson(request)
        exactBody(await readJson(request), new Set(), 'Scheduler reconcile')
        const listed = await schedulerService.listJobs()
        if (!Array.isArray(listed?.jobs)) {
          throw httpError('SCHEDULER_RECONCILE_UNAVAILABLE', 'Scheduler reconcile is unavailable', 503)
        }
        const jobs = []
        if (typeof schedulerService.retrySync !== 'function') {
          sendJson(response, 200, {
            jobs: listed.jobs.map(({ id }) => ({ id, reconciled: true, error_code: null })),
          })
          return
        }
        let changed = false
        for (const job of listed.jobs) {
          const id = typeof job?.id === 'string' ? job.id : null
          if (!id) {
            throw httpError('SCHEDULER_RECONCILE_UNAVAILABLE', 'Scheduler reconcile is unavailable', 503)
          }
          const before = reconcileState(job)
          try {
            const result = await schedulerService.retrySync(id)
            changed ||= before !== reconcileState(result?.job ?? job)
            jobs.push(reconcileJobResult(id, result))
          } catch (error) {
            jobs.push({
              id,
              reconciled: false,
              error_code: boundedSchedulerErrorCode(error?.code),
            })
          }
        }
        if (changed) hub.publish()
        sendJson(response, 200, { jobs })
        return
      }
      if (request.method === 'GET' && pathname === '/api/v1/schedules' && schedulerService) {
        const { jobs, invalid = [] } = await schedulerService.listJobs()
        const runs = runService
          ? runService.list({ limit: 1_000 })
          : (await schedulerService.listRuns()).runs
        const dispatches = runService
          ? []
          : (await schedulerService.listDispatches()).dispatches
        const capability = runService
          ? { backend: 'taskd-clock', supported: true }
          : await schedulerService.capability()
        const runSummaries = scheduleExecutionSummaries(runs, dispatches, clock())
        sendJson(response, 200, {
          capability: scheduleCapability(capability),
          jobs: jobs.map((value) => scheduleJob(value, {
            runSummary: runSummaries.get(value.id) ?? { unread_run_count: 0, last_run: null },
          })),
          invalid,
        })
        return
      }
      if (request.method === 'POST' && pathname === '/api/v1/schedules' && schedulerService) {
        requireJson(request)
        const input = exactBody(await readJson(request), new Set([
          'title', 'prompt', 'workspace', 'agent', 'cadence', 'sandbox_mode', 'model',
          'reasoning_effort', 'timeout_seconds', 'capabilities',
        ]), 'Schedule')
        const result = scheduleMutationResult(await schedulerService.createJob(input))
        hub.publish()
        sendJson(response, 200, result)
        return
      }
      const scheduleRuns = pathname.match(/^\/api\/v1\/schedules\/([^/]+)\/runs$/)
      if (request.method === 'GET' && scheduleRuns && schedulerService) {
        const id = safeSegment(scheduleRuns[1])
        const result = runService
          ? { runs: runService.list({ schedule_id: id, limit: 1_000 }) }
          : await schedulerService.listRuns(id)
        const pending = runService
          ? { dispatches: [] }
          : await schedulerService.listDispatches(id)
        const observedAt = clock()
        sendJson(response, 200, {
          runs: result.runs.map(scheduledRun),
          dispatches: pending.dispatches
            .filter(({ state }) => state === 'pending')
            .map((dispatch) => scheduleDispatch(dispatch, observedAt)),
        })
        return
      }
      const scheduleAction = pathname.match(/^\/api\/v1\/schedules\/([^/]+)\/(pause|resume|run)$/)
      if (request.method === 'POST' && scheduleAction && schedulerService) {
        requireJson(request)
        const id = safeSegment(scheduleAction[1])
        const action = scheduleAction[2]
        const allowed = action === 'run' ? new Set(['idempotency_key']) : new Set(['expected_etag'])
        const input = exactBody(await readJson(request), allowed, `Schedule ${action}`)
        let result
        if (action === 'run' && runService) {
          const { job } = await schedulerService.getJob(id)
          result = await runService.create({
            schedule: job,
            origin: 'manual',
            occurrence_key: null,
            scheduled_for: null,
            idempotency_key: input.idempotency_key ?? null,
          })
        } else {
          result = action === 'run'
            ? await schedulerService.runNow(id, input)
            : scheduleMutationResult(await schedulerService[`${action}Job`](id, input.expected_etag))
        }
        if (action !== 'run' || result.reused !== true || result.dispatch_state === 'pending') hub.publish()
        sendJson(response, 200, result)
        return
      }
      const schedule = pathname.match(/^\/api\/v1\/schedules\/([^/]+)$/)
      if (request.method === 'GET' && schedule && schedulerService) {
        const result = await schedulerService.getJob(safeSegment(schedule[1]))
        sendJson(response, 200, { job: scheduleJob(result.job, { detail: true }) })
        return
      }
      if (request.method === 'PATCH' && schedule && schedulerService) {
        requireJson(request)
        const input = exactBody(await readJson(request), new Set(['expected_etag', 'patch']), 'Schedule update')
        const result = scheduleMutationResult(await schedulerService.updateJob(
          safeSegment(schedule[1]), input.expected_etag, input.patch,
        ))
        hub.publish()
        sendJson(response, 200, result)
        return
      }
      if (request.method === 'DELETE' && schedule && schedulerService) {
        requireJson(request)
        const input = exactBody(await readJson(request), new Set(['expected_etag']), 'Schedule delete')
        const result = scheduleMutationResult(await schedulerService.deleteJob(
          safeSegment(schedule[1]), input.expected_etag,
        ))
        hub.publish()
        sendJson(response, 200, result)
        return
      }
      const scheduledRunLog = pathname.match(/^\/api\/v1\/scheduled-runs\/([^/]+)\/log$/)
      if (request.method === 'GET' && scheduledRunLog && schedulerService && scheduledRunLogs) {
        const runId = safeSegment(scheduledRunLog[1])
        if (runService) runService.get(runId)
        else await schedulerService.getRun(runId)
        sendJson(response, 200, await scheduledRunLogs.read({ runId, ...parseLogTail(url) }))
        return
      }
      const scheduledRunAction = pathname.match(/^\/api\/v1\/scheduled-runs\/([^/]+)\/(review|resume)$/)
      if (request.method === 'POST' && scheduledRunAction && schedulerService) {
        requireJson(request)
        exactBody(await readJson(request), new Set(), `Scheduled Run ${scheduledRunAction[2]}`)
        const runId = safeSegment(scheduledRunAction[1])
        const reviewed = scheduledRunAction[2] === 'review'
          ? (runService
            ? { run: runService.markReviewed(runId), changed: true }
            : await schedulerService.markReviewed(runId))
          : null
        const result = reviewed
          ? { run: scheduledRun(reviewed.run) }
          : await sessionResume?.resumeScheduledRun(runId)
        if (reviewed?.changed === true) hub.publish()
        if (!result) throw httpError('SCHEDULE_RESUME_UNAVAILABLE', 'Scheduled Run resume is unavailable', 503)
        sendJson(response, 200, result)
        return
      }
      const scheduledRunDetail = pathname.match(/^\/api\/v1\/scheduled-runs\/([^/]+)$/)
      if (request.method === 'GET' && scheduledRunDetail && schedulerService) {
        const result = runService
          ? { run: runService.get(safeSegment(scheduledRunDetail[1])) }
          : await schedulerService.getRun(safeSegment(scheduledRunDetail[1]))
        sendJson(response, 200, { run: scheduledRun(result.run) })
        return
      }
      if (request.method === 'POST' && pathname === '/api/v1/events' && journalService) {
        requireJson(request)
        sendJson(response, 200, await journalService.ingestEvent(await readJson(request)))
        return
      }
      if (request.method === 'POST' && pathname === '/api/v1/work/context' && journalService) {
        requireJson(request)
        sendJson(response, 200, await journalService.workContext(await readJson(request)))
        return
      }
      if (request.method === 'POST' && pathname === '/api/v1/work/focus' && journalService) {
        requireJson(request)
        sendJson(response, 200, await journalService.focus(await readJson(request)))
        return
      }
      if (request.method === 'POST' && pathname === '/api/v1/work/intents' && journalService) {
        requireJson(request)
        sendJson(response, 200, await journalService.registerIntent(await readJson(request)))
        return
      }
      if (request.method === 'POST' && pathname === '/api/v1/work/checkpoint' && journalService) {
        requireJson(request)
        sendJson(response, 200, await journalService.checkpoint(await readJson(request)))
        return
      }
      const sourceSessionProject = pathname.match(
        /^\/api\/v1\/source-sessions\/([^/]+)\/project$/,
      )
      if (request.method === 'PATCH' && sourceSessionProject && journalService) {
        requireJson(request)
        sendJson(response, 200, await journalService.assignSourceSessionProject({
          ...await readJson(request),
          source_session_id: decodeURIComponent(sourceSessionProject[1]),
        }))
        return
      }
      if (request.method === 'POST' && pathname === '/api/v1/tasks/mutate' && journalService) {
        requireJson(request)
        sendJson(response, 200, await journalService.mutateTask(await readJson(request)))
        return
      }
      if (
        request.method === 'POST'
        && pathname === '/api/v1/tasks/sync-structure'
        && journalService
      ) {
        requireJson(request)
        sendJson(response, 200, await journalService.syncStructure(await readJson(request)))
        return
      }

      if (request.method === 'POST' && pathname === '/api/v1/context') {
        requireJson(request)
        sendJson(response, 200, await service.context(await readJson(request)))
        return
      }
      if (request.method === 'POST' && pathname === '/api/v1/tasks/sync-tree') {
        requireJson(request)
        sendJson(response, 200, await service.syncTree(await readJson(request)))
        return
      }
      if (request.method === 'POST' && pathname === '/api/v1/import/executions') {
        requireJson(request)
        sendJson(response, 200, await service.importExecutions(await readJson(request, {
          limit: IMPORT_BODY_LIMIT,
        })))
        return
      }
      const lifecycleOperations = {
        '/api/v1/lifecycle/session-start': 'sessionStart',
        '/api/v1/lifecycle/turn-start': 'turnStart',
        '/api/v1/lifecycle/tool-use': 'toolUse',
        '/api/v1/lifecycle/subagent-start': 'subagentStart',
        '/api/v1/lifecycle/subagent-stop': 'subagentStop',
        '/api/v1/lifecycle/session-end': 'sessionEnd',
      }
      if (request.method === 'POST' && lifecycleOperations[pathname]) {
        requireJson(request)
        sendJson(response, 200, await service[lifecycleOperations[pathname]](await readJson(request)))
        return
      }
      const sessionContext = pathname.match(/^\/api\/v1\/sessions\/([^/]+)\/context$/)
      if (request.method === 'GET' && sessionContext) {
        sendJson(response, 200, await service.sessionContext(decodeURIComponent(sessionContext[1])))
        return
      }
      if (request.method === 'GET' && pathname === '/api/v1/executions') {
        const filters = Object.fromEntries(
          ['task_id', 'root_session_id', 'session_id', 'status', 'unassigned']
            .map((key) => [key, url.searchParams.get(key)])
            .filter(([, value]) => value !== null),
        )
        sendJson(response, 200, { executions: await service.listExecutions(filters) })
        return
      }
      if (request.method === 'GET' && pathname === '/api/v1/tasks') {
        const filters = Object.fromEntries(
          ['project', 'status', 'workfolder', 'branch']
            .map((key) => [key, url.searchParams.get(key)])
            .filter(([, value]) => value !== null),
        )
        sendJson(response, 200, { tasks: await service.list(filters) })
        return
      }
      if (request.method === 'POST' && pathname === '/api/v1/heartbeat') {
        requireJson(request)
        sendJson(response, 200, await service.heartbeat(await readJson(request)))
        return
      }
      if (request.method === 'POST' && pathname === '/api/v1/render') {
        sendJson(response, 200, await service.render())
        return
      }
      if (request.method === 'GET' && pathname === '/api/v1/check') {
        sendJson(response, 200, await service.check())
        return
      }

      const complete = pathname.match(/^\/api\/v1\/tasks\/([^/]+)\/complete$/)
      if (request.method === 'POST' && complete) {
        requireJson(request)
        const input = await readJson(request)
        sendJson(response, 200, await service.complete({ ...input, id: decodeURIComponent(complete[1]) }))
        return
      }
      const taskResume = pathname.match(/^\/api\/v1\/tasks\/([^/]+)\/resume$/)
      if (request.method === 'POST' && taskResume && sessionResume) {
        requireJson(request)
        await readJson(request)
        sendJson(response, 200, await sessionResume.resumeTask(decodeURIComponent(taskResume[1])))
        return
      }
      const taskEvents = pathname.match(/^\/api\/v1\/tasks\/([^/]+)\/events$/)
      if (request.method === 'GET' && taskEvents) {
        sendJson(response, 200, {
          events: await service.taskEvents({ task_id: decodeURIComponent(taskEvents[1]) }),
        })
        return
      }
      const taskLifecycle = pathname.match(/^\/api\/v1\/tasks\/([^/]+)\/(archive|delete|restore)$/)
      if (request.method === 'POST' && taskLifecycle) {
        requireJson(request)
        const operation = {
          archive: 'archiveTask',
          delete: 'deleteTask',
          restore: 'restoreTask',
        }[taskLifecycle[2]]
        sendJson(response, 200, await service[operation]({
          ...await readJson(request),
          id: decodeURIComponent(taskLifecycle[1]),
        }))
        return
      }
      const executionTask = pathname.match(/^\/api\/v1\/executions\/([^/]+)\/task$/)
      const segmentAttribution = pathname.match(/^\/api\/v1\/segments\/([^/]+)\/attribution$/)
      if (request.method === 'PATCH' && segmentAttribution && journalService) {
        requireJson(request)
        sendJson(response, 200, await journalService.correctAttribution({
          ...await readJson(request),
          segment_id: decodeURIComponent(segmentAttribution[1]),
        }))
        return
      }
      if (request.method === 'PATCH' && pathname === '/api/v1/executions/tasks') {
        requireJson(request)
        sendJson(response, 200, await service.updateExecutionAssignments(await readJson(request)))
        return
      }
      if (request.method === 'PATCH' && executionTask) {
        requireJson(request)
        sendJson(response, 200, await service.assignExecution({
          ...await readJson(request),
          id: decodeURIComponent(executionTask[1]),
        }))
        return
      }
      const executionClassification = pathname.match(
        /^\/api\/v1\/executions\/([^/]+)\/classification$/,
      )
      if (request.method === 'PATCH' && executionClassification) {
        requireJson(request)
        sendJson(response, 200, await service.classifyExecution({
          ...await readJson(request),
          id: decodeURIComponent(executionClassification[1]),
        }))
        return
      }
      const taskStatus = pathname.match(/^\/api\/v1\/tasks\/([^/]+)\/status$/)
      if (request.method === 'PATCH' && taskStatus) {
        requireJson(request)
        const input = await readJson(request)
        sendJson(response, 200, await service.updateStatus({
          ...input,
          id: decodeURIComponent(taskStatus[1]),
        }))
        return
      }
      const task = pathname.match(/^\/api\/v1\/tasks\/([^/]+)$/)
      if (request.method === 'GET' && task) {
        sendJson(response, 200, await service.show(decodeURIComponent(task[1])))
        return
      }
      if (request.method === 'PATCH' && task) {
        requireJson(request)
        sendJson(response, 200, await service.updateTask({
          ...await readJson(request),
          id: decodeURIComponent(task[1]),
        }))
        return
      }
      if (request.method === 'PUT' && task) {
        requireJson(request)
        const input = await readJson(request)
        sendJson(response, 200, await service.upsert({ ...input, id: decodeURIComponent(task[1]) }))
        return
      }

      throw httpError('ROUTE_NOT_FOUND', 'route not found', 404)
    } catch (error) {
      if (!response.headersSent) sendApiError(response, error)
      else response.destroy(error)
    }
  })

  return {
    async listen() {
      await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, host, resolve)
      })
      const address = server.address()
      expectedHost = `${host}:${address.port}`
      origin = `http://${expectedHost}`
      return { host, port: address.port, url: origin }
    },
    async close() {
      server.closeIdleConnections?.()
      if (!server.listening) return
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    },
  }
}
