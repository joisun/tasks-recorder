import { escapeHtml } from './dashboard-state.mjs'
import { createRunEventStream } from './run-event-stream.mjs'

const LOG_TAIL_BYTES = 32 * 1024
const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'timed_out', 'canceled', 'interrupted'])

const STATUS_PRESENTATION = Object.freeze({
  queued: { label: '排队中', tone: 'pending' },
  running: { label: '运行中', tone: 'running' },
  succeeded: { label: '已成功', tone: 'success' },
  failed: { label: '失败', tone: 'danger' },
  timed_out: { label: '已超时', tone: 'danger' },
  canceled: { label: '已取消', tone: 'muted' },
  interrupted: { label: '已中断', tone: 'danger' },
})

const TRIGGER_LABELS = Object.freeze({ scheduled: 'Scheduled', manual: 'Manual', catchup: 'Catch-up' })

function safeDate(value) {
  if (typeof value !== 'string' || value.trim() === '') return null
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date : null
}

function absoluteTime(value) {
  const date = safeDate(value)
  if (!date) return '—'
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(date)
}

function relativeTime(value, now = Date.now()) {
  const date = safeDate(value)
  if (!date) return '—'
  const delta = date.getTime() - now
  const absolute = Math.abs(delta)
  const formatter = new Intl.RelativeTimeFormat('zh-CN', { numeric: 'auto' })
  if (absolute < 60_000) return formatter.format(Math.round(delta / 1_000), 'second')
  if (absolute < 3_600_000) return formatter.format(Math.round(delta / 60_000), 'minute')
  if (absolute < 86_400_000) return formatter.format(Math.round(delta / 3_600_000), 'hour')
  return formatter.format(Math.round(delta / 86_400_000), 'day')
}

function runSort(left, right) {
  const leftTime = safeDate(left.finished_at ?? left.started_at ?? left.requested_at ?? left.created_at)?.getTime() ?? 0
  const rightTime = safeDate(right.finished_at ?? right.started_at ?? right.requested_at ?? right.created_at)?.getTime() ?? 0
  return rightTime - leftTime || String(right.id ?? '').localeCompare(String(left.id ?? ''))
}

function focusableElements(element) {
  return [...element.querySelectorAll('button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])')]
    .filter((candidate) => !candidate.closest('[hidden]'))
}

function applyLiveEvent(live, event) {
  if (!event || typeof event !== 'object') return
  if (event.type === 'turn_started' && Number.isSafeInteger(event.payload?.turn_revision)) {
    live.turnRevision = event.payload.turn_revision
    live.controlError = ''
    return
  }
  if (event.type === 'assistant_delta') {
    const itemId = event.payload?.item_id
    const delta = event.payload?.delta
    if (typeof itemId !== 'string' || typeof delta !== 'string') return
    let message = live.entries.find((candidate) => candidate.kind === 'message' && candidate.itemId === itemId)
    if (!message) {
      message = { kind: 'message', itemId, text: '' }
      live.entries.push(message)
    }
    message.text = `${message.text}${delta}`.slice(-64 * 1024)
    return
  }
  if (['activity_started', 'activity_completed'].includes(event.type)) {
    const itemId = event.payload?.item_id
    if (typeof itemId !== 'string') return
    let activity = live.entries.find((candidate) => candidate.kind === 'activity' && candidate.itemId === itemId)
    if (!activity) {
      activity = { kind: 'activity', itemId, label: event.payload?.label || 'Agent activity', state: 'running' }
      live.entries.push(activity)
    }
    if (typeof event.payload?.label === 'string') activity.label = event.payload.label
    activity.state = event.type === 'activity_completed'
      ? (event.payload?.state || 'completed')
      : 'running'
    return
  }
  if (event.type === 'intervention_accepted') live.controlError = ''
}

