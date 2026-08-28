const DEFAULT_TIMEOUT_MS = 5_000
const SCHEDULE_CREATE_FIELDS = Object.freeze([
  'title', 'prompt', 'workspace', 'cadence', 'sandbox_mode', 'model',
  'reasoning_effort', 'timeout_seconds',
])
const SCHEDULE_PATCH_FIELDS = Object.freeze([...SCHEDULE_CREATE_FIELDS, 'next_run_at'])
const RUN_STEER_FIELDS = Object.freeze(['expected_turn_revision', 'text'])
const RUN_STOP_FIELDS = Object.freeze(['expected_turn_revision'])

export class DashboardApiError extends Error {
  constructor(message, { status = 0, code = 'DASHBOARD_REQUEST_FAILED', details = null } = {}) {
    super(message)
    this.name = 'DashboardApiError'
    this.status = status
    this.code = code
    this.details = details
  }
}

function queryString(filters = {}) {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value))
  }
  const query = params.toString()
  return query ? `?${query}` : ''
}

function pickFields(input, fields) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {}
  const result = {}
  for (const field of fields) {
    if (Object.hasOwn(input, field)) result[field] = input[field]
  }
  return result
}

function scheduleEtag(expectedEtag) {
  if (typeof expectedEtag !== 'string' || !/^[0-9a-f]{64}$/.test(expectedEtag)) {
    throw new TypeError('expectedEtag must be a sha256 etag')
  }
  return expectedEtag
}

