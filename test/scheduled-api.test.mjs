import assert from 'node:assert/strict'
import test from 'node:test'

import { createApiServer } from '../server/src/api-server.mjs'
import { createRevisionHub } from '../server/src/revision-hub.mjs'

const JOB_ID = '11111111-1111-4111-8111-111111111111'
const RUN_ID = '22222222-2222-4222-8222-222222222222'
const ETAG = 'a'.repeat(64)
const NEXT_ETAG = 'b'.repeat(64)

function job(overrides = {}) {
  return {
    id: JOB_ID,
    title: 'Daily review',
    prompt: 'private prompt',
    workspace: '/workspace/project',
    cadence_json: JSON.stringify({ kind: 'daily', hour: 9, minute: 0, timezone_mode: 'system' }),
    timezone_mode: 'system',
    thread_mode: 'new',
    sandbox_mode: 'read-only',
    model: null,
    reasoning_effort: null,
    timeout_seconds: 7200,
    capabilities: { skills: 'disabled', integrations: 'disabled' },
    enabled: 1,
    etag: ETAG,
    source_path: '/schedules/daily-review.md',
    schedule_generation: 3,
    sync_state: 'synced',
    sync_error_code: null,
    next_run_at: '2026-08-26T01:00:00.000Z',
    last_run_at: null,
    deleted_at: null,
    created_at: '2026-08-25T01:00:00.000Z',
    updated_at: '2026-08-25T01:00:00.000Z',
    ...overrides,
  }
}

function run(overrides = {}) {
  return {
    id: RUN_ID,
    job_id: JOB_ID,
    definition_etag: ETAG,
    spec_json: JSON.stringify({ prompt: 'private snapshot', workspace: '/workspace/project' }),
    run_nonce_hash: 'secret hash',
    completion_json: JSON.stringify({ status: 'succeeded' }),
    trigger: 'manual',
    status: 'succeeded',
    thread_id: 'thread-1',
    scheduled_for: null,
    claimed_at: '2026-08-25T01:00:00.000Z',
    started_at: '2026-08-25T01:00:01.000Z',
    heartbeat_at: '2026-08-25T01:00:02.000Z',
    finished_at: '2026-08-25T01:01:00.000Z',
    exit_code: 0,
    error_code: null,
    final_message: 'Done',
    file_changes_json: JSON.stringify([
      { path: 'src/index.mjs', kind: 'update' },
      { path: 'docs/summary.md', kind: 'add' },
    ]),
    stdout_log_path: `${JOB_ID}/${RUN_ID}/stdout.jsonl`,
    stderr_log_path: `${JOB_ID}/${RUN_ID}/stderr.log`,
    reviewed_at: null,
    created_at: '2026-08-25T01:00:00.000Z',
    updated_at: '2026-08-25T01:01:00.000Z',
    ...overrides,
  }
}

async function fixture(overrides = {}) {
  const calls = []
  const schedulerService = {
    capability: async () => ({ supported: true, backend: 'launchd' }),
    listJobs: async () => ({ jobs: [job()] }),
    getJob: async () => ({ job: job() }),
    createJob: async (input) => { calls.push(['create', input]); return { job: job() } },
    updateJob: async (...args) => { calls.push(['update', ...args]); return { job: job({ etag: NEXT_ETAG }) } },
    pauseJob: async (...args) => { calls.push(['pause', ...args]); return { job: job({ enabled: 0, etag: NEXT_ETAG }) } },
    resumeJob: async (...args) => { calls.push(['resume', ...args]); return { job: job({ etag: NEXT_ETAG }) } },
    deleteJob: async (...args) => { calls.push(['delete', ...args]); return { job: job({ deleted_at: '2026-08-25T02:00:00.000Z' }) } },
    runNow: async (...args) => { calls.push(['run', ...args]); return { dispatched: true, idempotency_key: '33333333-3333-4333-8333-333333333333' } },
    listRuns: async (...args) => { calls.push(['runs', ...args]); return { runs: [run()] } },
    listDispatches: async (...args) => { calls.push(['dispatches', ...args]); return { dispatches: [] } },
    getRun: async (...args) => { calls.push(['get-run', ...args]); return { run: run() } },
    markReviewed: async (...args) => { calls.push(['review', ...args]); return { run: run({ reviewed_at: '2026-08-25T02:00:00.000Z' }), changed: true } },
    ...overrides.schedulerService,
  }
  const hub = createRevisionHub({ instanceId: 'scheduled-api-test', keepaliveMs: 60_000 })
  const api = createApiServer({
    service: { dashboardSnapshot: async () => ({}) }, store: {}, hub, host: '127.0.0.1', port: 0,
    dashboardHtml: '<!doctype html>', schedulerService,
    scheduledRunLogs: {
      read: async (input) => { calls.push(['log', input]); return { stream: input.stream, content: 'tail' } },
    },
    sessionResume: {
      resumeScheduledRun: async (id) => { calls.push(['resume-run', id]); return { ok: true, run_id: id } },
    },
    ...overrides.api,
  })
  const address = await api.listen()
  return {
    url: address.url, calls,
    async close() { await api.close(); hub.close() },
  }
}