function controlErrorMessage(error) {
  if (error?.code === 'TURN_CHANGED') return '当前 Turn 已变化，请基于最新消息重新发送。'
  if (error?.code === 'TURN_NOT_STEERABLE') return 'Agent 当前阶段暂不接受追加指令，请稍后重试。'
  if (error?.code === 'RUN_NOT_ACTIVE') return '这个 Run 已结束，后续对话请使用 Terminal Resume。'
  if (error?.code === 'RUNTIME_PROTOCOL_UNAVAILABLE') return '当前 Codex 版本不支持 Live Session protocol。'
  return error?.message || '追加指令失败，请重试。'
}

export function runStatusPresentation(status) {
  return STATUS_PRESENTATION[status] ?? { label: '状态未知', tone: 'muted' }
}

export function runDuration(run) {
  const started = safeDate(run?.started_at)
  const finished = safeDate(run?.finished_at)
  if (!started || !finished || finished < started) return '—'
  let seconds = Math.floor((finished.getTime() - started.getTime()) / 1_000)
  const hours = Math.floor(seconds / 3_600)
  seconds -= hours * 3_600
  const minutes = Math.floor(seconds / 60)
  seconds -= minutes * 60
  return [hours ? `${hours}h` : '', minutes ? `${minutes}m` : '', `${seconds}s`].filter(Boolean).join(' ')
}

function shortSession(value) {
  if (typeof value !== 'string') return ''
  return value.length > 18 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value
}

function outputsSummary(run) {
  const changes = Array.isArray(run?.file_changes) ? run.file_changes : []
  if (changes.length === 0) return '<span class="scheduled-run-empty-cell">—</span>'
  const first = changes[0]?.path || 'output'
  return `<span class="scheduled-run-output-summary" title="${escapeHtml(changes.map(({ path }) => path).join('\n'))}"><code>${escapeHtml(first)}</code>${changes.length > 1 ? `<small>+${changes.length - 1}</small>` : ''}</span>`
}

function sessionIdentity(run, { busy = false, copyFeedback = null } = {}) {
  if (!run?.thread_id) return '<span class="scheduled-run-empty-cell">—</span>'
  const copied = copyFeedback?.runId === run.id ? copyFeedback.status : null
  return `<div class="scheduled-run-session"><code title="${escapeHtml(run.thread_id)}">${escapeHtml(shortSession(run.thread_id))}</code><button type="button" data-run-review-action="copy" data-run-id="${escapeHtml(run.id)}" aria-label="复制 Session ID"${busy ? ' disabled' : ''}>${copied === 'copied' ? '已复制' : (copied === 'error' ? '复制失败' : '复制')}</button></div>`
}

function executionRow(record, selectedId, options) {
  const status = runStatusPresentation(record.status)
  const time = record.started_at ?? record.created_at
  const duration = runDuration(record)
  const trigger = TRIGGER_LABELS[record.trigger] ?? record.trigger ?? 'Unknown'
  const resumed = options.resumeFeedback?.runId === record.id ? options.resumeFeedback.status : null
  const statusContent = `<span class="scheduled-run-state is-${escapeHtml(status.tone)}"><span${['queued', 'running'].includes(record.status) ? ' class="is-loading"' : ''} aria-hidden="true"></span><strong>${escapeHtml(status.label)}</strong></span>${record.error_code ? `<code class="scheduled-run-error-code">${escapeHtml(record.error_code)}</code>` : ''}`
  return `<tr class="scheduled-run-record${record.id === selectedId ? ' is-selected' : ''}" data-run-record="${escapeHtml(record.id)}"><td data-label="状态"><button type="button" data-run-review-action="select" data-run-id="${escapeHtml(record.id)}" aria-expanded="${record.id === selectedId}">${statusContent}</button></td><td data-label="开始"><time datetime="${escapeHtml(time || '')}" title="${escapeHtml(absoluteTime(time))}">${escapeHtml(relativeTime(time))}</time></td><td data-label="耗时">${escapeHtml(duration)}</td><td data-label="触发">${escapeHtml(trigger)}</td><td data-label="产出">${outputsSummary(record)}</td><td data-label="Session">${sessionIdentity(record, options)}</td><td data-label="操作">${!record.thread_id ? '<span class="scheduled-run-empty-cell">—</span>' : `<button class="scheduled-run-resume" type="button" data-run-review-action="resume" data-run-id="${escapeHtml(record.id)}" aria-label="在 Terminal 召回 Session"${options.busy ? ' disabled' : ''}>${resumed === 'opened' ? '已打开' : '打开'}</button>`}</td></tr>`
}

