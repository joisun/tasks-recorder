import type {
  RuntimeModel,
  ScheduleCadence,
  ScheduleMutationInput,
  ScheduleRecord,
} from '@/lib/api/types'

const CADENCE_KINDS = new Set(['once', 'hourly', 'daily', 'weekly', 'monthly'])
const SANDBOX_MODES = new Set(['read-only', 'workspace-write', 'danger-full-access'])
const MODEL_SLUG = /^[a-z0-9][a-z0-9._-]{0,127}$/
const REASONING_LEVEL = /^[a-z][a-z0-9_-]{0,15}$/
const AGENT_ID = /^[a-z][a-z0-9-]{0,63}$/

export type CadenceKind = ScheduleCadence['kind']

export interface ScheduleDraft {
  title: string
  prompt: string
  workspace: string
  agent: string
  cadenceKind: CadenceKind
  onceAt: string
  minute: string
  hour: string
  weekdays: number[]
  day: string
  sandbox_mode: ScheduleRecord['sandbox_mode']
  dangerConfirmed: boolean
  model: string
  reasoning_effort: string
  timeout_seconds: string
}

export interface ModelOption {
  slug: string
  displayName: string
  description: string
  defaultReasoning: string
  reasoningLevels: string[]
}

function text(value: unknown) {
  return typeof value === 'string' ? value.trim() : ''
}

function boundedText(value: unknown, name: string, limit: number) {
  const normalized = text(value)
  if (!normalized) throw new TypeError(`${name} 不能为空`)
  if (normalized.length > limit) throw new TypeError(`${name} 不能超过 ${limit} 个字符`)
  return normalized
}

function safeModelSlug(value: unknown) {
  const normalized = text(value)
  return MODEL_SLUG.test(normalized) ? normalized : ''
}

function safeReasoningLevel(value: unknown) {
  const normalized = text(value)
  return REASONING_LEVEL.test(normalized) ? normalized : ''
}

function integer(value: unknown, name: string, minimum: number, maximum: number) {
  const normalized = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value
  if (!Number.isSafeInteger(normalized) || Number(normalized) < minimum || Number(normalized) > maximum) {
    throw new TypeError(`${name} 必须是 ${minimum}–${maximum} 之间的整数`)
  }
  return Number(normalized)
}

function normalizedWeekdays(value: unknown) {
  if (!Array.isArray(value)) return []
  return [...new Set(value.map(Number).filter((day) => Number.isInteger(day) && day >= 1 && day <= 7))]
    .sort((left, right) => left - right)
}

