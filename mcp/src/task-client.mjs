import { TaskRecorderError } from './errors.mjs'

function serviceUnavailable() {
  return new TaskRecorderError(
    'SERVICE_UNAVAILABLE',
    'tasks-recorder taskd is unavailable; check `npm run taskd -- status`',
  )
}

export function createTaskClient({
  baseUrl,
  fetchImpl = globalThis.fetch,
  timeoutMs = 5_000,
}) {
  const origin = baseUrl.replace(/\/$/, '')

  async function request(path, { method = 'GET', body } = {}) {
    const headers = {
      Accept: 'application/json',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    }
    let response
    try {
      response = await fetchImpl(`${origin}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch {
      throw serviceUnavailable()
    }

    let result
    try {
      result = await response.json()
    } catch {
      throw new TaskRecorderError('SERVICE_RESPONSE_INVALID', 'tasks-recorder taskd returned invalid JSON')
    }
    if (!response.ok) {
      const serverError = result?.error ?? {}
      throw new TaskRecorderError(
        serverError.code ?? 'SERVICE_REQUEST_FAILED',
        serverError.message ?? `tasks-recorder taskd request failed with HTTP ${response.status}`,
        serverError.details,
      )
    }
    return result
  }

  return {
    context: (input) => request('/api/v1/context', { method: 'POST', body: input }),
    list: (filters = {}) => {
      const query = new URLSearchParams()
      for (const [key, value] of Object.entries(filters)) {
        if (value !== undefined && value !== null) query.set(key, value)
      }
      const suffix = query.size ? `?${query}` : ''
      return request(`/api/v1/tasks${suffix}`).then(({ tasks }) => tasks)
    },
    show: (id) => request(`/api/v1/tasks/${encodeURIComponent(id)}`),
    upsert: (input) => request(`/api/v1/tasks/${encodeURIComponent(input.id)}`, {
      method: 'PUT', body: input,
    }),
    complete: (input) => request(`/api/v1/tasks/${encodeURIComponent(input.id)}/complete`, {
      method: 'POST', body: input,
    }),
    updateStatus: ({ id, status, expected_updated_at: expectedUpdatedAt }) => request(
      `/api/v1/tasks/${encodeURIComponent(id)}/status`,
      {
        method: 'PATCH',
        body: { status, expected_updated_at: expectedUpdatedAt },
      },
    ),
    heartbeat: (input) => request('/api/v1/heartbeat', { method: 'POST', body: input }),
    render: () => request('/api/v1/render', { method: 'POST' }),
    check: () => request('/api/v1/check'),
  }
}
