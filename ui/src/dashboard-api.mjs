const DEFAULT_TIMEOUT_MS = 5_000

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
    snapshot: () => request('/api/v1/snapshot'),
    task: (id) => request(`/api/v1/tasks/${encodeURIComponent(id)}`),
    events: async (id) => (await request(`/api/v1/tasks/${encodeURIComponent(id)}/events`)).events ?? [],
    executions: async (filters = {}) => (
      await request(`/api/v1/executions${queryString(filters)}`)
    ).executions ?? [],
    updateExecutionAssignments: (input) => request('/api/v1/executions/tasks', {
      method: 'PATCH', body: input,
    }),
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
  }
}
