import { createHash } from 'node:crypto'

import { parseDocument, stringify } from '../../vendor/yaml.mjs'

import { validateCadence } from './cadence.mjs'
import { SchedulerError } from './scheduler-errors.mjs'
import { isCodexModelSlug, isCodexReasoningLevel } from './codex-model-selection.mjs'

const DEFINITION_TYPE = 'tasks-recorder/schedule'
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/
const DURATION = /^(\d+)(s|m|h)$/
const AGENT = /^[a-z][a-z0-9-]{0,63}$/
const FRONT_MATTER = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/
const MARKER = /^type:\s*["']?tasks-recorder\/schedule["']?\s*(?:#.*)?$/m
const FIELDS = new Set([
  'type', 'id', 'title', 'enabled', 'workspace', 'agent', 'schedule', 'sandbox', 'model', 'reasoning', 'timeout',
])
const SANDBOXES = new Set(['read-only', 'workspace-write', 'danger-full-access'])
const WEEKDAYS = new Map([
  ['mon', 1], ['tue', 2], ['wed', 3], ['thu', 4], ['fri', 5], ['sat', 6], ['sun', 7],
])
const WEEKDAY_NAMES = new Map([...WEEKDAYS].map(([name, value]) => [value, name]))

function fail(code, message, details) {
  throw new SchedulerError(code, message, details)
}

function object(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('SCHEDULE_DEFINITION_INVALID', `${field} must be an object`, { field })
  }
  return value
}

function exactFields(value, allowed, field) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail('SCHEDULE_DEFINITION_INVALID', `unsupported ${field} field: ${key}`, { field: key })
  }
}

function string(value, field, max) {
  if (typeof value !== 'string') fail('SCHEDULE_DEFINITION_INVALID', `${field} must be a string`, { field })
  const normalized = value.trim()
  if (normalized.length === 0 || normalized.length > max) {
    fail('SCHEDULE_DEFINITION_INVALID', `${field} must contain 1 to ${max} characters`, { field })
  }
  return normalized
}

function optionalCodexSelection(value, field, validator, maximum) {
  if (value === undefined || value === null || value === '') return null
  const normalized = string(value, field, maximum)
  if (!validator(normalized)) fail('SCHEDULE_DEFINITION_INVALID', `${field} is invalid`, { field })
  return normalized
}

function agentId(value = 'codex') {
  const normalized = string(value, 'agent', 64)
  if (!AGENT.test(normalized)) {
    fail('SCHEDULE_DEFINITION_INVALID', 'agent is invalid', { field: 'agent' })
  }
  return normalized
}

function time(value, field = 'schedule.at') {
  if (typeof value !== 'string' || !TIME.test(value)) {
    fail('SCHEDULE_DEFINITION_INVALID', `${field} must be HH:mm`, { field })
  }
  const [hour, minute] = value.split(':').map(Number)
  return { hour, minute }
}

function timeoutSeconds(value) {
  if (value === undefined || value === null) return 7200
  let seconds
  if (Number.isInteger(value)) seconds = value
  else if (typeof value === 'string') {
    const match = DURATION.exec(value.trim())
    if (!match) fail('SCHEDULE_DEFINITION_INVALID', 'timeout must use s, m, or h units', { field: 'timeout' })
    const factor = { s: 1, m: 60, h: 3600 }[match[2]]
    seconds = Number(match[1]) * factor
  }
  if (!Number.isSafeInteger(seconds) || seconds < 60 || seconds > 86400) {
    fail('SCHEDULE_DEFINITION_INVALID', 'timeout must be from 60s to 24h', { field: 'timeout' })
  }
  return seconds
}

function duration(seconds) {
  if (seconds % 3600 === 0) return `${seconds / 3600}h`
  if (seconds % 60 === 0) return `${seconds / 60}m`
  return `${seconds}s`
}

function cadence(value, clock, { allowPastOnce = false } = {}) {
  const schedule = object(value, 'schedule')
  if (typeof schedule.kind !== 'string') fail('SCHEDULE_DEFINITION_INVALID', 'schedule.kind is required', { field: 'schedule.kind' })
  const kind = schedule.kind
  if (kind === 'once') {
    exactFields(schedule, new Set(['kind', 'at']), 'schedule')
    const at = string(schedule.at, 'schedule.at', 40)
    if (!/(?:Z|[+-]\d{2}:\d{2})$/.test(at)) {
      fail('SCHEDULE_DEFINITION_INVALID', 'schedule.at must include a timezone offset', { field: 'schedule.at' })
    }
    return validateCadence({ kind, at }, { now: clock(), allowPastOnce })
  }
  if (kind === 'hourly') {
    exactFields(schedule, new Set(['kind', 'minute']), 'schedule')
    return validateCadence({ kind, minute: schedule.minute })
  }
  if (kind === 'daily') {
    exactFields(schedule, new Set(['kind', 'at']), 'schedule')
    return validateCadence({ kind, ...time(schedule.at) })
  }
  if (kind === 'weekly') {
    exactFields(schedule, new Set(['kind', 'on', 'at']), 'schedule')
    if (!Array.isArray(schedule.on) || schedule.on.length === 0) {
      fail('SCHEDULE_DEFINITION_INVALID', 'schedule.on must contain weekday names', { field: 'schedule.on' })
    }
    const weekdays = schedule.on.map((day) => {
      if (typeof day !== 'string' || !WEEKDAYS.has(day.toLowerCase())) {
        fail('SCHEDULE_DEFINITION_INVALID', `unsupported weekday: ${String(day)}`, { field: 'schedule.on' })
      }
      return WEEKDAYS.get(day.toLowerCase())
    })
    return validateCadence({ kind, weekdays, ...time(schedule.at) })
  }
  if (kind === 'monthly') {
    exactFields(schedule, new Set(['kind', 'day', 'at']), 'schedule')
    return validateCadence({ kind, day: schedule.day, ...time(schedule.at) })
  }
  fail('SCHEDULE_DEFINITION_INVALID', `unsupported schedule kind: ${kind}`, { field: 'schedule.kind' })
}