function logMarkup(run, log, loading) {
  if (!run?.has_stdout_log && !run?.has_stderr_log) {
    return '<div class="scheduled-run-log-empty">这个 Run 没有可用日志。</div>'
  }
  const stream = log?.stream ?? null
  const content = loading
    ? '正在读取日志…'
    : (log ? (log.content || '日志为空') : '选择 stdout 或 stderr 查看日志')
  return `<section class="scheduled-run-logs" aria-labelledby="scheduled-run-logs-title"><div class="scheduled-run-section-heading"><h3 id="scheduled-run-logs-title">Logs</h3><span>最多读取 32 KiB tail</span></div><div class="scheduled-run-log-tabs" role="tablist" aria-label="Run logs">${run.has_stdout_log ? `<button type="button" role="tab" aria-selected="${stream === 'stdout'}" data-run-review-action="log" data-log-stream="stdout">stdout</button>` : ''}${run.has_stderr_log ? `<button type="button" role="tab" aria-selected="${stream === 'stderr'}" data-run-review-action="log" data-log-stream="stderr">stderr</button>` : ''}</div><pre class="scheduled-run-log" aria-busy="${loading}">${escapeHtml(content)}</pre>${log?.truncated ? '<p class="scheduled-run-log-note">日志已截断，仅显示末尾内容。</p>' : ''}${log?.error ? `<p class="scheduled-run-log-error" role="alert">${escapeHtml(log.error)}</p>` : ''}</section>`
}

function liveSessionMarkup(run, live) {
  if (!run?.interactive || !['queued', 'running'].includes(run.status) || !live) return ''
  const legacy = [
    ...(Array.isArray(live.messages) ? live.messages.map((entry) => ({ ...entry, kind: 'message' })) : []),
    ...(Array.isArray(live.activities) ? live.activities.map((entry) => ({ ...entry, kind: 'activity' })) : []),
  ]
  const entries = Array.isArray(live.entries) ? live.entries : legacy
  const stream = entries.map((entry) => entry.kind === 'message'
    ? `<div class="scheduled-live-message" data-live-message="${escapeHtml(entry.itemId)}">${escapeHtml(entry.text)}</div>`
    : `<div class="scheduled-live-activity is-${escapeHtml(entry.state)}" data-live-activity="${escapeHtml(entry.itemId)}"><span aria-hidden="true"></span><strong>${escapeHtml(entry.label)}</strong></div>`).join('') || '<div class="scheduled-live-empty">等待 Agent 消息…</div>'
  const connected = live.connection === 'connected'
  const canSteer = connected && Number.isSafeInteger(live.turnRevision)
    && live.turnRevision > 0 && !live.submitting && String(live.draft ?? '').trim() !== ''
  const canStop = Number.isSafeInteger(live.turnRevision) && live.turnRevision > 0 && !live.stopping
  return `<section class="scheduled-live-session" aria-label="Live Session"><div class="scheduled-live-head"><h3>Live Session</h3><span class="is-${escapeHtml(live.connection || 'idle')}">${connected ? '已连接' : (live.connection === 'disconnected' ? '正在重连' : '连接中')}</span></div><div class="scheduled-live-stream" role="log" aria-live="off">${stream}</div><div class="scheduled-live-composer"><label for="scheduled-live-draft">追加指令</label><textarea id="scheduled-live-draft" data-run-review-draft rows="3" placeholder="补充约束或修正当前方向…"${canSteer ? '' : (live.submitting ? ' disabled' : '')}>${escapeHtml(live.draft ?? '')}</textarea>${live.controlError ? `<p class="scheduled-live-error" role="alert">${escapeHtml(live.controlError)}</p>` : ''}<div><span>⌘/Ctrl + Enter 发送</span><button type="button" data-run-review-action="stop"${canStop ? '' : ' disabled'}>${live.stopping ? '停止中…' : '停止'}</button><button type="button" data-run-review-action="steer"${canSteer ? '' : ' disabled'}>${live.submitting ? '发送中…' : '发送'}</button></div></div></section>`
}

