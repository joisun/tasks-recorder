import { escapeHtml } from './dashboard-state.mjs'

const CADENCE_KINDS = new Set(['once', 'hourly', 'daily', 'weekly', 'monthly'])
const SANDBOX_MODES = new Set(['read-only', 'workspace-write', 'danger-full-access'])
const MODEL_SLUG = /^[a-z0-9][a-z0-9._-]{0,127}$/
const REASONING_LEVEL = /^[a-z][a-z0-9_-]{0,15}$/
const AGENT_ID = /^[a-z][a-z0-9-]{0,63}$/
const WEEKDAYS = [
  [1, 'Mon'], [2, 'Tue'], [3, 'Wed'], [4, 'Thu'], [5, 'Fri'], [6, 'Sat'], [7, 'Sun'],
]

function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function boundedText(value, name, limit) {
  const normalized = text(value)
  if (!normalized) throw new TypeError(`${name} is required`)
  if (normalized.length > limit) throw new TypeError(`${name} must be at most ${limit} characters`)
  return normalized
}

function safeModelSlug(value) {
  const normalized = text(value)
  return MODEL_SLUG.test(normalized) ? normalized : ''
}

function safeReasoningLevel(value) {
  const normalized = text(value)
  return REASONING_LEVEL.test(normalized) ? normalized : ''
}

function normalizeModelCatalog(value) {
  if (!Array.isArray(value) || value.length > 100) throw new TypeError('Runtime model catalog response is invalid')
  const seen = new Set()
  return value.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new TypeError('Runtime model catalog response is invalid')
    const slug = safeModelSlug(item.id ?? item.slug)
    const displayName = text(item.displayName ?? item.display_name ?? slug)
    const description = text(item.description)
    const sourceLevels = item.reasoningLevels ?? item.supported_reasoning_levels ?? []
    if (!slug || seen.has(slug) || !displayName || displayName.length > 128
      || description.length > 512
      || !Array.isArray(sourceLevels)
      || sourceLevels.length > 16) {
      throw new TypeError('Runtime model catalog response is invalid')
    }
    seen.add(slug)
    const levels = sourceLevels.map(safeReasoningLevel)
    if (levels.some((level) => !level) || new Set(levels).size !== levels.length) {
      throw new TypeError('Runtime model catalog response is invalid')
    }
    const defaultReasoning = safeReasoningLevel(item.defaultReasoningLevel ?? item.default_reasoning_level)
    if (defaultReasoning && !levels.includes(defaultReasoning)) throw new TypeError('Runtime model catalog response is invalid')
    return {
      slug,
      display_name: displayName,
      description,
      default_reasoning_level: defaultReasoning,
      supported_reasoning_levels: levels,
    }
  })
}

function normalizeRuntimes(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) {
    throw new TypeError('Runtime registry response is invalid')
  }
  const seen = new Set()
  return value.map((runtime) => {
    const id = text(runtime?.id)
    const displayName = text(runtime?.display_name ?? runtime?.displayName ?? id)
    if (!AGENT_ID.test(id) || seen.has(id) || !displayName || displayName.length > 128) {
      throw new TypeError('Runtime registry response is invalid')
    }
    seen.add(id)
    return { ...runtime, id, display_name: displayName }
  })
}

function integer(value, name, minimum, maximum) {
  const normalized = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value
  if (!Number.isSafeInteger(normalized) || normalized < minimum || normalized > maximum) {
    throw new TypeError(`${name} must be an integer from ${minimum} to ${maximum}`)
  }
  return normalized
}

function normalizedWeekdays(value) {
  if (!Array.isArray(value)) return []
  return [...new Set(value.map((day) => Number(day)).filter((day) => Number.isInteger(day) && day >= 1 && day <= 7))]
    .sort((left, right) => left - right)
}

