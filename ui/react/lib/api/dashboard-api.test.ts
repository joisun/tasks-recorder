import { describe, expect, test, vi } from 'vitest'

import { createDashboardApi, DashboardApiError } from './dashboard-api'

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('DashboardApi', () => {
  test('reads the typed dashboard snapshot', async () => {
    const snapshot = {
      server_instance_id: 'server-a',
      revision: 4,
      schema_version: 3,
      generated_at: '2026-08-28T04:00:00.000Z',
      home_directory: '/Users/me',
      tasks: [],
      projects: [],
      warnings: [],
      project_inbox: [],
      project_inbox_count: 0,
      attribution_inbox_count: 0,
      unassigned_execution_count: 0,
    }
    const api = createDashboardApi({ fetchImpl: vi.fn(async () => jsonResponse(snapshot)) })

    await expect(api.snapshot()).resolves.toEqual(snapshot)
  })

  test('sends one exact optimistic task update', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ task: { id: 'task-a', revision: 8 } }))
    const api = createDashboardApi({ fetchImpl })

    await api.updateTask('task-a', 7, { title: 'Renamed' })

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(fetchImpl).toHaveBeenCalledWith('/api/v1/tasks/task-a', expect.objectContaining({
      method: 'PATCH',
      body: JSON.stringify({
        expected_revision: 7,
        patch: { title: 'Renamed' },
        actor: 'user',
      }),
    }))
  })

  test('reads task events from their dedicated endpoint', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ events: [{ id: 'event-a' }] }))
    const api = createDashboardApi({ fetchImpl })

    await expect(api.events('task/a')).resolves.toEqual([{ id: 'event-a' }])
    expect(fetchImpl).toHaveBeenCalledWith('/api/v1/tasks/task%2Fa/events', expect.any(Object))
  })

  test('maps Scheduled and Run contracts to exact taskd routes and bodies', async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = []
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init: RequestInit = {}) => {
      calls.push({
        url: String(url),
        method: init.method ?? 'GET',
        body: init.body === undefined ? null : JSON.parse(String(init.body)),
      })
      return jsonResponse({ ok: true, jobs: [], runs: [], run: null })
    })
    const api = createDashboardApi({ fetchImpl })
    const scheduleId = 'schedule/id ?'
    const runId = 'run/id ?'

    await api.schedules()
    await api.schedule(scheduleId)
    await api.scheduleRuns(scheduleId)
    await api.scheduledRun(runId)
    await api.runScheduleNow(scheduleId, 'request-1')
    await api.steerRun(runId, { expected_turn_revision: 2, text: 'Check rollback.' })
    await api.stopRun(runId, { expected_turn_revision: 2 })
    await api.scheduledRunLog(runId, { stream: 'stderr', tail: 4096 })
    await api.markScheduledRunReviewed(runId)
    await api.resumeScheduledRun(runId)

    expect(calls).toEqual([
      { url: '/api/v1/schedules', method: 'GET', body: null },
      { url: '/api/v1/schedules/schedule%2Fid%20%3F', method: 'GET', body: null },
      { url: '/api/v1/schedules/schedule%2Fid%20%3F/runs', method: 'GET', body: null },
      { url: '/api/v1/scheduled-runs/run%2Fid%20%3F', method: 'GET', body: null },
      {
        url: '/api/v1/schedules/schedule%2Fid%20%3F/run', method: 'POST',
        body: { idempotency_key: 'request-1' },
      },
      {
        url: '/api/v1/runs/run%2Fid%20%3F/steer', method: 'POST',
        body: { expected_turn_revision: 2, text: 'Check rollback.' },
      },
      {
        url: '/api/v1/runs/run%2Fid%20%3F/stop', method: 'POST',
        body: { expected_turn_revision: 2 },
      },
      {
        url: '/api/v1/scheduled-runs/run%2Fid%20%3F/log?stream=stderr&tail=4096',
        method: 'GET', body: null,
      },
      { url: '/api/v1/scheduled-runs/run%2Fid%20%3F/review', method: 'POST', body: {} },
      { url: '/api/v1/scheduled-runs/run%2Fid%20%3F/resume', method: 'POST', body: {} },
    ])
  })

  test.each([
    {
      name: 'non-JSON response',
      fetchImpl: async () => new Response('not json', { status: 502 }),
      code: 'DASHBOARD_INVALID_RESPONSE',
      status: 502,
    },
    {
      name: 'typed server error',
      fetchImpl: async () => jsonResponse({
        ok: false,
        error: { code: 'TASK_VERSION_CONFLICT', message: 'task changed', details: { revision: 8 } },
      }, 409),
      code: 'TASK_VERSION_CONFLICT',
      status: 409,
    },
    {
      name: 'network failure',
      fetchImpl: async () => { throw new TypeError('offline') },
      code: 'DASHBOARD_CONNECTION_FAILED',
      status: 0,
    },
  ])('normalizes $name', async ({ fetchImpl, code, status }) => {
    const api = createDashboardApi({ fetchImpl })

    await expect(api.snapshot()).rejects.toMatchObject({
      name: 'DashboardApiError', code, status,
    })
  })

  test('normalizes request timeout', async () => {
    vi.useFakeTimers()
    const api = createDashboardApi({
      timeoutMs: 25,
      fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'))
        })
      }),
    })
    const pending = api.snapshot()
    const rejection = expect(pending).rejects.toMatchObject({
      code: 'DASHBOARD_REQUEST_TIMEOUT',
    })
    await vi.advanceTimersByTimeAsync(25)

    await rejection
    vi.useRealTimers()
  })
})