export function createDashboardApi({
  baseUrl = '',
  fetchImpl = globalThis.fetch?.bind(globalThis),
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl is required')

  async function request(path, { method = 'GET', body } = {}) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    let response
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: {
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
        ...(method === 'GET' ? { cache: 'no-store' } : {}),
      })
    } catch (error) {
      const timedOut = error?.name === 'AbortError'
      throw new DashboardApiError(timedOut ? '请求超时' : '无法连接 Tasks Recorder', {
        code: timedOut ? 'DASHBOARD_REQUEST_TIMEOUT' : 'DASHBOARD_CONNECTION_FAILED',
      })
    } finally {
      clearTimeout(timeout)
    }

    let payload = null
    try {
      payload = await response.json()
    } catch {
      throw new DashboardApiError(`服务返回了无效响应（HTTP ${response.status}）`, {
        status: response.status,
        code: 'DASHBOARD_INVALID_RESPONSE',
      })
    }

    if (!response.ok || payload?.ok === false) {
      const serverError = payload?.error ?? {}
      throw new DashboardApiError(serverError.message ?? `请求失败（HTTP ${response.status}）`, {
        status: response.status,
        code: serverError.code ?? 'DASHBOARD_REQUEST_FAILED',
        details: serverError.details ?? null,
      })
    }
    return payload
  }

  const revisionAction = (id, action, expectedRevision) => request(
    `/api/v1/tasks/${encodeURIComponent(id)}/${action}`,
    { method: 'POST', body: { expected_revision: expectedRevision, actor: 'user' } },
  )

  return {
    meta: () => request('/api/v1/meta'),
    runtimes: () => request('/api/v1/runtimes'),
    refreshRuntimes: () => request('/api/v1/runtimes/refresh', {
      method: 'POST', body: {},
    }),
    runtimeModels: (id) => request(
      `/api/v1/runtimes/${encodeURIComponent(id)}/models`,
    ),
    createRun: (scheduleId, idempotencyKey) => request('/api/v1/runs', {
      method: 'POST',
      body: {
        schedule_id: scheduleId,
        origin: 'manual',
        idempotency_key: idempotencyKey,
      },
    }),
    runs: (filters = {}) => request(`/api/v1/runs${queryString(filters)}`),
    run: (id) => request(`/api/v1/runs/${encodeURIComponent(id)}`),
    cancelRun: (id) => request(`/api/v1/runs/${encodeURIComponent(id)}/cancel`, {
      method: 'POST', body: {},
    }),
    steerRun: (id, input) => request(`/api/v1/runs/${encodeURIComponent(id)}/steer`, {
      method: 'POST', body: pickFields(input, RUN_STEER_FIELDS),
    }),
    stopRun: (id, input) => request(`/api/v1/runs/${encodeURIComponent(id)}/stop`, {
      method: 'POST', body: pickFields(input, RUN_STOP_FIELDS),
    }),
    markRunReviewed: (id) => request(`/api/v1/runs/${encodeURIComponent(id)}/review`, {
      method: 'POST', body: {},
    }),
    resumeRun: (id) => request(`/api/v1/runs/${encodeURIComponent(id)}/resume`, {
      method: 'POST', body: {},
    }),
    snapshot: () => request('/api/v1/snapshot'),
    settings: () => request('/api/v1/settings'),
    updateSettings: (input) => request('/api/v1/settings', { method: 'PATCH', body: input }),
    resumeTask: (id) => request(`/api/v1/tasks/${encodeURIComponent(id)}/resume`, {
      method: 'POST', body: {},
    }),
    task: (id) => request(`/api/v1/tasks/${encodeURIComponent(id)}`),
    events: async (id) => (await request(`/api/v1/tasks/${encodeURIComponent(id)}/events`)).events ?? [],
    executions: async (filters = {}) => (
      await request(`/api/v1/executions${queryString(filters)}`)
    ).executions ?? [],
    updateExecutionAssignments: (input) => request('/api/v1/executions/tasks', {
      method: 'PATCH', body: input,
    }),
    assignSourceSessionProject: (sourceSessionId, projectId, expectedProjectId = null) => request(
      `/api/v1/source-sessions/${encodeURIComponent(sourceSessionId)}/project`,
      {
        method: 'PATCH',
        body: { project_id: projectId, expected_project_id: expectedProjectId },
      },
    ),
    updateTask: (id, expectedRevision, patch) => request(`/api/v1/tasks/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: { expected_revision: expectedRevision, patch, actor: 'user' },
    }),
    createChild: (id, input) => request(`/api/v1/tasks/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: { ...input, status: input.status ?? 'planned', actor: 'user' },
    }),
    archiveTask: (id, expectedRevision) => revisionAction(id, 'archive', expectedRevision),
    deleteTask: (id, expectedRevision) => revisionAction(id, 'delete', expectedRevision),
    restoreTask: (id, expectedRevision) => revisionAction(id, 'restore', expectedRevision),
    schedules: () => request('/api/v1/schedules'),
    schedule: (id) => request(`/api/v1/schedules/${encodeURIComponent(id)}`),
    createSchedule: (input) => request('/api/v1/schedules', {
      method: 'POST', body: pickFields(input, SCHEDULE_CREATE_FIELDS),
    }),
    updateSchedule: (id, expectedEtag, patch) => request(`/api/v1/schedules/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: {
        expected_etag: scheduleEtag(expectedEtag),
        patch: pickFields(patch, SCHEDULE_PATCH_FIELDS),
      },
    }),
    pauseSchedule: (id, expectedEtag) => request(
      `/api/v1/schedules/${encodeURIComponent(id)}/pause`,
      { method: 'POST', body: { expected_etag: scheduleEtag(expectedEtag) } },
    ),
    resumeSchedule: (id, expectedEtag) => request(
      `/api/v1/schedules/${encodeURIComponent(id)}/resume`,
      { method: 'POST', body: { expected_etag: scheduleEtag(expectedEtag) } },
    ),
    runScheduleNow: (id, idempotencyKey) => request(
      `/api/v1/schedules/${encodeURIComponent(id)}/run`,
      { method: 'POST', body: { idempotency_key: idempotencyKey } },
    ),
    deleteSchedule: (id, expectedEtag) => request(`/api/v1/schedules/${encodeURIComponent(id)}`, {
      method: 'DELETE', body: { expected_etag: scheduleEtag(expectedEtag) },
    }),
    scheduleRuns: (id) => request(`/api/v1/schedules/${encodeURIComponent(id)}/runs`),
    scheduledRun: (id) => request(`/api/v1/scheduled-runs/${encodeURIComponent(id)}`),
    scheduledRunLog: (id, options = {}) => {
      const { stream, tail } = options ?? {}
      return request(`/api/v1/scheduled-runs/${encodeURIComponent(id)}/log${queryString({ stream, tail })}`)
    },
    markScheduledRunReviewed: (id) => request(`/api/v1/scheduled-runs/${encodeURIComponent(id)}/review`, {
      method: 'POST', body: {},
    }),
    resumeScheduledRun: (id) => request(`/api/v1/scheduled-runs/${encodeURIComponent(id)}/resume`, {
      method: 'POST', body: {},
    }),
  }
}