function dateTimeLocal(value) {
  if (!value) return ''
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return ''
  const pad = (part) => String(part).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function onceInstant(value) {
  const source = text(value)
  if (!source) throw new TypeError('once at is required')
  const date = new Date(source)
  if (!Number.isFinite(date.getTime())) throw new TypeError('once at must be a valid local date and time')
  return date.toISOString()
}

function selectedOption(value, expected) {
  return value === expected ? ' selected' : ''
}

function focusableElements(element) {
  return [...element.querySelectorAll('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex="-1"])')]
    .filter((candidate) => !candidate.closest('[hidden]'))
}

export function revealFirstInvalidField(event, scheduleFrame = (callback) => requestAnimationFrame(callback)) {
  const control = event?.target
  const form = control?.form ?? control?.closest?.('form')
  if (!form || form.querySelector?.(':invalid') !== control) return false
  const field = control.closest?.('.schedule-editor-field')
  if (typeof field?.scrollIntoView !== 'function') return false
  scheduleFrame(() => field.scrollIntoView({ block: 'center', inline: 'nearest' }))
  return true
}

function systemTimezoneLabel() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'System'
  } catch {
    return 'System'
  }
}

function editorError(error) {
  if (error?.code === 'SCHEDULE_VERSION_CONFLICT') {
    return 'Schedule 已在其他位置更新；你的输入已保留，请检查后重新保存。'
  }
  return error?.message || 'Schedule 保存失败'
}

function defaultDraft() {
  return {
    title: '',
    prompt: '',
    workspace: '',
    agent: 'codex',
    cadenceKind: 'daily',
    onceAt: '',
    minute: '0',
    hour: '9',
    weekdays: [1],
    day: '1',
    sandbox_mode: 'read-only',
    dangerConfirmed: false,
    model: '',
    reasoning_effort: '',
    timeout_seconds: '7200',
  }
}

export function normalizeDraft(input = {}) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const cadence = source.cadence && typeof source.cadence === 'object' && !Array.isArray(source.cadence)
    ? source.cadence
    : {}
  const cadenceKind = CADENCE_KINDS.has(cadence.kind ?? source.cadenceKind)
    ? (cadence.kind ?? source.cadenceKind)
    : 'daily'
  const minute = Number.isInteger(cadence.minute) ? cadence.minute : Number(source.minute)
  const hour = Number.isInteger(cadence.hour) ? cadence.hour : Number(source.hour)
  const day = Number.isInteger(cadence.day) ? cadence.day : Number(source.day)
  const timeout = Number.isSafeInteger(source.timeout_seconds) ? source.timeout_seconds : Number(source.timeout_seconds)
  const model = safeModelSlug(source.model)
  const reasoning = safeReasoningLevel(source.reasoning_effort)
  return {
    ...defaultDraft(),
    title: text(source.title),
    prompt: text(source.prompt),
    workspace: text(source.workspace),
    agent: AGENT_ID.test(text(source.agent)) ? text(source.agent) : 'codex',
    cadenceKind,
    onceAt: dateTimeLocal(cadence.at ?? source.onceAt),
    minute: String(Number.isInteger(minute) && minute >= 0 && minute <= 59 ? minute : 0),
    hour: String(Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : 9),
    weekdays: normalizedWeekdays(cadence.weekdays ?? source.weekdays).length
      ? normalizedWeekdays(cadence.weekdays ?? source.weekdays)
      : [1],
    day: String(Number.isInteger(day) && day >= 1 && day <= 31 ? day : 1),
    sandbox_mode: SANDBOX_MODES.has(source.sandbox_mode) ? source.sandbox_mode : 'read-only',
    dangerConfirmed: source.dangerConfirmed === true,
    model,
    reasoning_effort: reasoning,
    timeout_seconds: String(Number.isSafeInteger(timeout) && timeout >= 60 && timeout <= 86400 ? timeout : 7200),
  }
}