function dateTimeLocal(value: unknown) {
  if (!value) return ''
  const date = new Date(String(value))
  if (!Number.isFinite(date.getTime())) return ''
  const pad = (part: number) => String(part).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function onceInstant(value: unknown) {
  const source = text(value)
  if (!source) throw new TypeError('请选择执行日期和时间')
  const date = new Date(source)
  if (!Number.isFinite(date.getTime())) throw new TypeError('执行日期和时间无效')
  return date.toISOString()
}

export function defaultScheduleDraft(): ScheduleDraft {
  return {
    title: '', prompt: '', workspace: '', agent: 'codex', cadenceKind: 'daily',
    onceAt: '', minute: '0', hour: '9', weekdays: [1], day: '1',
    sandbox_mode: 'read-only', dangerConfirmed: false, model: '',
    reasoning_effort: '', timeout_seconds: '7200',
  }
}

export function scheduleToDraft(source: Partial<ScheduleRecord> = {}): ScheduleDraft {
  const cadence = source.cadence ?? { kind: 'daily', hour: 9, minute: 0 }
  const cadenceKind = CADENCE_KINDS.has(cadence.kind) ? cadence.kind : 'daily'
  const minute = 'minute' in cadence ? cadence.minute : 0
  const hour = 'hour' in cadence ? cadence.hour : 9
  const day = 'day' in cadence ? cadence.day : 1
  const weekdays = 'weekdays' in cadence ? normalizedWeekdays(cadence.weekdays) : []
  return {
    ...defaultScheduleDraft(),
    title: text(source.title),
    prompt: text(source.prompt),
    workspace: text(source.workspace),
    agent: AGENT_ID.test(text(source.agent)) ? text(source.agent) : 'codex',
    cadenceKind,
    onceAt: 'at' in cadence ? dateTimeLocal(cadence.at) : '',
    minute: String(Number.isInteger(minute) && minute >= 0 && minute <= 59 ? minute : 0),
    hour: String(Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : 9),
    weekdays: weekdays.length ? weekdays : [1],
    day: String(Number.isInteger(day) && day >= 1 && day <= 31 ? day : 1),
    sandbox_mode: SANDBOX_MODES.has(source.sandbox_mode ?? '')
      ? source.sandbox_mode as ScheduleRecord['sandbox_mode']
      : 'read-only',
    model: safeModelSlug(source.model),
    reasoning_effort: safeReasoningLevel(source.reasoning_effort),
    timeout_seconds: String(Number.isSafeInteger(source.timeout_seconds)
      && Number(source.timeout_seconds) >= 60 && Number(source.timeout_seconds) <= 86_400
      ? source.timeout_seconds : 7_200),
  }
}

export function normalizeModelCatalog(value: RuntimeModel[]): ModelOption[] {
  if (!Array.isArray(value) || value.length > 100) throw new TypeError('Runtime model catalog 响应无效')
  const seen = new Set<string>()
  return value.map((item) => {
    const slug = safeModelSlug(item.id ?? item.slug)
    const displayName = text(item.displayName ?? item.display_name ?? slug)
    const description = text(item.description)
    const sourceLevels = item.reasoningLevels ?? item.supported_reasoning_levels ?? []
    if (!slug || seen.has(slug) || !displayName || displayName.length > 128
      || description.length > 512 || !Array.isArray(sourceLevels) || sourceLevels.length > 16) {
      throw new TypeError('Runtime model catalog 响应无效')
    }
    seen.add(slug)
    const reasoningLevels = sourceLevels.map(safeReasoningLevel)
    if (reasoningLevels.some((level) => !level) || new Set(reasoningLevels).size !== reasoningLevels.length) {
      throw new TypeError('Runtime model catalog 响应无效')
    }
    const defaultReasoning = safeReasoningLevel(
      item.defaultReasoningLevel ?? item.default_reasoning_level,
    )
    if (defaultReasoning && !reasoningLevels.includes(defaultReasoning)) {
      throw new TypeError('Runtime model catalog 响应无效')
    }
    return { slug, displayName, description, defaultReasoning, reasoningLevels }
  })
}

export function draftToScheduleInput(
  draft: ScheduleDraft,
  { modelCatalog = [] }: { modelCatalog?: ModelOption[] } = {},
): ScheduleMutationInput {
  if (!CADENCE_KINDS.has(draft.cadenceKind)) throw new TypeError('执行频率无效')
  if (!SANDBOX_MODES.has(draft.sandbox_mode)) throw new TypeError('Sandbox mode 无效')
  if (draft.sandbox_mode === 'danger-full-access' && !draft.dangerConfirmed) {
    throw new TypeError('使用 danger-full-access 前需要明确确认风险')
  }

  let cadence: ScheduleCadence
  if (draft.cadenceKind === 'once') {
    cadence = { kind: 'once', at: onceInstant(draft.onceAt), timezone_mode: 'system' }
  } else if (draft.cadenceKind === 'hourly') {
    cadence = {
      kind: 'hourly', minute: integer(draft.minute, 'Minute', 0, 59), timezone_mode: 'system',
    }
  } else {
    const clock = {
      hour: integer(draft.hour, 'Hour', 0, 23),
      minute: integer(draft.minute, 'Minute', 0, 59),
      timezone_mode: 'system' as const,
    }
    if (draft.cadenceKind === 'weekly') {
      const weekdays = normalizedWeekdays(draft.weekdays)
      if (!weekdays.length) throw new TypeError('每周计划至少选择一天')
      cadence = { kind: 'weekly', ...clock, weekdays }
    } else if (draft.cadenceKind === 'monthly') {
      cadence = { kind: 'monthly', ...clock, day: integer(draft.day, 'Day', 1, 31) }
    } else {
      cadence = { kind: 'daily', ...clock }
    }
  }

  const model = text(draft.model)
  const reasoningEffort = text(draft.reasoning_effort)
  if (model && !MODEL_SLUG.test(model)) throw new TypeError('Model 无效')
  if (reasoningEffort && !REASONING_LEVEL.test(reasoningEffort)) throw new TypeError('Reasoning 无效')
  if (modelCatalog.length) {
    const selected = model ? modelCatalog.find((item) => item.slug === model) : null
    if (model && !selected) throw new TypeError('所选 Model 当前不可用')
    const supported = !reasoningEffort || (selected
      ? selected.reasoningLevels.includes(reasoningEffort)
      : modelCatalog.some((item) => item.reasoningLevels.includes(reasoningEffort)))
    if (!supported) throw new TypeError('所选 Model 不支持该 Reasoning level')
  }

  return {
    title: boundedText(draft.title, 'Title', 200),
    prompt: boundedText(draft.prompt, 'Prompt', 20_000),
    workspace: boundedText(draft.workspace, 'Workspace', 4_096),
    agent: AGENT_ID.test(text(draft.agent)) ? text(draft.agent) : 'codex',
    cadence,
    sandbox_mode: draft.sandbox_mode,
    model: model || null,
    reasoning_effort: reasoningEffort || null,
    timeout_seconds: integer(draft.timeout_seconds, 'Timeout', 60, 86_400),
  }
}
