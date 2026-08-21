import { createServer } from 'node:http'

import { TaskRecorderError } from '../../mcp/src/errors.mjs'
import { readJson, sendJson } from './http-utils.mjs'

const IMPORT_BODY_LIMIT = 8 * 1024 * 1024

function httpError(code, message, statusCode) {
  const error = new Error(message)
  error.code = code
  error.statusCode = statusCode
  return error
}

function statusFor(error) {
  if (error.statusCode) return error.statusCode
  if (
    error.code === 'TASK_NOT_FOUND'
    || error.code === 'PARENT_NOT_FOUND'
    || error.code === 'EXECUTION_NOT_FOUND'
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
  ) return 409
  if (error instanceof TaskRecorderError) return 400
  return 500
}

function sendApiError(response, error) {
  const statusCode = statusFor(error)
  const known = statusCode < 500
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

export function createApiServer({
  service,
  journalService = null,
  journalDiagnostics = null,
  store,
  hub,
  host = '127.0.0.1',
  port,
  dashboardHtml,
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
      if (request.method === 'GET' && pathname === '/api/v1/snapshot') {
        sendJson(response, 200, { ...hub.current(), ...await service.dashboardSnapshot() })
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
