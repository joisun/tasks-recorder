import type {
  DashboardMeta,
  DashboardSnapshot,
  ExecutionAssignmentPatch,
  ExecutionAssignmentResponse,
  ExecutionFilters,
  ExecutionRecord,
  ProjectAssignmentResponse,
  TaskDetailResponse,
  TaskEventRecord,
  TaskMutationResponse,
  TaskPatch,
  TaskResumeResponse,
} from './types'

const DEFAULT_TIMEOUT_MS = 5_000

export class DashboardApiError extends Error {
  readonly status: number
  readonly code: string
  readonly details: unknown

  constructor(
    message: string,
    { status = 0, code = 'DASHBOARD_REQUEST_FAILED', details = null }: {
      status?: number
      code?: string
      details?: unknown
    } = {},
  ) {
    super(message)
    this.name = 'DashboardApiError'
    this.status = status
    this.code = code
    this.details = details
  }
}

interface ServerErrorPayload {
  ok?: boolean
  error?: {
    code?: string
    message?: string
    details?: unknown
  }
}

export interface DashboardApi {
  meta(): Promise<DashboardMeta>
  snapshot(): Promise<DashboardSnapshot>
  task(id: string): Promise<TaskDetailResponse>
  events(id: string): Promise<TaskEventRecord[]>
  executions(filters?: ExecutionFilters): Promise<ExecutionRecord[]>
  updateTask(id: string, expectedRevision: number, patch: TaskPatch): Promise<TaskMutationResponse>
  resumeTask(id: string): Promise<TaskResumeResponse>
  archiveTask(id: string, expectedRevision: number): Promise<TaskMutationResponse>
  restoreTask(id: string, expectedRevision: number): Promise<TaskMutationResponse>
  updateExecutionAssignments(input: ExecutionAssignmentPatch): Promise<ExecutionAssignmentResponse>
  assignSourceSessionProject(
    sourceSessionId: string,
    projectId: string,
    expectedProjectId?: string | null,
  ): Promise<ProjectAssignmentResponse>
}

type FetchImplementation = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

function queryString(filters: ExecutionFilters = {}) {
  const parameters = new URLSearchParams()
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== null && value !== '') parameters.set(key, String(value))
  }
  const query = parameters.toString()
  return query ? `?${query}` : ''
}

export function createDashboardApi({
  baseUrl = '',
  fetchImpl = globalThis.fetch?.bind(globalThis),
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: {
  baseUrl?: string
  fetchImpl?: FetchImplementation
  timeoutMs?: number
} = {}): DashboardApi {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl is required')

  async function request<T>(path: string, { method = 'GET', body }: {
    method?: string
    body?: unknown
  } = {}): Promise<T> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    let response: Response
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
      const timedOut = error instanceof DOMException
        ? error.name === 'AbortError'
        : (error as { name?: string } | null)?.name === 'AbortError'
      throw new DashboardApiError(timedOut ? '请求超时' : '无法连接 Tasks Recorder', {
        code: timedOut ? 'DASHBOARD_REQUEST_TIMEOUT' : 'DASHBOARD_CONNECTION_FAILED',
      })
    } finally {
      clearTimeout(timeout)
    }

    let payload: unknown
    try {
      payload = await response.json()
    } catch {
      throw new DashboardApiError(`服务返回了无效响应（HTTP ${response.status}）`, {
        status: response.status,
        code: 'DASHBOARD_INVALID_RESPONSE',
      })
    }

    const serverPayload = payload as ServerErrorPayload | null
    if (!response.ok || serverPayload?.ok === false) {
      const serverError = serverPayload?.error
      throw new DashboardApiError(
        serverError?.message ?? `请求失败（HTTP ${response.status}）`,
        {
          status: response.status,
          code: serverError?.code ?? 'DASHBOARD_REQUEST_FAILED',
          details: serverError?.details ?? null,
        },
      )
    }
    return payload as T
  }

  const revisionAction = (id: string, action: 'archive' | 'restore', expectedRevision: number) => (
    request<TaskMutationResponse>(`/api/v1/tasks/${encodeURIComponent(id)}/${action}`, {
      method: 'POST',
      body: { expected_revision: expectedRevision, actor: 'user' },
    })
  )

  return {
    meta: () => request('/api/v1/meta'),
    snapshot: () => request('/api/v1/snapshot'),
    task: (id) => request(`/api/v1/tasks/${encodeURIComponent(id)}`),
    events: async (id) => (
      await request<{ events: TaskEventRecord[] }>(`/api/v1/tasks/${encodeURIComponent(id)}/events`)
    ).events ?? [],
    executions: async (filters = {}) => (
      await request<{ executions: ExecutionRecord[] }>(`/api/v1/executions${queryString(filters)}`)
    ).executions ?? [],
    updateTask: (id, expectedRevision, patch) => request(
      `/api/v1/tasks/${encodeURIComponent(id)}`,
      {
        method: 'PATCH',
        body: { expected_revision: expectedRevision, patch, actor: 'user' },
      },
    ),
    resumeTask: (id) => request(`/api/v1/tasks/${encodeURIComponent(id)}/resume`, {
      method: 'POST', body: {},
    }),
    archiveTask: (id, expectedRevision) => revisionAction(id, 'archive', expectedRevision),
    restoreTask: (id, expectedRevision) => revisionAction(id, 'restore', expectedRevision),
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
  }
}
