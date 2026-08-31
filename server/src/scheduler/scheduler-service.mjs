import { realpath, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'

import { nextOccurrence, validateCadence } from './cadence.mjs'
import { SchedulerError } from './scheduler-errors.mjs'

const JOB_FIELDS = new Set([
  'title', 'prompt', 'workspace', 'agent', 'cadence', 'sandbox_mode', 'model',
  'reasoning_effort', 'timeout_seconds', 'capabilities',
])
const SANDBOX_MODES = new Set(['read-only', 'workspace-write', 'danger-full-access'])
const CAPABILITY_MODES = new Set(['inherit', 'disabled'])
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const ETAG = /^[0-9a-f]{64}$/
const AGENT = /^[a-z][a-z0-9-]{0,63}$/
const MODEL = /^[a-z0-9][a-z0-9._-]{0,127}$/
const REASONING = /^[a-z][a-z0-9_-]{0,15}$/

export function createDefinitionScheduleService({
  definitions,
  runtimeRegistry,
  runService = null,
  clock = () => new Date(),
} = {}) {
  if (!definitions?.list || !definitions?.get || !definitions?.create
    || !definitions?.update || !definitions?.setEnabled || !definitions?.remove) {
    throw new TypeError('definition repository is required')
  }
  if (!runtimeRegistry || typeof runtimeRegistry.get !== 'function') {
    throw new TypeError('runtimeRegistry.get is required')
  }
  let definitionQueue = Promise.resolve()

  function enqueue(operation) {
    const result = definitionQueue.then(operation)
    definitionQueue = result.catch(() => undefined)
    return result
  }

  function registeredAgent(value = 'codex') {
    const agent = boundedString(value, 'agent', 64)
    if (!AGENT.test(agent)) fail('SCHEDULE_INPUT_INVALID', 'agent is invalid', { field: 'agent' })
    runtimeRegistry.get(agent)
    return agent
  }

  async function normalizedInput(input, { patch = false } = {}) {
    allowOnly(input, JOB_FIELDS, patch ? 'Schedule patch' : 'Schedule')
    const output = { ...input }
    if (!patch || own(output, 'title')) output.title = boundedString(output.title, 'title', 200)
    if (!patch || own(output, 'prompt')) output.prompt = boundedString(output.prompt, 'prompt', 20_000)
    if (!patch || own(output, 'workspace')) output.workspace = await canonicalWorkspace(output.workspace)
    if (!patch || own(output, 'agent')) output.agent = registeredAgent(output.agent)
    if (!patch || own(output, 'cadence')) {
      output.cadence = validateCadence(output.cadence, { now: nowDate(clock) })
    }
    if (!patch || own(output, 'sandbox_mode')) output.sandbox_mode = sandboxMode(output.sandbox_mode)
    if (!patch || own(output, 'model')) output.model = optionalSelection(output.model, 'model', MODEL, 128)
    if (!patch || own(output, 'reasoning_effort')) {
      output.reasoning_effort = optionalSelection(
        output.reasoning_effort,
        'reasoning_effort',
        REASONING,
        16,
      )
    }
    if (!patch || own(output, 'timeout_seconds')) output.timeout_seconds = timeoutSeconds(output.timeout_seconds)
    if (!patch || own(output, 'capabilities')) {
      output.capabilities = capabilityPolicy(output.capabilities, {
        defaultMode: patch ? 'inherit' : 'disabled',
      })
    }
    return output
  }

  async function view(definition) {
    const latest = runService?.latestOccurrence
      ? await runService.latestOccurrence(definition.id)
      : null
    return {
      ...definition,
      cadence_json: JSON.stringify(definition.cadence),
      enabled: definition.enabled ? 1 : 0,
      deleted_at: null,
      schedule_generation: 1,
      sync_state: 'synced',
      sync_error_code: null,
      next_run_at: nextRunAt(definition, clock),
      last_run_at: latest?.started_at ?? latest?.created_at ?? null,
      created_at: definition.updated_at ?? null,
    }
  }

  async function createJob(input) {
    const normalized = await normalizedInput(input)
    return { job: await view(await definitions.create({
      ...normalized,
      thread_mode: 'new',
      timezone_mode: 'system',
    })) }
  }

  async function updateJob(id, etag, patch) {
    const scheduleId = scheduleIdValue(id)
    await definitions.get(scheduleId)
    return { job: await view(await definitions.update(
      scheduleId,
      expectedEtag(etag),
      await normalizedInput(patch, { patch: true }),
    )) }
  }

  async function setEnabled(id, etag, enabled) {
    const scheduleId = scheduleIdValue(id)
    const existing = await definitions.get(scheduleId)
    registeredAgent(existing.agent)
    return { job: await view(await definitions.setEnabled(
      scheduleId,
      expectedEtag(etag),
      enabled,
    )) }
  }

  async function deleteJob(id, etag) {
    const scheduleId = scheduleIdValue(id)
    const existing = await definitions.get(scheduleId)
    const removed = await definitions.remove(scheduleId, expectedEtag(etag))
    return {
      job: { ...await view(existing), deleted_at: nowDate(clock).toISOString() },
      removed,
    }
  }

  return Object.freeze({
    async listJobs() {
      return {
        jobs: await Promise.all((await definitions.list()).map(view)),
        invalid: definitions.invalid ? await definitions.invalid() : [],
      }
    },
    async getJob(id) {
      return { job: await view(await definitions.get(scheduleIdValue(id))) }
    },
    createJob: (...args) => enqueue(() => createJob(...args)),
    updateJob: (...args) => enqueue(() => updateJob(...args)),
    pauseJob: (...args) => enqueue(() => setEnabled(...args, false)),
    resumeJob: (...args) => enqueue(() => setEnabled(...args, true)),
    deleteJob: (...args) => enqueue(() => deleteJob(...args)),
  })
}

function nextRunAt(definition, clock) {
  if (!definition.enabled) return null
  const next = nextOccurrence(definition.cadence, nowDate(clock))
  return next?.toISOString() ?? null
}

async function canonicalWorkspace(value) {
  const requested = boundedString(value, 'workspace', 4_096)
  try {
    const workspace = await realpath(requested)
    const metadata = await stat(workspace)
    if (!metadata.isDirectory() || !isAbsolute(workspace)) throw new Error()
    return workspace
  } catch {
    fail('SCHEDULE_WORKSPACE_INVALID', 'workspace must be an existing directory', {
      field: 'workspace',
    })
  }
}

function allowOnly(value, allowed, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('SCHEDULE_INPUT_INVALID', `${field} must be an object`)
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail('SCHEDULE_INPUT_INVALID', `unsupported ${field} field: ${key}`, { field: key })
  }
}