export function cadenceVisibility(kind) {
  const selected = CADENCE_KINDS.has(kind) ? kind : 'daily'
  return {
    once: selected === 'once',
    hourly: selected === 'hourly',
    daily: selected === 'daily',
    weekly: selected === 'weekly',
    monthly: selected === 'monthly',
    time: ['daily', 'weekly', 'monthly'].includes(selected),
  }
}

export function draftToPayload(draft = {}, { modelCatalog = [] } = {}) {
  const source = draft && typeof draft === 'object' && !Array.isArray(draft) ? draft : {}
  const kind = CADENCE_KINDS.has(source.cadenceKind) ? source.cadenceKind : null
  if (!kind) throw new TypeError('cadence kind is invalid')
  const sandboxMode = source.sandbox_mode
  if (!SANDBOX_MODES.has(sandboxMode)) throw new TypeError('sandbox_mode is invalid')
  if (sandboxMode === 'danger-full-access' && source.dangerConfirmed !== true) {
    throw new TypeError('danger-full-access requires explicit confirmation')
  }

  let cadence
  if (kind === 'once') {
    cadence = { kind, at: onceInstant(source.onceAt), timezone_mode: 'system' }
  } else if (kind === 'hourly') {
    cadence = { kind, minute: integer(source.minute, 'minute', 0, 59), timezone_mode: 'system' }
  } else {
    cadence = {
      kind,
      hour: integer(source.hour, 'hour', 0, 23),
      minute: integer(source.minute, 'minute', 0, 59),
      timezone_mode: 'system',
    }
    if (kind === 'weekly') {
      const weekdays = normalizedWeekdays(source.weekdays)
      if (!weekdays.length) throw new TypeError('weekdays must not be empty')
      cadence.weekdays = weekdays
    }
    if (kind === 'monthly') cadence.day = integer(source.day, 'day', 1, 31)
  }

  const model = text(source.model)
  const reasoningEffort = text(source.reasoning_effort)
  if (model && !MODEL_SLUG.test(model)) throw new TypeError('model is invalid')
  if (reasoningEffort && !REASONING_LEVEL.test(reasoningEffort)) throw new TypeError('reasoning_effort is invalid')
  const models = normalizeModelCatalog(modelCatalog)
  if (models.length > 0) {
    const selected = model ? models.find((item) => item.slug === model) : null
    if (model && !selected) throw new TypeError('model is not available in Codex')
    const reasoningSupported = !reasoningEffort || (selected
      ? selected.supported_reasoning_levels.includes(reasoningEffort)
      : models.some((item) => item.supported_reasoning_levels.includes(reasoningEffort)))
    if (!reasoningSupported) throw new TypeError('reasoning_effort is not supported by the selected model')
  }
  return {
    title: boundedText(source.title, 'title', 200),
    prompt: boundedText(source.prompt, 'prompt', 20_000),
    workspace: boundedText(source.workspace, 'workspace', 4_096),
    agent: AGENT_ID.test(text(source.agent)) ? text(source.agent) : 'codex',
    cadence,
    sandbox_mode: sandboxMode,
    model: model || null,
    reasoning_effort: reasoningEffort || null,
    timeout_seconds: integer(source.timeout_seconds, 'timeout_seconds', 60, 86_400),
  }
}

