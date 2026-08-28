import { execFile } from 'node:child_process'

import { isCodexModelSlug, isCodexReasoningLevel } from './codex-model-selection.mjs'

const DEFAULT_TTL_MS = 5 * 60 * 1000
const DEFAULT_TIMEOUT_MS = 5_000
const DEFAULT_MAX_BUFFER_BYTES = 2 * 1024 * 1024
const MAX_MODELS = 100

function unavailable() {
  const error = new Error('Codex model catalog is unavailable')
  error.code = 'CODEX_MODEL_CATALOG_UNAVAILABLE'
  return error
}

function boundedString(value, maximum) {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
    ? value
    : null
}

function parseVisibleModels(source) {
  let payload
  try {
    payload = JSON.parse(source)
  } catch {
    throw unavailable()
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
    || !Array.isArray(payload.models) || payload.models.length > MAX_MODELS) {
    throw unavailable()
  }

  const seen = new Set()
  const visible = []
  for (const item of payload.models) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw unavailable()
    if (item.visibility !== 'list') continue
    const slug = boundedString(item.slug, 128)
    const displayName = boundedString(item.display_name, 128)
    const description = boundedString(item.description, 512)
    if (!slug || !isCodexModelSlug(slug) || !displayName || !description
      || !Number.isSafeInteger(item.priority) || item.priority < 0 || item.priority > 1_000_000
      || !Array.isArray(item.supported_reasoning_levels)
      || item.supported_reasoning_levels.length === 0
      || item.supported_reasoning_levels.length > 16) {
      throw unavailable()
    }
    if (seen.has(slug)) throw unavailable()
    seen.add(slug)

    const efforts = []
    const seenEfforts = new Set()
    for (const level of item.supported_reasoning_levels) {
      const effort = boundedString(level?.effort, 16)
      if (!effort || !isCodexReasoningLevel(effort) || seenEfforts.has(effort)) throw unavailable()
      seenEfforts.add(effort)
      efforts.push(effort)
    }
    const defaultReasoning = boundedString(item.default_reasoning_level, 16)
    if (!defaultReasoning || !seenEfforts.has(defaultReasoning)) throw unavailable()

    visible.push({
      priority: item.priority,
      model: {
        slug,
        display_name: displayName,
        description,
        default_reasoning_level: defaultReasoning,
        supported_reasoning_levels: efforts,
      },
    })
  }
  if (visible.length === 0) throw unavailable()
  visible.sort((left, right) => left.priority - right.priority || left.model.slug.localeCompare(right.model.slug))
  return visible.map(({ model }) => model)
}

function nowMilliseconds(clock) {
  const value = clock()
  const result = value instanceof Date ? value.getTime() : Number(value)
  if (!Number.isFinite(result)) throw unavailable()
  return result
}

export function createCodexModelCatalog({
  codexPath,
  execFileImpl = execFile,
  clock = Date.now,
  ttlMs = DEFAULT_TTL_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxBufferBytes = DEFAULT_MAX_BUFFER_BYTES,
} = {}) {
  if (typeof codexPath !== 'string' || codexPath.length === 0) throw new TypeError('codexPath is required')
  if (typeof execFileImpl !== 'function') throw new TypeError('execFileImpl is required')
  if (typeof clock !== 'function') throw new TypeError('clock is required')
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 24 * 60 * 60 * 1000) throw new TypeError('ttlMs is invalid')
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new TypeError('timeoutMs is invalid')
  if (!Number.isSafeInteger(maxBufferBytes) || maxBufferBytes < 1024 || maxBufferBytes > 16 * 1024 * 1024) throw new TypeError('maxBufferBytes is invalid')

  let cached = null
  let expiresAt = 0
  let pending = null

  function load() {
    return new Promise((resolve, reject) => {
      try {
        execFileImpl(codexPath, ['debug', 'models'], {
          encoding: 'utf8',
          timeout: timeoutMs,
          maxBuffer: maxBufferBytes,
          windowsHide: true,
        }, (error, stdout) => {
          if (error || typeof stdout !== 'string') {
            reject(unavailable())
            return
          }
          try {
            resolve(parseVisibleModels(stdout))
          } catch {
            reject(unavailable())
          }
        })
      } catch {
        reject(unavailable())
      }
    })
  }

  async function list() {
    const now = nowMilliseconds(clock)
    if (cached !== null && now < expiresAt) return cached.map((item) => ({ ...item, supported_reasoning_levels: [...item.supported_reasoning_levels] }))
    if (!pending) {
      pending = load().then((models) => {
        cached = models
        expiresAt = nowMilliseconds(clock) + ttlMs
        return models
      }).finally(() => { pending = null })
    }
    const models = await pending
    return models.map((item) => ({ ...item, supported_reasoning_levels: [...item.supported_reasoning_levels] }))
  }

  async function validate({ model = null, reasoning_effort: reasoningEffort = null } = {}) {
    if (model === null && reasoningEffort === null) return { ok: true }
    let models
    try {
      models = await list()
    } catch {
      return { ok: false, error_code: 'CODEX_MODEL_CATALOG_UNAVAILABLE' }
    }
    const selected = model === null ? null : models.find((item) => item.slug === model)
    if (model !== null && !selected) return { ok: false, error_code: 'CODEX_MODEL_UNAVAILABLE' }
    if (reasoningEffort !== null) {
      const supported = selected
        ? selected.supported_reasoning_levels.includes(reasoningEffort)
        : models.some((item) => item.supported_reasoning_levels.includes(reasoningEffort))
      if (!supported) return { ok: false, error_code: 'CODEX_REASONING_UNSUPPORTED' }
    }
    return { ok: true }
  }

  return { list, validate }
}