function boundedString(value, field, maximum) {
  if (typeof value !== 'string') fail('SCHEDULE_INPUT_INVALID', `${field} must be a string`, { field })
  const normalized = value.trim()
  if (normalized.length === 0 || normalized.length > maximum) {
    fail('SCHEDULE_INPUT_INVALID', `${field} is invalid`, { field })
  }
  return normalized
}

function optionalSelection(value, field, pattern, maximum) {
  if (value === undefined || value === null || value === '') return null
  const normalized = boundedString(value, field, maximum)
  if (!pattern.test(normalized)) fail('SCHEDULE_INPUT_INVALID', `${field} is invalid`, { field })
  return normalized
}

function sandboxMode(value = 'read-only') {
  if (!SANDBOX_MODES.has(value)) fail('SCHEDULE_INPUT_INVALID', 'sandbox_mode is invalid', { field: 'sandbox_mode' })
  return value
}

function timeoutSeconds(value = 7_200) {
  if (!Number.isInteger(value) || value < 60 || value > 86_400) {
    fail('SCHEDULE_INPUT_INVALID', 'timeout_seconds is invalid', { field: 'timeout_seconds' })
  }
  return value
}

function capabilityPolicy(value, { defaultMode = 'inherit' } = {}) {
  if (value === undefined || value === null) {
    return { skills: defaultMode, integrations: defaultMode }
  }
  allowOnly(value, new Set(['skills', 'integrations']), 'capabilities')
  const mode = (field) => {
    const selected = value[field] ?? defaultMode
    if (!CAPABILITY_MODES.has(selected)) {
      fail('SCHEDULE_INPUT_INVALID', `capabilities.${field} is invalid`, {
        field: `capabilities.${field}`,
      })
    }
    return selected
  }
  return { skills: mode('skills'), integrations: mode('integrations') }
}

function scheduleIdValue(value) {
  const id = boundedString(value, 'job_id', 36).toLowerCase()
  if (!UUID.test(id)) fail('SCHEDULE_INPUT_INVALID', 'job_id must be a UUID', { field: 'job_id' })
  return id
}

function expectedEtag(value) {
  if (typeof value !== 'string' || !ETAG.test(value)) {
    fail('SCHEDULE_INPUT_INVALID', 'expected_etag is invalid', { field: 'expected_etag' })
  }
  return value
}

function nowDate(clock) {
  const value = clock()
  const date = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(date.getTime())) fail('CLOCK_INVALID', 'clock must return a valid date')
  return date
}

function own(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function fail(code, message, details) {
  throw new SchedulerError(code, message, details)
}