function cadenceControls(draft, disabled) {
  const visibility = cadenceVisibility(draft.cadenceKind)
  const unavailable = disabled ? ' disabled' : ''
  const kindOptions = [
    ['once', 'Once'], ['hourly', 'Hourly'], ['daily', 'Daily'], ['weekly', 'Weekly'], ['monthly', 'Monthly'],
  ].map(([value, label]) => `<option value="${value}"${selectedOption(draft.cadenceKind, value)}>${label}</option>`).join('')
  const clock = `<div class="schedule-editor-time"${visibility.time ? '' : ' hidden'}>
    <label><span>Hour</span><input name="hour" type="number" min="0" max="23" value="${escapeHtml(draft.hour)}"${unavailable}></label>
    <label><span>Minute</span><input name="minute" type="number" min="0" max="59" value="${escapeHtml(draft.minute)}"${unavailable}></label>
  </div>`
  const weekdays = WEEKDAYS.map(([day, label]) => `<label class="schedule-editor-weekday"><input name="weekdays" type="checkbox" value="${day}"${draft.weekdays.includes(day) ? ' checked' : ''}${unavailable}><span>${label}</span></label>`).join('')
  return `<section class="schedule-editor-group" aria-labelledby="schedule-editor-cadence-title">
    <div class="schedule-editor-group-heading"><div><h3 id="schedule-editor-cadence-title">When to run</h3></div><span class="schedule-editor-timezone">System timezone · ${escapeHtml(systemTimezoneLabel())}</span></div>
    <label class="schedule-editor-field"><span>Repeat</span><select name="cadenceKind"${unavailable}>${kindOptions}</select></label>
    <label class="schedule-editor-field"${visibility.once ? '' : ' hidden'}><span>Date and time</span><input name="onceAt" type="datetime-local" value="${escapeHtml(draft.onceAt)}"${unavailable}></label>
    <label class="schedule-editor-field"${visibility.hourly ? '' : ' hidden'}><span>Minute past each hour</span><input name="minute" type="number" min="0" max="59" value="${escapeHtml(draft.minute)}"${unavailable}></label>
    ${clock}
    <div class="schedule-editor-weekdays"${visibility.weekly ? '' : ' hidden'} role="group" aria-label="Weekly days">${weekdays}</div>
    <label class="schedule-editor-field"${visibility.monthly ? '' : ' hidden'}><span>Day of month</span><input name="day" type="number" min="1" max="31" value="${escapeHtml(draft.day)}"${unavailable}></label>
    <p class="schedule-editor-note">保存后由本机 Scheduler 计算下次触发时间。</p>
  </section>`
}

