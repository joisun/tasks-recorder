import assert from 'node:assert/strict'
import test from 'node:test'

import { createDashboardApi } from '../ui/src/dashboard-api.mjs'

const ETAG = 'a'.repeat(64)

function jsonResponse(body, { status = 200 } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function clientWithCalls() {
  const calls = []
  const api = createDashboardApi({
    fetchImpl: async (url, options = {}) => {
      calls.push({
        url,
        method: options.method ?? 'GET',
        body: options.body === undefined ? null : JSON.parse(options.body),
      })
      return jsonResponse({ ok: true })
    },
  })
  return { api, calls }
}

test('dashboard API maps only the typed Schedule and Scheduled Run read routes', async () => {
  const { api, calls } = clientWithCalls()
  const jobId = 'job/id ?'
  const runId = 'run/id ?'

  await api.schedules()
  await api.schedule(jobId)
  await api.scheduleRuns(jobId)
  await api.scheduledRun(runId)
  await api.scheduledRunLog(runId, {
    stream: 'stderr',
    tail: 4096,
    command: 'must-not-be-sent',
    path: '/must-not-be-sent',
  })

  assert.deepEqual(calls, [
    { url: '/api/v1/schedules', method: 'GET', body: null },
    { url: '/api/v1/schedules/job%2Fid%20%3F', method: 'GET', body: null },
    { url: '/api/v1/schedules/job%2Fid%20%3F/runs', method: 'GET', body: null },
    { url: '/api/v1/scheduled-runs/run%2Fid%20%3F', method: 'GET', body: null },
    { url: '/api/v1/scheduled-runs/run%2Fid%20%3F/log?stream=stderr&tail=4096', method: 'GET', body: null },
  ])
})

test('dashboard API maps typed Schedule mutations and Run actions to exact bodies', async () => {
  const { api, calls } = clientWithCalls()
  const jobId = 'job/id ?'
  const runId = 'run/id ?'
  const idempotencyKey = '33333333-3333-4333-8333-333333333333'

  assert.throws(() => api.updateSchedule(jobId, undefined, { title: 'Updated' }), /expectedEtag/)
  assert.throws(() => api.pauseSchedule(jobId, 0), /expectedEtag/)
  assert.equal(calls.length, 0)

  await api.createSchedule({
    title: 'Daily', prompt: 'Review', workspace: '/workspace', cadence: { kind: 'daily' },
    command: 'must-not-be-sent', path: '/must-not-be-sent',
  })
  await api.updateSchedule(jobId, ETAG, {
    title: 'Updated', command: 'must-not-be-sent', path: '/must-not-be-sent',
  })
  await api.pauseSchedule(jobId, ETAG)
  await api.resumeSchedule(jobId, ETAG)
  await api.runScheduleNow(jobId, idempotencyKey, { command: 'must-not-be-sent' })
  await api.deleteSchedule(jobId, ETAG)
  await api.markScheduledRunReviewed(runId, { path: '/must-not-be-sent' })
  await api.resumeScheduledRun(runId, { workspace: '/must-not-be-sent' })

  assert.deepEqual(calls, [
    {
      url: '/api/v1/schedules', method: 'POST',
      body: { title: 'Daily', prompt: 'Review', workspace: '/workspace', cadence: { kind: 'daily' } },
    },
    {
      url: '/api/v1/schedules/job%2Fid%20%3F', method: 'PATCH',
      body: { expected_etag: ETAG, patch: { title: 'Updated' } },
    },
    {
      url: '/api/v1/schedules/job%2Fid%20%3F/pause', method: 'POST',
      body: { expected_etag: ETAG },
    },
    {
      url: '/api/v1/schedules/job%2Fid%20%3F/resume', method: 'POST',
      body: { expected_etag: ETAG },
    },
    {
      url: '/api/v1/schedules/job%2Fid%20%3F/run', method: 'POST',
      body: { idempotency_key: idempotencyKey },
    },
    {
      url: '/api/v1/schedules/job%2Fid%20%3F', method: 'DELETE',
      body: { expected_etag: ETAG },
    },
    {
      url: '/api/v1/scheduled-runs/run%2Fid%20%3F/review', method: 'POST', body: {},
    },
    {
      url: '/api/v1/scheduled-runs/run%2Fid%20%3F/resume', method: 'POST', body: {},
    },
  ])
})

test('dashboard API exposes runtime registry and unified Run routes', async () => {
  const { api, calls } = clientWithCalls()
  const runId = 'run/id ?'
  const scheduleId = 'schedule/id ?'

  await api.meta()
  await api.runtimes()
  await api.refreshRuntimes()
  await api.runtimeModels('codex/local')
  await api.createRun(scheduleId, 'request-1')
  await api.runs({ schedule_id: scheduleId, status: 'running' })
  await api.run(runId)
  await api.cancelRun(runId)
  await api.steerRun(runId, {
    expected_turn_revision: 2,
    text: 'Check rollback.',
    thread_id: 'must-not-be-sent',
  })
  await api.stopRun(runId, {
    expected_turn_revision: 2,
    turn_id: 'must-not-be-sent',
  })
  await api.markRunReviewed(runId)
  await api.resumeRun(runId)

  assert.deepEqual(calls, [
    { url: '/api/v1/meta', method: 'GET', body: null },
    { url: '/api/v1/runtimes', method: 'GET', body: null },
    { url: '/api/v1/runtimes/refresh', method: 'POST', body: {} },
    { url: '/api/v1/runtimes/codex%2Flocal/models', method: 'GET', body: null },
    {
      url: '/api/v1/runs', method: 'POST',
      body: {
        schedule_id: scheduleId,
        origin: 'manual',
        idempotency_key: 'request-1',
      },
    },
    {
      url: '/api/v1/runs?schedule_id=schedule%2Fid+%3F&status=running',
      method: 'GET', body: null,
    },
    { url: '/api/v1/runs/run%2Fid%20%3F', method: 'GET', body: null },
    { url: '/api/v1/runs/run%2Fid%20%3F/cancel', method: 'POST', body: {} },
    {
      url: '/api/v1/runs/run%2Fid%20%3F/steer', method: 'POST',
      body: { expected_turn_revision: 2, text: 'Check rollback.' },
    },
    {
      url: '/api/v1/runs/run%2Fid%20%3F/stop', method: 'POST',
      body: { expected_turn_revision: 2 },
    },
    { url: '/api/v1/runs/run%2Fid%20%3F/review', method: 'POST', body: {} },
    { url: '/api/v1/runs/run%2Fid%20%3F/resume', method: 'POST', body: {} },
  ])
})