function detailMarkup(run, { log = null, logLoading = false, busy = false, live = null } = {}) {
  if (!run) return '<div class="scheduled-run-empty"><strong>还没有 Run</strong><span>运行记录会在首次触发后出现在这里。</span></div>'
  const status = runStatusPresentation(run.status)
  const terminal = TERMINAL_STATUSES.has(run.status)
  const unread = terminal && !run.reviewed_at
  const changes = Array.isArray(run.file_changes) ? run.file_changes : []
  const outputs = changes.length ? `<section class="scheduled-run-outputs"><h3>产出文件</h3><ul>${changes.map((change) => `<li><span class="is-${escapeHtml(change.kind)}">${escapeHtml(change.kind)}</span><code>${escapeHtml(change.path)}</code></li>`).join('')}</ul></section>` : ''
  return `<article class="scheduled-run-detail" data-selected-run="${escapeHtml(run.id)}"><div class="scheduled-run-detail-head"><div><span>${escapeHtml(status.label)}</span><span>${escapeHtml(TRIGGER_LABELS[run.trigger] ?? run.trigger ?? 'Unknown')}</span><span>${escapeHtml(runDuration(run))}</span></div>${unread ? `<button type="button" data-run-review-action="review"${busy ? ' disabled' : ''}>标为已读</button>` : ''}</div>${liveSessionMarkup(run, live)}${outputs}<section class="scheduled-run-result" aria-labelledby="scheduled-run-result-title"><div class="scheduled-run-section-heading"><h3 id="scheduled-run-result-title">执行摘要</h3>${run.reviewed_at ? '<span>已读</span>' : ''}</div>${run.final_message ? `<div class="scheduled-run-final-message">${escapeHtml(run.final_message)}</div>` : '<div class="scheduled-run-no-result">没有 final message。</div>'}</section>${logMarkup(run, log, logLoading)}</article>`
}

export function scheduledRunReviewMarkup({
  state = 'ready', job = null, runs = [], selectedRun = null, log = null, logLoading = false, busy = false, message = '', copyFeedback = null, resumeFeedback = null, live = null,
} = {}) {
  const orderedRuns = [...(Array.isArray(runs) ? runs : [])].sort(runSort)
  const records = orderedRuns
  const title = job?.title || 'Scheduled Run Review'
  const rows = records.map((record) => {
    const row = executionRow(record, selectedRun?.id, { busy, copyFeedback, resumeFeedback })
    return row + (record.id === selectedRun?.id ? `<tr class="scheduled-run-record-detail"><td colspan="7">${detailMarkup(selectedRun, { log, logLoading, busy, live })}</td></tr>` : '')
  }).join('')
  const body = state === 'loading'
    ? '<div class="scheduled-run-loading" role="status" aria-busy="true">正在读取执行记录…</div>'
    : (state === 'error'
        ? `<div class="scheduled-run-loading is-error" role="alert">${escapeHtml(message || '执行记录暂不可用')}</div>`
        : (records.length === 0 ? '<div class="scheduled-run-loading">还没有执行记录</div>' : `<div class="scheduled-run-table-wrap"><table class="scheduled-run-table"><thead><tr><th>状态</th><th>开始</th><th>耗时</th><th>触发</th><th>产出</th><th>Session</th><th>操作</th></tr></thead><tbody>${rows}</tbody></table></div>`))
  return `<section class="scheduled-run-review-shell" data-run-review-state="${escapeHtml(state)}" aria-busy="${state === 'loading'}"><header class="scheduled-run-review-header"><div><h2 id="scheduled-run-review-title">${escapeHtml(title)}</h2><p>${records.length} 条执行记录</p></div><button class="scheduled-run-review-close" type="button" data-run-review-action="close" aria-label="关闭执行记录">×</button></header>${message && state !== 'error' ? `<div class="scheduled-run-inline-error" role="alert">${escapeHtml(message)}</div>` : ''}${body}</section>`
}

