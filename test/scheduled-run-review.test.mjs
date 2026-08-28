import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createScheduledRunReview,
  runDuration,
  runStatusPresentation,
  scheduledRunReviewMarkup,
} from '../ui/src/scheduled-run-review.mjs'

const JOB_ID = '11111111-1111-4111-8111-111111111111'
const RUN_ID = '22222222-2222-4222-8222-222222222222'

function run(overrides = {}) {
  return {
    id: RUN_ID,
    job_id: JOB_ID,
    trigger: 'scheduled',
    status: 'succeeded',
    thread_id: '019f-thread-complete',
    scheduled_for: '2026-08-25T01:00:00.000Z',
    started_at: '2026-08-25T01:00:01.000Z',
    finished_at: '2026-08-25T01:02:04.000Z',
    final_message: 'Reviewed <unsafe> output',
    file_changes: [
      { path: 'artifacts/report.md', kind: 'add' },
      { path: 'src/index.mjs', kind: 'update' },
    ],
    has_stdout_log: true,
    has_stderr_log: true,
    reviewed_at: null,
    created_at: '2026-08-25T01:00:00.000Z',
    ...overrides,
  }
}

function shell() {
  const listeners = new Map()
  const focusTarget = { focusCalls: 0, focus() { this.focusCalls += 1 } }
  const element = {
    hidden: true,
    innerHTML: '',
    addEventListener: (type, listener) => listeners.set(type, listener),
    removeEventListener: (type) => listeners.delete(type),
    querySelector: () => focusTarget,
    querySelectorAll: () => [],
    contains: () => false,
  }
  const backdrop = {
    hidden: true,
    addEventListener: (type, listener) => listeners.set(`backdrop:${type}`, listener),
    removeEventListener: (type) => listeners.delete(`backdrop:${type}`),
  }
  return { element, backdrop, listeners, focusTarget }
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

test('Run Review maps every status and formats duration without conflating trigger', () => {
  for (const status of ['queued', 'running', 'succeeded', 'failed', 'timed_out', 'canceled', 'interrupted']) {
    const presentation = runStatusPresentation(status)
    assert.equal(typeof presentation.label, 'string')
    assert.ok(presentation.label.length > 0)
    assert.equal(typeof presentation.tone, 'string')
  }
  assert.equal(runStatusPresentation('running').label, '运行中')
  assert.equal(runStatusPresentation('succeeded').label, '已成功')
  assert.equal(runStatusPresentation('interrupted').label, '已中断')
  assert.equal(runDuration(run()), '2m 3s')
  assert.equal(runDuration(run({ started_at: null })), '—')
})

test('Run Review renders execution records as a table with outputs, Session copy, and terminal resume', () => {
  const markup = scheduledRunReviewMarkup({
    job: { id: JOB_ID, title: 'Daily <review>' },
    runs: [run(), run({ id: '33333333-3333-4333-8333-333333333333', status: 'failed', reviewed_at: '2026-08-25T02:00:00.000Z' })],
    selectedRun: run(),
    log: { stream: 'stdout', content: 'tail <line>', truncated: true },
  })
  assert.match(markup, /Daily &lt;review&gt;/)
  assert.match(markup, /Reviewed &lt;unsafe&gt; output/)
  assert.match(markup, /tail &lt;line&gt;/)
  assert.match(markup, /日志已截断/)
  assert.match(markup, /<table/)
  assert.match(markup, /状态/)
  assert.match(markup, /耗时/)
  assert.match(markup, /产出/)
  assert.match(markup, /Session/)
  assert.match(markup, /artifacts\/report\.md/)
  assert.match(markup, /data-run-review-action="copy"/)
  assert.match(markup, /data-run-review-action="resume"/)
  assert.doesNotMatch(markup, /scheduled-run-history/)
  assert.doesNotMatch(markup, />History</)
  assert.doesNotMatch(markup, /stdout_log_path|stderr_log_path|\/private\//)
  assert.doesNotMatch(markup, /<unsafe>|<line>/)
  assert.doesNotMatch(markup, /Run review|查看结果、诊断日志/)
})

test('Run Review renders an active Live Session with streamed text and bounded controls', () => {
  const active = run({
    status: 'running', finished_at: null, final_message: null,
    interactive: true, turn_revision: 1, thread_id: null,
  })
  const markup = scheduledRunReviewMarkup({
    job: { id: JOB_ID, title: 'Daily review' },
    runs: [active],
    selectedRun: active,
    live: {
      connection: 'connected', turnRevision: 1,
      messages: [{ itemId: 'message-1', text: 'Checking <schema>.' }],
      activities: [{ itemId: 'tool-1', label: 'Read schema', state: 'completed' }],
      draft: 'Check rollback.', submitting: false, stopping: false, controlError: '',
    },
  })

  assert.match(markup, /Live Session/)
  assert.match(markup, /Checking &lt;schema&gt;\./)
  assert.match(markup, /Read schema/)
  assert.match(markup, /data-run-review-draft/)
  assert.match(markup, /data-run-review-action="steer"/)
  assert.match(markup, /data-run-review-action="stop"/)
  assert.doesNotMatch(markup, /private-turn|已请求运行|watcher verified/)
})

test('Run Review opens execution records without auto-review and resumes using only authoritative Run ID', async () => {
  const current = shell()
  const calls = []
  let restored = 0
  const review = createScheduledRunReview({
    element: current.element,
    backdrop: current.backdrop,
    api: {
      schedule: async (id) => { calls.push(['job', id]); return { job: { id, title: 'Daily review' } } },
      scheduleRuns: async (id) => { calls.push(['runs', id]); return { runs: [run()] } },
      scheduledRun: async (id) => { calls.push(['run', id]); return { run: run() } },
      scheduledRunLog: async () => ({ content: '', truncated: false }),
      markScheduledRunReviewed: async (id) => { calls.push(['review', id]); return { run: run({ reviewed_at: '2026-08-25T03:00:00.000Z' }) } },
      resumeScheduledRun: async (id) => { calls.push(['resume', id]); return { ok: true } },
    },
    onResumed: () => undefined,
  })

  await review.open(JOB_ID, null, { trigger: { focus: () => { restored += 1 } } })
  assert.equal(current.element.hidden, false)
  assert.equal(current.backdrop.hidden, false)
  assert.deepEqual(calls, [['job', JOB_ID], ['runs', JOB_ID], ['run', RUN_ID]])
  assert.equal(calls.some(([name]) => name === 'review'), false)

  await review.resume()
  assert.deepEqual(calls.at(-1), ['resume', RUN_ID])
  review.close()
  assert.equal(restored, 1)
})

test('Run Review cancels stale log presentation when switching Runs', async () => {
  const current = shell()
  let resolveFirst
  const firstLog = new Promise((resolve) => { resolveFirst = resolve })
  const first = run()
  const second = run({ id: '33333333-3333-4333-8333-333333333333', status: 'failed' })
  const review = createScheduledRunReview({
    element: current.element,
    backdrop: current.backdrop,
    api: {
      schedule: async () => ({ job: { id: JOB_ID, title: 'Daily review' } }),
      scheduleRuns: async () => ({ runs: [first, second] }),
      scheduledRun: async (id) => ({ run: id === first.id ? first : second }),
      scheduledRunLog: async (id) => id === first.id ? firstLog : { stream: 'stdout', content: 'second', truncated: false },
      markScheduledRunReviewed: async () => ({}),
      resumeScheduledRun: async () => ({}),
    },
  })
  await review.open(JOB_ID)
  const pending = review.loadLog('stdout')
  await review.selectRun(second.id)
  await review.loadLog('stdout')
  resolveFirst({ stream: 'stdout', content: 'stale-first', truncated: false })
  await pending
  assert.match(current.element.innerHTML, /second/)
  assert.doesNotMatch(current.element.innerHTML, /stale-first/)
})

test('Run Review keeps the latest open context when older history and review requests finish late', async () => {
  const current = shell()
  const oldHistory = deferred()
  const oldReview = deferred()
  const first = run({ id: '33333333-3333-4333-8333-333333333333', job_id: 'job-a' })
  const second = run({ id: '44444444-4444-4444-8444-444444444444', job_id: 'job-b', final_message: 'newest-context' })
  const review = createScheduledRunReview({
    element: current.element,
    backdrop: current.backdrop,
    api: {
      schedule: async (id) => ({ job: { id, title: id } }),
      scheduleRuns: async (id) => id === 'job-a' ? oldHistory.promise : { runs: [second] },
      scheduledRun: async (id) => ({ run: id === first.id ? first : second }),
      scheduledRunLog: async () => ({ content: '', truncated: false }),
      markScheduledRunReviewed: async () => oldReview.promise,
      resumeScheduledRun: async () => ({}),
    },
  })

  const openingOld = review.open('job-a')
  await review.open('job-b')
  oldHistory.resolve({ runs: [first] })
  await openingOld
  assert.match(current.element.innerHTML, /newest-context/)
  assert.doesNotMatch(current.element.innerHTML, /job-a/)

  const reviewingOld = review.markReviewed()
  await review.open('job-b')
  oldReview.resolve({ run: { ...second, id: first.id, final_message: 'stale-review' } })
  await reviewingOld
  assert.match(current.element.innerHTML, /newest-context/)
  assert.doesNotMatch(current.element.innerHTML, /stale-review/)
})

test('Run Review focuses the dialog immediately and reports unavailable Clipboard honestly', async () => {
  const current = shell()
  const pending = deferred()
  const review = createScheduledRunReview({
    element: current.element,
    backdrop: current.backdrop,
    clipboard: null,
    api: {
      schedule: async () => pending.promise,
      scheduleRuns: async () => ({ runs: [] }),
      scheduledRun: async () => ({ run: run() }),
      scheduledRunLog: async () => ({ content: '', truncated: false }),
      markScheduledRunReviewed: async () => ({}),
      resumeScheduledRun: async () => ({}),
    },
  })
  const opening = review.open(JOB_ID)
  assert.equal(current.focusTarget.focusCalls, 1)
  review.close()
  pending.resolve({ job: { id: JOB_ID, title: 'ignored after close' } })
  await opening

  const ready = createScheduledRunReview({
    element: current.element,
    backdrop: current.backdrop,
    clipboard: null,
    api: {
      schedule: async () => ({ job: { id: JOB_ID, title: 'Daily review' } }),
      scheduleRuns: async () => ({ runs: [run()] }),
      scheduledRun: async () => ({ run: run() }),
      scheduledRunLog: async () => ({ content: '', truncated: false }),
      markScheduledRunReviewed: async () => ({}),
      resumeScheduledRun: async () => ({}),
    },
  })
  await ready.open(JOB_ID)
  current.listeners.get('click')({ target: { closest: () => ({ dataset: { runReviewAction: 'copy' } }) } })
  await new Promise((resolve) => setImmediate(resolve))
  assert.match(current.element.innerHTML, /复制失败/)
})

test('Run Review restores focus to the current Runs trigger after the list rerenders', async () => {
  const current = shell()
  let restored = 0
  const staleTrigger = { isConnected: false, focus: () => assert.fail('stale trigger must not be focused') }
  const currentTrigger = {
    dataset: { scheduledId: JOB_ID },
    focus: () => { restored += 1 },
  }
  const originalDocument = globalThis.document
  globalThis.document = {
    activeElement: null,
    querySelectorAll: () => [currentTrigger],
  }
  try {
    const review = createScheduledRunReview({
      element: current.element,
      backdrop: current.backdrop,
      api: {
        schedule: async () => ({ job: { id: JOB_ID, title: 'Daily review' } }),
        scheduleRuns: async () => ({ runs: [run()] }),
        scheduledRun: async () => ({ run: run() }),
        scheduledRunLog: async () => ({ content: '', truncated: false }),
        markScheduledRunReviewed: async () => ({}),
        resumeScheduledRun: async () => ({}),
      },
    })
    await review.open(JOB_ID, null, { trigger: staleTrigger })
    review.close()
    assert.equal(restored, 1)
  } finally {
    globalThis.document = originalDocument
  }
})

test('Run Review ignores delayed Clipboard feedback after another context opens', async () => {
  const current = shell()
  const copied = deferred()
  const first = run({ id: '33333333-3333-4333-8333-333333333333', job_id: 'job-a', thread_id: 'thread-a' })
  const second = run({ id: '44444444-4444-4444-8444-444444444444', job_id: 'job-b', thread_id: 'thread-b', final_message: 'context-b' })
  const review = createScheduledRunReview({
    element: current.element,
    backdrop: current.backdrop,
    clipboard: { writeText: () => copied.promise },
    api: {
      schedule: async (id) => ({ job: { id, title: id } }),
      scheduleRuns: async (id) => ({ runs: [id === 'job-a' ? first : second] }),
      scheduledRun: async (id) => ({ run: id === first.id ? first : second }),
      scheduledRunLog: async () => ({ content: '', truncated: false }),
      markScheduledRunReviewed: async () => ({}),
      resumeScheduledRun: async () => ({}),
    },
  })
  await review.open('job-a')
  current.listeners.get('click')({ target: { closest: () => ({ dataset: { runReviewAction: 'copy' } }) } })
  await review.open('job-b')
  copied.resolve()
  await new Promise((resolve) => setImmediate(resolve))
  assert.match(current.element.innerHTML, /context-b/)
  assert.doesNotMatch(current.element.innerHTML, /已复制/)
})

test('Run Review connects the selected active Run and submits guidance with its public revision', async () => {
  const current = shell()
  const streams = []
  const calls = []
  const active = run({
    status: 'running', finished_at: null, final_message: null,
    interactive: true, turn_revision: null, thread_id: null,
  })
  const review = createScheduledRunReview({
    element: current.element,
    backdrop: current.backdrop,
    createRunStream(options) {
      const stream = {
        options, connected: 0, closed: 0,
        connect() { this.connected += 1 },
        close() { this.closed += 1 },
      }
      streams.push(stream)
      return stream
    },
    api: {
      schedule: async () => ({ job: { id: JOB_ID, title: 'Daily review' } }),
      scheduleRuns: async () => ({ runs: [active] }),
      scheduledRun: async () => ({ run: active }),
      scheduledRunLog: async () => ({ content: '', truncated: false }),
      markScheduledRunReviewed: async () => ({}),
      resumeScheduledRun: async () => ({}),
      steerRun: async (id, input) => {
        calls.push(['steer', id, input])
        return { accepted: true, run_id: id, turn_revision: input.expected_turn_revision }
      },
      stopRun: async () => ({}),
    },
  })

  await review.open(JOB_ID)
  assert.equal(streams.length, 1)
  assert.equal(streams[0].connected, 1)
  streams[0].options.onState('connected')
  streams[0].options.onEvent({
    type: 'turn_started', payload: { turn_revision: 2 },
  })
  streams[0].options.onEvent({
    type: 'activity_started',
    payload: { turn_revision: 2, item_id: 'tool-1', label: 'Read schema' },
  })
  streams[0].options.onEvent({
    type: 'assistant_delta',
    payload: { turn_revision: 2, item_id: 'message-1', delta: 'Checking the schema.' },
  })
  assert.match(current.element.innerHTML, /Checking the schema\./)
  assert.ok(current.element.innerHTML.indexOf('Read schema') < current.element.innerHTML.indexOf('Checking the schema.'))

  current.listeners.get('input')({
    target: { dataset: { runReviewDraft: '' }, value: 'Inspect rollback too.' },
  })
  assert.equal(current.focusTarget.disabled, false)
  current.listeners.get('click')({
    target: { closest: () => ({ dataset: { runReviewAction: 'steer' } }) },
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(calls, [[
    'steer', RUN_ID,
    { expected_turn_revision: 2, text: 'Inspect rollback too.' },
  ]])
  assert.match(current.element.innerHTML, /data-run-review-draft[^>]*>\s*<\/textarea>/)

  review.close()
  assert.equal(streams[0].closed, 1)
})

test('Run Review reconciles one authoritative terminal Run after an SSE terminal status', async () => {
  const current = shell()
  const streams = []
  const active = run({
    status: 'running', finished_at: null, final_message: null,
    interactive: true, turn_revision: 1, thread_id: null,
  })
  const terminal = run({
    status: 'canceled', error_code: 'RUN_CANCELED',
    final_message: 'Stopped after review.', thread_id: 'thread-after-stop',
    interactive: false, turn_revision: null,
  })
  let detail = active
  let detailReads = 0
  const review = createScheduledRunReview({
    element: current.element,
    backdrop: current.backdrop,
    createRunStream(options) {
      const stream = { options, closed: 0, connect() {}, close() { this.closed += 1 } }
      streams.push(stream)
      return stream
    },
    api: {
      schedule: async () => ({ job: { id: JOB_ID, title: 'Daily review' } }),
      scheduleRuns: async () => ({ runs: [active] }),
      scheduledRun: async () => { detailReads += 1; return { run: detail } },
      scheduledRunLog: async () => ({ content: '', truncated: false }),
      markScheduledRunReviewed: async () => ({}),
      resumeScheduledRun: async () => ({}),
      steerRun: async () => ({}),
      stopRun: async () => ({}),
    },
  })

  await review.open(JOB_ID)
  detail = terminal
  streams[0].options.onEvent({ type: 'status', payload: { state: 'canceled' } })
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(detailReads, 2)
  assert.equal(streams[0].closed, 1)
  assert.match(current.element.innerHTML, /已取消/)
  assert.match(current.element.innerHTML, /Stopped after review\./)
  assert.match(current.element.innerHTML, /thread-after-stop/)
  assert.doesNotMatch(current.element.innerHTML, /运行中/)
})