function sandboxControls(draft, disabled, modelCatalog, modelCatalogState, runtimes) {
  const unavailable = disabled ? ' disabled' : ''
  const workspaceWrite = draft.sandbox_mode === 'workspace-write'
  const danger = draft.sandbox_mode === 'danger-full-access'
  const models = normalizeModelCatalog(modelCatalog)
  const selectedModel = models.find((item) => item.slug === draft.model) ?? null
  const modelMissing = draft.model && !selectedModel
  const reasoningLevels = selectedModel
    ? selectedModel.supported_reasoning_levels
    : [...new Set(models.flatMap((item) => item.supported_reasoning_levels))]
  const reasoningMissing = draft.reasoning_effort && !reasoningLevels.includes(draft.reasoning_effort)
  const catalogUnavailable = modelCatalogState !== 'ready'
  const catalogControlUnavailable = disabled || catalogUnavailable ? ' disabled' : ''
  const modelOptions = models.map((model) => (
    `<option value="${escapeHtml(model.slug)}"${selectedOption(draft.model, model.slug)}>${escapeHtml(model.display_name)} · ${escapeHtml(model.slug)}</option>`
  )).join('')
  const reasoningOptions = reasoningLevels.map((effort) => (
    `<option value="${escapeHtml(effort)}"${selectedOption(draft.reasoning_effort, effort)}>${escapeHtml(effort)}</option>`
  )).join('')
  const runtimeOptions = runtimes.map((runtime) => (
    `<option value="${escapeHtml(runtime.id)}"${selectedOption(draft.agent, runtime.id)}>${escapeHtml(runtime.display_name ?? runtime.displayName ?? runtime.id)}</option>`
  )).join('')
  const catalogNote = modelCatalogState === 'loading'
    ? '正在读取本机 runtime model catalog…'
    : (modelCatalogState === 'error'
        ? '当前 runtime 的 model catalog 不可用；仍可使用 CLI default。'
        : (selectedModel?.description ?? 'Model 与 Reasoning 选项来自本机 Agent CLI。'))
  return `<section class="schedule-editor-group" aria-labelledby="schedule-editor-runtime-title">
    <div class="schedule-editor-group-heading"><div><h3 id="schedule-editor-runtime-title">Execution safeguards</h3></div></div>
    <label class="schedule-editor-field"><span>Agent</span><select name="agent"${unavailable}>${runtimeOptions}</select></label>
    <label class="schedule-editor-field"><span>Sandbox</span><select name="sandbox_mode"${unavailable}>
      <option value="read-only"${selectedOption(draft.sandbox_mode, 'read-only')}>read-only</option>
      <option value="workspace-write"${selectedOption(draft.sandbox_mode, 'workspace-write')}>workspace-write</option>
      <option value="danger-full-access"${selectedOption(draft.sandbox_mode, 'danger-full-access')}>danger-full-access</option>
    </select></label>
    ${workspaceWrite ? '<p class="schedule-editor-warning" role="status">workspace-write 可修改所选 Workspace 中的文件。</p>' : ''}
    ${danger ? `<label class="schedule-editor-danger"><input name="dangerConfirmed" type="checkbox"${draft.dangerConfirmed ? ' checked' : ''}${unavailable}><span>I understand that danger-full-access requires explicit confirmation.</span></label>` : ''}
    <div class="schedule-editor-advanced">
      <label class="schedule-editor-field"><span>Model</span><select name="model"${catalogControlUnavailable}><option value=""${selectedOption(draft.model, '')}>Scheduler default</option>${modelMissing ? `<option value="${escapeHtml(draft.model)}" selected>${escapeHtml(draft.model)} · unavailable</option>` : ''}${modelOptions}</select></label>
      <label class="schedule-editor-field"><span>Reasoning</span><select name="reasoning_effort"${catalogControlUnavailable}><option value=""${selectedOption(draft.reasoning_effort, '')}>Scheduler default</option>${reasoningMissing ? `<option value="${escapeHtml(draft.reasoning_effort)}" selected>${escapeHtml(draft.reasoning_effort)} · unavailable</option>` : ''}${reasoningOptions}</select></label>
      <label class="schedule-editor-field"><span>Timeout (seconds)</span><input name="timeout_seconds" type="number" min="60" max="86400" value="${escapeHtml(draft.timeout_seconds)}"${unavailable}></label>
    </div>
    <p class="schedule-editor-note" data-model-catalog-state="${escapeHtml(modelCatalogState)}">${escapeHtml(catalogNote)}</p>
  </section>`
}

export function scheduledTaskEditorMarkup({
  mode = 'create',
  state = 'ready',
  draft = defaultDraft(),
  error = '',
  modelCatalog = [],
  modelCatalogState = 'loading',
  runtimes = [{ id: 'codex', display_name: 'Codex' }],
} = {}) {
  const normalized = normalizeDraft(draft)
  const busy = state === 'loading' || state === 'saving'
  const editing = mode === 'edit'
  const message = state === 'loading'
    ? '正在读取 Schedule…'
    : (state === 'saving' ? '正在保存…' : error)
  return `<section class="schedule-editor-shell" data-schedule-editor-state="${escapeHtml(state)}" aria-busy="${busy}">
    <header class="schedule-editor-header"><div><h2 id="scheduled-task-editor-title">${editing ? 'Edit schedule' : 'Create schedule'}</h2></div><button class="schedule-editor-close" type="button" data-schedule-editor-action="close" aria-label="关闭 Schedule 编辑器">×</button></header>
    <div class="schedule-editor-message${message ? ' is-visible' : ''}${error ? ' is-error' : ''}${state === 'conflict' ? ' is-conflict' : ''}" role="${error ? 'alert' : 'status'}" aria-live="polite">${escapeHtml(message)}</div>
    <form class="schedule-editor-form" data-schedule-editor-form>
      <section class="schedule-editor-group" aria-labelledby="schedule-editor-details-title">
        <div class="schedule-editor-group-heading"><div><h3 id="schedule-editor-details-title">What should run</h3></div></div>
        <label class="schedule-editor-field"><span>Title</span><input name="title" maxlength="200" value="${escapeHtml(normalized.title)}" required${busy ? ' disabled' : ''}></label>
        <label class="schedule-editor-field"><span>Prompt</span><textarea name="prompt" rows="6" maxlength="20000" required${busy ? ' disabled' : ''}>${escapeHtml(normalized.prompt)}</textarea></label>
        <label class="schedule-editor-field"><span>Workspace</span><input name="workspace" maxlength="4096" value="${escapeHtml(normalized.workspace)}" required${busy ? ' disabled' : ''}></label>
      </section>
      ${cadenceControls(normalized, busy)}
      ${sandboxControls(normalized, busy, modelCatalog, modelCatalogState, runtimes)}
      <footer class="schedule-editor-actions">
        ${editing ? `<button class="schedule-editor-delete" type="button" data-schedule-editor-action="delete"${busy ? ' disabled' : ''}>Delete</button>` : ''}
        <span></span><button type="button" data-schedule-editor-action="close"${busy ? ' disabled' : ''}>Cancel</button><button class="schedule-editor-save" type="submit"${busy ? ' disabled' : ''}>${state === 'saving' ? 'Saving…' : 'Save schedule'}</button>
      </footer>
    </form>
  </section>`
}