export function createScheduledRunReview({
  element,
  backdrop,
  api,
  clipboard = globalThis.navigator?.clipboard,
  onResumed = () => undefined,
  onReviewed = () => undefined,
  onMessage = () => undefined,
  createRunStream = createRunEventStream,
} = {}) {
  if (!element?.addEventListener || !backdrop?.addEventListener) throw new TypeError('element and backdrop are required')
  for (const method of ['schedule', 'scheduleRuns', 'scheduledRun', 'scheduledRunLog', 'markScheduledRunReviewed', 'resumeScheduledRun']) {
    if (typeof api?.[method] !== 'function') throw new TypeError(`api.${method} is required`)
  }

  const state = {
    open: false, destroyed: false, mode: 'ready', message: '', jobId: null, job: null, runs: [], selectedRun: null,
    log: null, logLoading: false, busy: false, origin: null, loadGeneration: 0, contextGeneration: 0,
    copyFeedback: null, resumeFeedback: null,
    live: null, liveStream: null,
  }

  function focusedAction() {
    const active = globalThis.document?.activeElement
    if (!state.open || !active || typeof element.contains !== 'function' || !element.contains(active)) return null
    if (active.dataset && Object.hasOwn(active.dataset, 'runReviewDraft')) {
      return {
        action: 'draft', runId: null, logStream: null,
        selectionStart: active.selectionStart ?? null,
        selectionEnd: active.selectionEnd ?? null,
      }
    }
    const action = active.closest?.('[data-run-review-action]')
    if (!action) return { action: 'close', runId: null, logStream: null }
    return {
      action: action.dataset.runReviewAction ?? null,
      runId: action.dataset.runId ?? null,
      logStream: action.dataset.logStream ?? null,
    }
  }

  function restoreFocusedAction(identity) {
    if (!identity) return
    if (identity.action === 'draft') {
      const draft = element.querySelector('[data-run-review-draft]')
      draft?.focus?.({ preventScroll: true })
      if (typeof draft?.setSelectionRange === 'function'
        && Number.isInteger(identity.selectionStart) && Number.isInteger(identity.selectionEnd)) {
        draft.setSelectionRange(identity.selectionStart, identity.selectionEnd)
      }
      return
    }
    const target = [...element.querySelectorAll('[data-run-review-action]')].find((candidate) => (
      candidate.dataset.runReviewAction === identity.action
      && (candidate.dataset.runId ?? null) === identity.runId
      && (candidate.dataset.logStream ?? null) === identity.logStream
      && !candidate.disabled
    )) ?? element.querySelector('[data-run-review-action="close"]')
    target?.focus?.({ preventScroll: true })
  }

  function render() {
    if (state.destroyed) return
    const focusIdentity = focusedAction()
    element.innerHTML = scheduledRunReviewMarkup({
      state: state.mode, job: state.job, runs: state.runs, selectedRun: state.selectedRun,
      log: state.log, logLoading: state.logLoading, busy: state.busy, message: state.message,
      copyFeedback: state.copyFeedback, resumeFeedback: state.resumeFeedback,
      live: state.live,
    })
    restoreFocusedAction(focusIdentity)
  }

  function focusClose() {
    element.querySelector('[data-run-review-action="close"]')?.focus({ preventScroll: true })
  }

  async function selectRun(runId, { context = state.contextGeneration } = {}) {
    if (!runId) return
    closeLiveStream()
    const generation = ++state.loadGeneration
    state.log = null
    state.logLoading = false
    state.message = ''
    const fallback = state.runs.find((run) => run.id === runId) ?? null
    state.selectedRun = fallback
    render()
    try {
      const result = await api.scheduledRun(runId)
      if (context !== state.contextGeneration || generation !== state.loadGeneration || !state.open) return
      if (!result?.run) throw new TypeError('Scheduled Run response is invalid')
      state.selectedRun = result.run
      state.runs = state.runs.map((run) => run.id === result.run.id ? result.run : run)
      render()
      startLiveStream(result.run, { context, generation })
    } catch (error) {
      if (context !== state.contextGeneration || generation !== state.loadGeneration || !state.open) return
      state.message = error?.message ?? '无法读取 Run detail'
      onMessage(state.message)
      render()
    }
  }

  function closeLiveStream() {
    state.liveStream?.close?.()
    state.liveStream = null
    state.live = null
  }

  function startLiveStream(run, { context, generation }) {
    if (!run?.interactive || !['queued', 'running'].includes(run.status)) return
    state.live = {
      connection: 'connecting',
      turnRevision: Number.isSafeInteger(run.turn_revision) ? run.turn_revision : null,
      entries: [], draft: '', submitting: false, stopping: false,
      controlError: '',
    }
    const matchesContext = () => state.open && context === state.contextGeneration
      && generation === state.loadGeneration && state.selectedRun?.id === run.id
    const stream = createRunStream({
      runId: run.id,
      onState(connection) {
        if (!matchesContext() || !state.live) return
        state.live.connection = connection
        render()
      },
      onReset() {
        if (!matchesContext() || !state.live) return
        state.live.entries = []
        state.live.controlError = '实时缓冲已过期；Run 仍在执行，可查看终态摘要与日志。'
        render()
      },
      onEvent(event) {
        if (!matchesContext() || !state.live) return
        applyLiveEvent(state.live, event)
        if (event.type === 'session' && typeof event.payload?.session_id === 'string') {
          state.selectedRun = { ...state.selectedRun, thread_id: event.payload.session_id }
        }
        if (event.type === 'status' && TERMINAL_STATUSES.has(event.payload?.state)) {
          const terminalRun = {
            ...state.selectedRun,
            status: event.payload.state,
            interactive: false,
          }
          state.selectedRun = terminalRun
          state.runs = state.runs.map((candidate) => candidate.id === run.id ? terminalRun : candidate)
          closeLiveStream()
          render()
          void reconcileTerminalRun(run.id, { context, generation })
          return
        }
        render()
      },
    })
    state.liveStream = stream
    render()
    stream.connect()
  }

  async function reconcileTerminalRun(runId, { context, generation }) {
    try {
      const result = await api.scheduledRun(runId)
      if (!state.open || context !== state.contextGeneration
        || generation !== state.loadGeneration || state.selectedRun?.id !== runId) return
      if (!result?.run || !TERMINAL_STATUSES.has(result.run.status)) {
        throw new TypeError('Terminal Run response is invalid')
      }
      state.selectedRun = result.run
      state.runs = state.runs.map((candidate) => candidate.id === runId ? result.run : candidate)
      render()
    } catch (error) {
      if (!state.open || context !== state.contextGeneration
        || generation !== state.loadGeneration || state.selectedRun?.id !== runId) return
      state.message = error?.message ?? '无法刷新 Run 终态'
      onMessage(state.message)
      render()
    }
  }

  async function open(jobId, runId = null, { trigger = null } = {}) {
    const context = ++state.contextGeneration
    state.open = true
    state.jobId = jobId
    state.origin = trigger ?? globalThis.document?.activeElement ?? null
    state.mode = 'loading'
    state.message = ''
    state.job = null
    state.runs = []
    state.selectedRun = null
    state.log = null
    state.busy = false
    state.copyFeedback = null
    state.resumeFeedback = null
    ++state.loadGeneration
    element.hidden = false
    backdrop.hidden = false
    render()
    focusClose()
    try {
      const [jobResult, runsResult] = await Promise.all([api.schedule(jobId), api.scheduleRuns(jobId)])
      if (!state.open || context !== state.contextGeneration) return
      if (!jobResult?.job || !Array.isArray(runsResult?.runs)) throw new TypeError('Run history response is invalid')
      state.job = jobResult.job
      state.runs = [...runsResult.runs].sort(runSort)
      state.mode = 'ready'
      const selectedId = runId ?? state.runs[0]?.id ?? null
      render()
      if (selectedId) await selectRun(selectedId, { context })
    } catch (error) {
      if (!state.open || context !== state.contextGeneration) return
      state.mode = 'error'
      state.message = error?.message ?? '无法读取 Run history'
      onMessage(state.message)
      render()
      focusClose()
    }
  }

  function close() {
    if (!state.open) return
    state.open = false
    closeLiveStream()
    ++state.contextGeneration
    ++state.loadGeneration
    element.hidden = true
    backdrop.hidden = true
    const origin = state.origin
    const fallback = [...(globalThis.document?.querySelectorAll?.('[data-scheduled-action="review"]') ?? [])]
      .find((candidate) => candidate.dataset?.scheduledId === state.jobId) ?? null
    state.origin = null
    const target = origin?.isConnected === false ? fallback : origin
    target?.focus?.({ preventScroll: true })
  }

  async function loadLog(stream) {
    const run = state.selectedRun
    if (!run || !['stdout', 'stderr'].includes(stream)) return
    const generation = ++state.loadGeneration
    state.logLoading = true
    state.log = { stream, content: '', truncated: false }
    render()
    try {
      const result = await api.scheduledRunLog(run.id, { stream, tail: LOG_TAIL_BYTES })
      if (generation !== state.loadGeneration || state.selectedRun?.id !== run.id || !state.open) return
      state.log = {
        stream,
        content: typeof result?.content === 'string' ? result.content : '',
        truncated: result?.truncated === true,
      }
    } catch (error) {
      if (generation !== state.loadGeneration || state.selectedRun?.id !== run.id || !state.open) return
      state.log = { stream, content: '', truncated: false, error: error?.message ?? '日志读取失败' }
    } finally {
      if (generation === state.loadGeneration) {
        state.logLoading = false
        render()
      }
    }
  }

  async function markReviewed() {
    if (!state.selectedRun || state.busy) return
    const context = state.contextGeneration
    const runId = state.selectedRun.id
    state.busy = true
    render()
    try {
      const result = await api.markScheduledRunReviewed(runId)
      if (!state.open || context !== state.contextGeneration || state.selectedRun?.id !== runId) return
      if (result?.run) {
        state.selectedRun = result.run
        state.runs = state.runs.map((run) => run.id === result.run.id ? result.run : run)
      }
      state.message = ''
      onReviewed(state.selectedRun)
    } catch (error) {
      if (!state.open || context !== state.contextGeneration || state.selectedRun?.id !== runId) return
      state.message = error?.message ?? 'Mark reviewed 失败'
      onMessage(state.message)
    } finally {
      if (state.open && context === state.contextGeneration && state.selectedRun?.id === runId) {
        state.busy = false
        render()
      }
    }
  }

  async function resume(requestedRunId = state.selectedRun?.id) {
    const requestedRun = state.runs.find(({ id }) => id === requestedRunId) ?? (state.selectedRun?.id === requestedRunId ? state.selectedRun : null)
    if (!requestedRun || state.busy) return
    const context = state.contextGeneration
    const runId = requestedRun.id
    state.busy = true
    state.resumeFeedback = null
    render()
    try {
      const result = await api.resumeScheduledRun(runId)
      if (!state.open || context !== state.contextGeneration) return
      state.message = ''
      state.resumeFeedback = { runId, status: 'opened' }
      onResumed(result)
    } catch (error) {
      if (!state.open || context !== state.contextGeneration) return
      state.message = error?.message ?? '会话召回失败'
      onMessage(state.message)
    } finally {
      if (state.open && context === state.contextGeneration) {
        state.busy = false
        render()
      }
    }
  }

  async function copyThread(requestedRunId = state.selectedRun?.id) {
    const requestedRun = state.runs.find(({ id }) => id === requestedRunId) ?? (state.selectedRun?.id === requestedRunId ? state.selectedRun : null)
    const threadId = requestedRun?.thread_id
    if (!threadId) return
    const context = state.contextGeneration
    const runId = requestedRun.id
    let status
    try {
      if (typeof clipboard?.writeText !== 'function') throw new TypeError('Clipboard API unavailable')
      await clipboard.writeText(threadId)
      status = 'copied'
    } catch {
      status = 'error'
    }
    if (!state.open || context !== state.contextGeneration) return
    state.copyFeedback = { runId, status }
    render()
  }

  async function steer() {
    const run = state.selectedRun
    const live = state.live
    const text = String(live?.draft ?? '')
    if (!run || !live || live.submitting || !Number.isSafeInteger(live.turnRevision)
      || text.trim() === '' || typeof api.steerRun !== 'function') return
    const context = state.contextGeneration
    live.submitting = true
    live.controlError = ''
    render()
    try {
      await api.steerRun(run.id, {
        expected_turn_revision: live.turnRevision,
        text,
      })
      if (!state.open || context !== state.contextGeneration || state.selectedRun?.id !== run.id || !state.live) return
      state.live.draft = ''
    } catch (error) {
      if (!state.open || context !== state.contextGeneration || state.selectedRun?.id !== run.id || !state.live) return
      state.live.controlError = controlErrorMessage(error)
    } finally {
      if (state.open && context === state.contextGeneration && state.selectedRun?.id === run.id && state.live) {
        state.live.submitting = false
        render()
      }
    }
  }

  async function stop() {
    const run = state.selectedRun
    const live = state.live
    if (!run || !live || live.stopping || !Number.isSafeInteger(live.turnRevision)
      || typeof api.stopRun !== 'function') return
    const context = state.contextGeneration
    live.stopping = true
    live.controlError = ''
    render()
    try {
      await api.stopRun(run.id, { expected_turn_revision: live.turnRevision })
    } catch (error) {
      if (state.open && context === state.contextGeneration && state.selectedRun?.id === run.id && state.live) {
        state.live.controlError = controlErrorMessage(error)
        state.live.stopping = false
        render()
      }
    }
  }

  function onInput(event) {
    if (!state.live || !event.target?.dataset
      || !Object.hasOwn(event.target.dataset, 'runReviewDraft')) return
    state.live.draft = event.target.value
    const send = element.querySelector('[data-run-review-action="steer"]')
    if (send) {
      send.disabled = state.live.connection !== 'connected'
        || !Number.isSafeInteger(state.live.turnRevision)
        || state.live.turnRevision < 1
        || state.live.submitting
        || String(state.live.draft).trim() === ''
    }
  }

  function onClick(event) {
    const trigger = event.target.closest?.('[data-run-review-action]')
    if (!trigger) return
    const action = trigger.dataset.runReviewAction
    if (action === 'close') close()
    else if (action === 'select') void selectRun(trigger.dataset.runId)
    else if (action === 'log') void loadLog(trigger.dataset.logStream)
    else if (action === 'review') void markReviewed()
    else if (action === 'resume') void resume(trigger.dataset.runId)
    else if (action === 'copy') void copyThread(trigger.dataset.runId)
    else if (action === 'steer') void steer()
    else if (action === 'stop') void stop()
  }

  function onKeydown(event) {
    if (!state.open) return
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)
      && event.target?.dataset && Object.hasOwn(event.target.dataset, 'runReviewDraft')) {
      event.preventDefault()
      void steer()
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      close()
      return
    }
    if (event.key !== 'Tab') return
    const focusable = focusableElements(element)
    if (focusable.length === 0) return
    const first = focusable[0]
    const last = focusable.at(-1)
    if (event.shiftKey && globalThis.document?.activeElement === first) {
      event.preventDefault(); last.focus()
    } else if (!event.shiftKey && globalThis.document?.activeElement === last) {
      event.preventDefault(); first.focus()
    }
  }

  element.addEventListener('click', onClick)
  element.addEventListener('input', onInput)
  element.addEventListener('keydown', onKeydown)
  backdrop.addEventListener('click', close)
  render()

  function destroy() {
    if (state.destroyed) return
    close()
    state.destroyed = true
    element.removeEventListener('click', onClick)
    element.removeEventListener('input', onInput)
    element.removeEventListener('keydown', onKeydown)
    backdrop.removeEventListener('click', close)
    element.innerHTML = ''
  }

  return {
    open, close, selectRun, loadLog, markReviewed, resume, steer, stop, destroy,
    refresh: () => state.job?.id ? open(state.job.id, state.selectedRun?.id, { trigger: state.origin }) : undefined,
    isOpen: () => state.open,
  }
}
