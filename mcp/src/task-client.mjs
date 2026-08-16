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
    syncTree: (input) => request('/api/v1/tasks/sync-tree', { method: 'POST', body: input }),
    updateTask: ({ id, ...body }) => request(`/api/v1/tasks/${encodeURIComponent(id)}`, {
      method: 'PATCH', body,
    }),
    archiveTask: ({ id, ...body }) => request(`/api/v1/tasks/${encodeURIComponent(id)}/archive`, {
      method: 'POST', body,
    }),
    deleteTask: ({ id, ...body }) => request(`/api/v1/tasks/${encodeURIComponent(id)}/delete`, {
      method: 'POST', body,
    }),
    restoreTask: ({ id, ...body }) => request(`/api/v1/tasks/${encodeURIComponent(id)}/restore`, {
      method: 'POST', body,
    }),
    taskEvents: (id) => request(`/api/v1/tasks/${encodeURIComponent(id)}/events`)
      .then(({ events }) => events),
    updateStatus: ({ id, status, expected_updated_at: expectedUpdatedAt }) => request(
      `/api/v1/tasks/${encodeURIComponent(id)}/status`,
      {
        method: 'PATCH',
        body: { status, expected_updated_at: expectedUpdatedAt },
      },
    ),
    heartbeat: (input) => request('/api/v1/heartbeat', { method: 'POST', body: input }),
    sessionStart: (input) => request('/api/v1/lifecycle/session-start', {
      method: 'POST', body: input,
    }),
    turnStart: (input) => request('/api/v1/lifecycle/turn-start', {
      method: 'POST', body: input,
    }),
    toolUse: (input) => request('/api/v1/lifecycle/tool-use', {
      method: 'POST', body: input,
    }),
    subagentStart: (input) => request('/api/v1/lifecycle/subagent-start', {
      method: 'POST', body: input,
    }),
    subagentStop: (input) => request('/api/v1/lifecycle/subagent-stop', {
      method: 'POST', body: input,
    }),
    sessionEnd: (input) => request('/api/v1/lifecycle/session-end', {
      method: 'POST', body: input,
    }),
    sessionContext: (id) => request(`/api/v1/sessions/${encodeURIComponent(id)}/context`),
    listExecutions: (filters = {}) => {
      const query = new URLSearchParams()
      for (const [key, value] of Object.entries(filters)) {
        if (value !== undefined && value !== null) query.set(key, value)
      }
      const suffix = query.size ? `?${query}` : ''
      return request(`/api/v1/executions${suffix}`).then(({ executions }) => executions)
    },
    assignExecution: ({ id, ...body }) => request(
      `/api/v1/executions/${encodeURIComponent(id)}/task`,
      { method: 'PATCH', body },
    ),
    classifyExecution: ({ id, ...body }) => request(
      `/api/v1/executions/${encodeURIComponent(id)}/classification`,
      { method: 'PATCH', body },
    ),
    updateExecutionAssignments: (input) => request('/api/v1/executions/tasks', {
      method: 'PATCH', body: input,
    }),
    importExecutions: (input) => request('/api/v1/import/executions', {
      method: 'POST', body: input,
    }),
    render: () => request('/api/v1/render', { method: 'POST' }),
    check: () => request('/api/v1/check'),
  }
}