export function createScheduledTaskEditor({
  element,
  backdrop,
  api,
  onSaved = async () => undefined,
  onMessage = () => undefined,
} = {}) {
  if (!element?.addEventListener || !backdrop?.addEventListener) throw new TypeError('element and backdrop are required')
  if (!api?.schedule || !api?.runtimes || !api?.runtimeModels
    || !api?.createSchedule || !api?.updateSchedule || !api?.deleteSchedule) {
    throw new TypeError('Schedule editor API is required')
  }

  const state = {
    open: false,
    mode: 'create',
    id: null,
    etag: null,
    draft: defaultDraft(),
    phase: 'ready',
    error: '',
    modelCatalog: [],
    modelCatalogState: 'loading',
    runtimes: [{ id: 'codex', display_name: 'Codex' }],
    returnFocus: null,
    requestSequence: 0,
  }

  function render() {
    if (!state.open) return
    element.innerHTML = scheduledTaskEditorMarkup({
      mode: state.mode,
      state: state.phase,
      draft: state.draft,
      error: state.error,
      modelCatalog: state.modelCatalog,
      modelCatalogState: state.modelCatalogState,
      runtimes: state.runtimes,
    })
  }

  function focus(selector) {
    element.querySelector(selector)?.focus({ preventScroll: true })
  }

  function openShell(trigger) {
    state.open = true
    state.returnFocus = trigger
    element.hidden = false
    backdrop.hidden = false
  }

  function close() {
    if (!state.open) return
    state.requestSequence += 1
    state.open = false
    element.hidden = true
    backdrop.hidden = true
    const fallback = document.querySelector('[data-scheduled-action="create"]')
    const target = state.returnFocus?.isConnected ? state.returnFocus : fallback
    target?.focus?.({ preventScroll: true })
  }

  function readDraft() {
    const form = element.querySelector('[data-schedule-editor-form]')
    if (!form) return state.draft
    const values = new FormData(form)
    return {
      ...state.draft,
      ...Object.fromEntries(values),
      weekdays: values.getAll('weekdays').map((day) => Number(day)),
      dangerConfirmed: values.get('dangerConfirmed') === 'on',
    }
  }

  function renderWithFocus(name) {
    render()
    if (name) focus(`[name="${name}"]`)
  }

  async function fetchRuntimes() {
    const response = await api.runtimes()
    return normalizeRuntimes(response?.runtimes)
  }

  async function fetchModelCatalog(agent) {
    const response = await api.runtimeModels(agent)
    return normalizeModelCatalog(response?.models)
  }

  async function openCreate({ trigger = document.activeElement } = {}) {
    const request = state.requestSequence + 1
    state.requestSequence = request
    state.mode = 'create'
    state.id = null
    state.etag = null
    state.draft = defaultDraft()
    state.phase = 'ready'
    state.error = ''
    state.modelCatalog = []
    state.modelCatalogState = 'loading'
    openShell(trigger)
    render()
    focus('[name="title"]')
    let runtimeState
    try {
      const runtimes = await fetchRuntimes()
      const agent = runtimes.some(({ id }) => id === state.draft.agent)
        ? state.draft.agent
        : runtimes[0].id
      let catalog
      try { catalog = { models: await fetchModelCatalog(agent), status: 'ready' } } catch {
        catalog = { models: [], status: 'error' }
      }
      runtimeState = { runtimes, agent, catalog }
    } catch {
      runtimeState = {
        runtimes: [{ id: 'codex', display_name: 'Codex', state: 'unavailable' }],
        agent: 'codex',
        catalog: { models: [], status: 'error' },
      }
    }
    if (state.requestSequence !== request || !state.open) return
    state.runtimes = runtimeState.runtimes
    state.draft.agent = runtimeState.agent
    state.modelCatalog = runtimeState.catalog.models
    state.modelCatalogState = runtimeState.catalog.status
    const activeField = element.querySelector(':focus')?.name
    render()
    focus(activeField ? `[name="${activeField}"]` : '[name="title"]')
  }

  async function openEdit(id, { trigger = document.activeElement } = {}) {
    const scheduleId = text(id)
    if (!scheduleId || scheduleId.length > 128) throw new TypeError('Schedule id is invalid')
    const request = state.requestSequence + 1
    state.requestSequence = request
    state.mode = 'edit'
    state.id = scheduleId
    state.etag = null
    state.draft = defaultDraft()
    state.phase = 'loading'
    state.error = ''
    state.modelCatalog = []
    state.modelCatalogState = 'loading'
    openShell(trigger)
    render()
    focus('[data-schedule-editor-action="close"]')
    try {
      const [response, runtimes] = await Promise.all([
        api.schedule(scheduleId),
        fetchRuntimes(),
      ])
      if (state.requestSequence !== request || !state.open) return
      if (!response?.job || typeof response.job !== 'object' || Array.isArray(response.job)) {
        throw new TypeError('Schedule detail response is invalid')
      }
      if (typeof response.job.etag !== 'string' || !/^[0-9a-f]{64}$/.test(response.job.etag)) {
        throw new TypeError('Schedule detail etag is invalid')
      }
      state.etag = response.job.etag
      state.draft = normalizeDraft(response.job)
      state.runtimes = runtimes
      if (!runtimes.some(({ id }) => id === state.draft.agent)) {
        state.runtimes = [
          ...runtimes,
          { id: state.draft.agent, display_name: `${state.draft.agent} · unavailable`, state: 'unavailable' },
        ]
      }
      const catalogResult = await fetchModelCatalog(state.draft.agent).then(
        (models) => ({ status: 'ready', models }),
        () => ({ status: 'error', models: [] }),
      )
      if (state.requestSequence !== request || !state.open) return
      state.modelCatalog = catalogResult.models
      state.modelCatalogState = catalogResult.status
      state.phase = 'ready'
      render()
      focus('[name="title"]')
    } catch (error) {
      if (state.requestSequence !== request || !state.open) return
      state.phase = 'error'
      state.error = error?.message || '无法读取 Schedule'
      render()
      focus('[data-schedule-editor-action="close"]')
    }
  }

  async function persist() {
    if (state.phase === 'loading' || state.phase === 'saving') return
    state.draft = readDraft()
    let payload
    try {
      payload = draftToPayload(state.draft, { modelCatalog: state.modelCatalog })
    } catch (error) {
      state.phase = 'error'
      state.error = error.message
      renderWithFocus('title')
      return
    }
    state.phase = 'saving'
    state.error = ''
    render()
    try {
      if (state.mode === 'create') await api.createSchedule(payload)
      else await api.updateSchedule(state.id, state.etag, payload)
      await onSaved()
      onMessage(state.mode === 'create' ? '已创建 Schedule' : '已保存 Schedule')
      close()
    } catch (error) {
      state.phase = error?.code === 'SCHEDULE_VERSION_CONFLICT' ? 'conflict' : 'error'
      state.error = editorError(error)
      renderWithFocus('title')
    }
  }

  async function remove() {
    if (state.mode !== 'edit' || state.phase === 'loading' || state.phase === 'saving') return
    state.phase = 'saving'
    state.error = ''
    render()
    try {
      await api.deleteSchedule(state.id, state.etag)
      await onSaved()
      onMessage('已删除 Schedule')
      close()
    } catch (error) {
      state.phase = error?.code === 'SCHEDULE_VERSION_CONFLICT' ? 'conflict' : 'error'
      state.error = editorError(error)
      render()
      focus('[data-schedule-editor-action="delete"]')
    }
  }

  function onInput(event) {
    if (!event.target.closest?.('[data-schedule-editor-form]')) return
    state.draft = readDraft()
  }

  function onChange(event) {
    if (!event.target.closest?.('[data-schedule-editor-form]')) return
    state.draft = readDraft()
    state.error = ''
    if (event.target.name === 'model') {
      const selected = state.modelCatalog.find((item) => item.slug === state.draft.model)
      if (state.draft.reasoning_effort
        && selected
        && !selected.supported_reasoning_levels.includes(state.draft.reasoning_effort)) {
        state.draft.reasoning_effort = ''
      }
    }
    if (event.target.name === 'agent') {
      state.draft.model = ''
      state.draft.reasoning_effort = ''
      state.modelCatalog = []
      state.modelCatalogState = 'loading'
      const request = ++state.requestSequence
      renderWithFocus('agent')
      void fetchModelCatalog(state.draft.agent).then(
        (models) => {
          if (!state.open || state.requestSequence !== request) return
          state.modelCatalog = models
          state.modelCatalogState = 'ready'
          renderWithFocus('agent')
        },
        () => {
          if (!state.open || state.requestSequence !== request) return
          state.modelCatalogState = 'error'
          renderWithFocus('agent')
        },
      )
      return
    }
    if (['cadenceKind', 'sandbox_mode', 'dangerConfirmed', 'model'].includes(event.target.name)) {
      renderWithFocus(event.target.name)
    }
  }

  async function onClick(event) {
    const action = event.target.closest?.('[data-schedule-editor-action]')?.dataset.scheduleEditorAction
    if (action === 'close') close()
    if (action === 'delete') await remove()
  }

  async function onSubmit(event) {
    if (!event.target.matches?.('[data-schedule-editor-form]')) return
    event.preventDefault()
    await persist()
  }

  function onKeydown(event) {
    if (event.key === 'Escape') {
      event.preventDefault()
      close()
      return
    }
    if (event.key !== 'Tab') return
    const focusable = focusableElements(element)
    if (!focusable.length) return
    const current = focusable.indexOf(document.activeElement)
    const target = event.shiftKey && current === 0
      ? focusable.at(-1)
      : (!event.shiftKey && current === focusable.length - 1 ? focusable[0] : null)
    if (!target) return
    event.preventDefault()
    target.focus({ preventScroll: true })
  }

  function onInvalid(event) {
    revealFirstInvalidField(event)
  }

  element.addEventListener('input', onInput)
  element.addEventListener('change', onChange)
  element.addEventListener('click', onClick)
  element.addEventListener('submit', onSubmit)
  element.addEventListener('keydown', onKeydown)
  element.addEventListener('invalid', onInvalid, true)
  backdrop.addEventListener('click', close)

  return {
    openCreate,
    openEdit,
    close,
    isOpen: () => state.open,
  }
}