function humanCadence(value) {
  const at = (hour, minute) => `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
  if (value.kind === 'once') return { kind: 'once', at: value.at }
  if (value.kind === 'hourly') return { kind: 'hourly', minute: value.minute }
  if (value.kind === 'daily') return { kind: 'daily', at: at(value.hour, value.minute) }
  if (value.kind === 'weekly') {
    return { kind: 'weekly', on: value.weekdays.map((day) => WEEKDAY_NAMES.get(day)), at: at(value.hour, value.minute) }
  }
  return { kind: 'monthly', day: value.day, at: at(value.hour, value.minute) }
}

export function definitionEtag(source) {
  if (typeof source !== 'string') throw new TypeError('source must be a string')
  return createHash('sha256').update(source).digest('hex')
}

export function parseScheduleDefinition(source, {
  sourcePath = null,
  clock = () => new Date(),
} = {}) {
  if (typeof source !== 'string') throw new TypeError('source must be a string')
  const match = FRONT_MATTER.exec(source.replace(/^\uFEFF/, ''))
  if (!match || !MARKER.test(match[1])) return null
  const document = parseDocument(match[1], { prettyErrors: false, uniqueKeys: true })
  if (document.errors.length > 0) {
    fail('SCHEDULE_DEFINITION_YAML_INVALID', `Schedule front matter YAML is invalid: ${document.errors[0].message}`, { source_path: sourcePath })
  }
  const frontMatter = object(document.toJS({ maxAliasCount: 0 }), 'front matter')
  exactFields(frontMatter, FIELDS, 'front matter')
  if (frontMatter.type !== DEFINITION_TYPE) {
    fail('SCHEDULE_DEFINITION_INVALID', `type must be ${DEFINITION_TYPE}`, { field: 'type' })
  }
  const id = string(frontMatter.id, 'id', 128)
  if (!ID.test(id)) fail('SCHEDULE_DEFINITION_INVALID', 'id must be a UUID', { field: 'id' })
  if (frontMatter.enabled !== undefined && typeof frontMatter.enabled !== 'boolean') {
    fail('SCHEDULE_DEFINITION_INVALID', 'enabled must be boolean', { field: 'enabled' })
  }
  const sandbox = frontMatter.sandbox ?? 'read-only'
  if (!SANDBOXES.has(sandbox)) fail('SCHEDULE_DEFINITION_INVALID', 'sandbox is not supported', { field: 'sandbox' })
  const prompt = match[2].trim()
  if (prompt.length === 0 || prompt.length > 20000) {
    fail('SCHEDULE_DEFINITION_INVALID', 'Markdown body Prompt must contain 1 to 20000 characters', { field: 'prompt' })
  }
  const enabled = frontMatter.enabled ?? true
  const result = {
    id,
    title: string(frontMatter.title, 'title', 200),
    enabled,
    workspace: string(frontMatter.workspace, 'workspace', 4096),
    agent: agentId(frontMatter.agent),
    cadence: cadence(frontMatter.schedule, clock, { allowPastOnce: !enabled }),
    sandbox_mode: sandbox,
    model: optionalCodexSelection(frontMatter.model, 'model', isCodexModelSlug, 128),
    reasoning_effort: optionalCodexSelection(frontMatter.reasoning, 'reasoning', isCodexReasoningLevel, 16),
    timeout_seconds: timeoutSeconds(frontMatter.timeout),
    thread_mode: 'new',
    timezone_mode: 'system',
    prompt,
  }
  if (sourcePath !== null) result.source_path = sourcePath
  result.etag = definitionEtag(source)
  return result
}

export function serializeScheduleDefinition(job, { clock = () => new Date() } = {}) {
  const value = object(job, 'definition')
  const enabled = value.enabled ?? true
  const frontMatter = {
    type: DEFINITION_TYPE,
    id: string(value.id, 'id', 128),
    title: string(value.title, 'title', 200),
    enabled,
    workspace: string(value.workspace, 'workspace', 4096),
    agent: agentId(value.agent),
    schedule: humanCadence(validateCadence(value.cadence, { now: clock(), allowPastOnce: !enabled })),
    sandbox: value.sandbox_mode ?? 'read-only',
  }
  if (!ID.test(frontMatter.id)) fail('SCHEDULE_DEFINITION_INVALID', 'id must be a UUID', { field: 'id' })
  if (!SANDBOXES.has(frontMatter.sandbox)) fail('SCHEDULE_DEFINITION_INVALID', 'sandbox is not supported', { field: 'sandbox' })
  if (value.model !== undefined && value.model !== null) {
    frontMatter.model = optionalCodexSelection(value.model, 'model', isCodexModelSlug, 128)
  }
  if (value.reasoning_effort !== undefined && value.reasoning_effort !== null) {
    frontMatter.reasoning = optionalCodexSelection(value.reasoning_effort, 'reasoning', isCodexReasoningLevel, 16)
  }
  frontMatter.timeout = duration(timeoutSeconds(value.timeout_seconds))
  const prompt = string(value.prompt, 'prompt', 20000)
  return `---\n${stringify(frontMatter, { lineWidth: 0 }).trimEnd()}\n---\n\n${prompt}\n`
}