async function json(url, path, { method = 'GET', body } = {}) {
  const response = await fetch(`${url}${path}`, {
    method,
    ...(body === undefined ? {} : {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  })
  return { status: response.status, body: await response.json() }
}

test('Schedule list is privacy-bounded while detail exposes the editable Prompt', async () => {
  const current = await fixture()
  try {
    const list = await json(current.url, '/api/v1/schedules')
    assert.equal(list.status, 200)
    assert.equal(list.body.capability.supported, true)
    assert.equal(list.body.jobs[0].enabled, true)
    assert.deepEqual(list.body.jobs[0].capabilities, { skills: 'disabled', integrations: 'disabled' })
    assert.deepEqual(list.body.jobs[0].cadence, { kind: 'daily', hour: 9, minute: 0, timezone_mode: 'system' })
    assert.equal(list.body.jobs[0].unread_run_count, 1)
    assert.deepEqual(list.body.jobs[0].last_run, {
      id: RUN_ID,
      status: 'succeeded',
      finished_at: '2026-08-25T01:01:00.000Z',
      reviewed_at: null,
    })
    assert.deepEqual(list.body.jobs[0].current_execution, {
      kind: 'run',
      id: RUN_ID,
      status: 'succeeded',
      started_at: '2026-08-25T01:00:01.000Z',
      finished_at: '2026-08-25T01:01:00.000Z',
      error_code: null,
      output_count: 2,
    })
    assert.equal('prompt' in list.body.jobs[0], false)
    assert.equal('cadence_json' in list.body.jobs[0], false)

    const detail = await json(current.url, `/api/v1/schedules/${JOB_ID}`)
    assert.equal(detail.body.job.prompt, 'private prompt')
  } finally {
    await current.close()
  }
})

test('Schedule list and history expose a failed pending dispatch as durable execution state', async () => {
  const dispatch = {
    id: '33333333-3333-4333-8333-333333333333',
    job_id: JOB_ID,
    trigger: 'manual',
    state: 'pending',
    requested_at: '2026-08-25T02:00:00.000Z',
    attempt_count: 1,
    last_attempted_at: '2026-08-25T02:00:01.000Z',
    last_error_code: 'SCHEDULER_BACKEND_UNSUPPORTED',
  }
  const current = await fixture({
    schedulerService: {
      listDispatches: async () => ({ dispatches: [dispatch] }),
    },
  })
  try {
    const list = await json(current.url, '/api/v1/schedules')
    assert.deepEqual(list.body.jobs[0].current_execution, {
      kind: 'dispatch',
      id: dispatch.id,
      trigger: 'manual',
      status: 'dispatch_failed',
      requested_at: dispatch.requested_at,
      last_attempted_at: dispatch.last_attempted_at,
      error_code: dispatch.last_error_code,
      attempt_count: 1,
    })

    const history = await json(current.url, `/api/v1/schedules/${JOB_ID}/runs`)
    assert.equal(history.body.dispatches[0].status, 'dispatch_failed')
    assert.equal(history.body.dispatches[0].trigger, 'manual')
    assert.equal(history.body.dispatches[0].error_code, 'SCHEDULER_BACKEND_UNSUPPORTED')
  } finally {
    await current.close()
  }
})

test('Schedule list and history stop presenting an unclaimed dispatch as queued after the claim deadline', async () => {
  const dispatch = {
    id: '33333333-3333-4333-8333-333333333333',
    job_id: JOB_ID,
    trigger: 'manual',
    state: 'pending',
    requested_at: '2026-08-25T02:00:00.000Z',
    attempt_count: 1,
    last_attempted_at: '2026-08-25T02:00:01.000Z',
    last_error_code: null,
  }
  const current = await fixture({
    api: { clock: () => new Date('2026-08-25T02:02:00.000Z') },
    schedulerService: { listDispatches: async () => ({ dispatches: [dispatch] }) },
  })
  try {
    const list = await json(current.url, '/api/v1/schedules')
    assert.deepEqual(list.body.jobs[0].current_execution, {
      kind: 'dispatch',
      id: dispatch.id,
      trigger: 'manual',
      status: 'dispatch_stalled',
      requested_at: dispatch.requested_at,
      last_attempted_at: dispatch.last_attempted_at,
      claim_deadline_at: '2026-08-25T02:01:01.000Z',
      error_code: 'RUNNER_CLAIM_TIMEOUT',
      attempt_count: 1,
    })

    const history = await json(current.url, `/api/v1/schedules/${JOB_ID}/runs`)
    assert.equal(history.body.dispatches[0].status, 'dispatch_stalled')
    assert.equal(history.body.dispatches[0].claim_deadline_at, '2026-08-25T02:01:01.000Z')
    assert.equal(history.body.dispatches[0].error_code, 'RUNNER_CLAIM_TIMEOUT')
  } finally {
    await current.close()
  }
})

test('Schedule mutations map exact typed bodies and publish one revision each', async () => {
  const current = await fixture()
  try {
    const requests = [
      ['/api/v1/schedules', 'POST', { title: 'Daily', prompt: 'Review', workspace: '/workspace', cadence: { kind: 'daily' }, capabilities: { skills: 'disabled', integrations: 'disabled' } }],
      [`/api/v1/schedules/${JOB_ID}`, 'PATCH', { expected_etag: ETAG, patch: { title: 'Updated' } }],
      [`/api/v1/schedules/${JOB_ID}/pause`, 'POST', { expected_etag: ETAG }],
      [`/api/v1/schedules/${JOB_ID}/resume`, 'POST', { expected_etag: ETAG }],
      [`/api/v1/schedules/${JOB_ID}/run`, 'POST', { idempotency_key: '33333333-3333-4333-8333-333333333333' }],
      [`/api/v1/schedules/${JOB_ID}`, 'DELETE', { expected_etag: ETAG }],
    ]
    for (const [path, method, body] of requests) {
      const result = await json(current.url, path, { method, body })
      assert.equal(result.status, 200)
    }
    assert.deepEqual(current.calls, [
      ['create', requests[0][2]],
      ['update', JOB_ID, ETAG, { title: 'Updated' }],
      ['pause', JOB_ID, ETAG],
      ['resume', JOB_ID, ETAG],
      ['run', JOB_ID, { idempotency_key: '33333333-3333-4333-8333-333333333333' }],
      ['delete', JOB_ID, ETAG],
    ])
    const snapshot = await json(current.url, '/api/v1/snapshot')
    assert.equal(snapshot.body.revision, 6)
  } finally {
    await current.close()
  }
})

test('Run routes hide internal evidence, validate log tails, review, and resume by Run ID only', async () => {
  const current = await fixture()
  try {
    const history = await json(current.url, `/api/v1/schedules/${JOB_ID}/runs`)
    assert.equal(history.status, 200)
    assert.equal(history.body.runs[0].has_stdout_log, true)
    assert.deepEqual(history.body.runs[0].file_changes, [
      { path: 'src/index.mjs', kind: 'update' },
      { path: 'docs/summary.md', kind: 'add' },
    ])
    assert.equal('stdout_log_path' in history.body.runs[0], false)
    assert.equal('run_nonce_hash' in history.body.runs[0], false)
    assert.equal('spec_json' in history.body.runs[0], false)

    const detail = await json(current.url, `/api/v1/scheduled-runs/${RUN_ID}`)
    assert.equal(detail.body.run.final_message, 'Done')
    assert.equal('completion_json' in detail.body.run, false)

    const log = await json(current.url, `/api/v1/scheduled-runs/${RUN_ID}/log?stream=stderr&tail=4096`)
    assert.equal(log.body.content, 'tail')
    assert.deepEqual(current.calls.at(-1), ['log', { runId: RUN_ID, stream: 'stderr', tail: 4096 }])

    const invalid = await json(current.url, `/api/v1/scheduled-runs/${RUN_ID}/log?stream=stderr&tail=999999`)
    assert.equal(invalid.status, 400)

    await json(current.url, `/api/v1/scheduled-runs/${RUN_ID}/review`, { method: 'POST', body: {} })
    await json(current.url, `/api/v1/scheduled-runs/${RUN_ID}/resume`, { method: 'POST', body: {} })
    assert.deepEqual(current.calls.slice(-2), [['review', RUN_ID], ['resume-run', RUN_ID]])
  } finally {
    await current.close()
  }
})

test('Scheduler typed errors preserve conflict status without leaking unknown internals', async () => {
  const current = await fixture({
    schedulerService: {
      updateJob: async () => { throw Object.assign(new Error('etag mismatch'), { code: 'SCHEDULE_VERSION_CONFLICT', details: { actual_etag: NEXT_ETAG } }) },
      getJob: async () => { throw Object.assign(new Error('/private/path nonce=secret'), { code: 'BOOM' }) },
    },
  })
  try {
    const conflict = await json(current.url, `/api/v1/schedules/${JOB_ID}`, {
      method: 'PATCH', body: { expected_etag: ETAG, patch: { title: 'Updated' } },
    })
    assert.equal(conflict.status, 409)
    assert.equal(conflict.body.error.code, 'SCHEDULE_VERSION_CONFLICT')

    const internal = await json(current.url, `/api/v1/schedules/${JOB_ID}`)
    assert.equal(internal.status, 500)
    assert.equal(internal.body.error.code, 'INTERNAL_ERROR')
    assert.doesNotMatch(JSON.stringify(internal.body), /private|nonce|secret/)
  } finally {
    await current.close()
  }
})

test('Schedule mutation reports current Codex model compatibility errors without hiding them as internal failures', async () => {
  for (const code of ['CODEX_MODEL_UNAVAILABLE', 'CODEX_REASONING_UNSUPPORTED', 'CODEX_MODEL_CATALOG_UNAVAILABLE']) {
    const current = await fixture({
      schedulerService: {
        createJob: async () => { throw Object.assign(new Error('Codex preflight failed'), { code }) },
      },
    })
    try {
      const result = await json(current.url, '/api/v1/schedules', {
        method: 'POST',
        body: { title: 'Daily', prompt: 'Review', workspace: '/workspace', cadence: { kind: 'daily' } },
      })
      assert.equal(result.status, code === 'CODEX_MODEL_CATALOG_UNAVAILABLE' ? 503 : 409)
      assert.equal(result.body.error.code, code)
    } finally {
      await current.close()
    }
  }
})

test('idempotent Schedule and review no-ops do not publish synthetic revisions', async () => {
  const current = await fixture({
    schedulerService: {
      runNow: async () => ({ reused: true, dispatched: false, dispatch_state: 'consumed' }),
      markReviewed: async () => ({ run: run({ reviewed_at: '2026-08-25T02:00:00.000Z' }), changed: false }),
    },
  })
  try {
    await json(current.url, `/api/v1/schedules/${JOB_ID}/run`, {
      method: 'POST', body: { idempotency_key: '33333333-3333-4333-8333-333333333333' },
    })
    await json(current.url, `/api/v1/scheduled-runs/${RUN_ID}/review`, { method: 'POST', body: {} })
    const snapshot = await json(current.url, '/api/v1/snapshot')
    assert.equal(snapshot.body.revision, 0)
  } finally {
    await current.close()
  }
})

test('retrying a pending manual dispatch publishes its new attempt state', async () => {
  const current = await fixture({
    schedulerService: {
      runNow: async () => ({
        reused: true,
        dispatched: false,
        dispatch_state: 'pending',
        error_code: 'LAUNCHD_KICKSTART_FAILED',
        dispatch: { attempt_count: 2 },
      }),
    },
  })
  try {
    await json(current.url, `/api/v1/schedules/${JOB_ID}/run`, { method: 'POST', body: {} })
    const snapshot = await json(current.url, '/api/v1/snapshot')
    assert.equal(snapshot.body.revision, 1)
  } finally {
    await current.close()
  }
})

test('Scheduler reconcile accepts only {}, continues after a typed failure, and publishes only changed jobs', async () => {
  const otherJobId = '33333333-3333-4333-8333-333333333333'
  const current = await fixture({
    schedulerService: {
      listJobs: async () => ({ jobs: [job(), job({ id: otherJobId, etag: 'c'.repeat(64), sync_state: 'error', sync_error_code: 'LAUNCHD_BOOTSTRAP_FAILED' })] }),
      retrySync: async (id) => {
        if (id === JOB_ID) {
          return {
            reconciled: true,
            error_code: null,
            job: job({ etag: NEXT_ETAG, next_run_at: '2026-08-27T01:00:00.000Z' }),
          }
        }
        throw Object.assign(new Error('/private/scheduler detail nonce=secret'), { code: 'LAUNCHD_BOOTSTRAP_FAILED' })
      },
    },
  })
  try {
    const result = await json(current.url, '/api/v1/scheduler/reconcile', { method: 'POST', body: {} })
    assert.equal(result.status, 200)
    assert.deepEqual(result.body, {
      jobs: [
        { id: JOB_ID, reconciled: true, error_code: null },
        { id: otherJobId, reconciled: false, error_code: 'LAUNCHD_BOOTSTRAP_FAILED' },
      ],
    })
    assert.doesNotMatch(JSON.stringify(result.body), /private|nonce|secret/)
    const snapshot = await json(current.url, '/api/v1/snapshot')
    assert.equal(snapshot.body.revision, 1)

    const rejected = await json(current.url, '/api/v1/scheduler/reconcile', {
      method: 'POST', body: { prompt: 'not accepted' },
    })
    assert.equal(rejected.status, 400)
  } finally {
    await current.close()
  }
})

test('Scheduler boundary keeps unavailable/log errors typed and rejects malformed IDs', async () => {
  const unavailable = await fixture({ api: { sessionResume: null } })
  try {
    const resume = await json(unavailable.url, `/api/v1/scheduled-runs/${RUN_ID}/resume`, {
      method: 'POST', body: {},
    })
    assert.equal(resume.status, 503)
    assert.equal(resume.body.error.code, 'SCHEDULE_RESUME_UNAVAILABLE')

    const malformed = await json(unavailable.url, '/api/v1/schedules/%E0%A4%A')
    assert.equal(malformed.status, 400)
    assert.equal(malformed.body.error.code, 'SCHEDULE_INPUT_INVALID')
  } finally {
    await unavailable.close()
  }

  const missingLog = await fixture({
    api: { scheduledRunLogs: { read: async () => { throw Object.assign(new Error('missing'), { code: 'SCHEDULE_LOG_NOT_FOUND' }) } } },
  })
  try {
    const result = await json(missingLog.url, `/api/v1/scheduled-runs/${RUN_ID}/log?stream=stdout&tail=100`)
    assert.equal(result.status, 404)
    assert.equal(result.body.error.code, 'SCHEDULE_LOG_NOT_FOUND')
  } finally {
    await missingLog.close()
  }
})
