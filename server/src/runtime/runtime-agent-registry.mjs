import { runtimeError } from './runtime-errors.mjs'

const SAFE_RUNTIME_ID = /^[a-z][a-z0-9-]*$/
const DEFAULT_TTL_MS = 300_000

export function createRuntimeAgentRegistry({
  definitions = [],
  resolver,
  clock = Date.now,
  ttlMs = DEFAULT_TTL_MS,
} = {}) {
  if (!resolver || typeof resolver.resolve !== 'function') {
    throw new TypeError('createRuntimeAgentRegistry requires a resolver')
  }

  const orderedDefinitions = definitions.map(copyAndFreezeDefinition)
  const definitionsById = new Map()
  for (const definition of orderedDefinitions) {
    if (!SAFE_RUNTIME_ID.test(definition.id)) {
      throw new TypeError(`Unsafe runtime ID: ${definition.id}`)
    }
    if (definitionsById.has(definition.id)) {
      throw new TypeError(`Duplicate runtime ID: ${definition.id}`)
    }
    definitionsById.set(definition.id, definition)
  }

  const resolutionCache = new Map()

  function get(id) {
    const definition = definitionsById.get(id)
    if (!definition) {
      throw runtimeError('RUNTIME_NOT_FOUND', `Unknown runtime: ${id}`, {
        runtime_id: id,
      })
    }
    return definition
  }

  async function resolve(id, { refresh = false } = {}) {
    const definition = get(id)
    if (refresh) resolutionCache.delete(id)

    const now = readClock(clock)
    const cached = resolutionCache.get(id)
    if (cached && cached.expiresAt > now) return cached.promise

    const promise = Promise.resolve()
      .then(() => resolver.resolve(definition))
      .catch((error) => {
        if (resolutionCache.get(id)?.promise === promise) resolutionCache.delete(id)
        throw error
      })
    resolutionCache.set(id, { promise, expiresAt: now + ttlMs })
    return promise
  }

  async function statusFor(definition) {
    try {
      const launch = await resolve(definition.id)
      const catalog = await discoverModels(definition, launch)
      return runtimeStatus(definition, {
        state: 'ready',
        launch,
        modelsSource: catalog.source,
        errorCode: null,
      })
    } catch (error) {
      return runtimeStatus(definition, {
        state: 'unavailable',
        launch: null,
        modelsSource: modelCapabilitySource(definition),
        errorCode: error?.code ?? 'RUNTIME_PROBE_FAILED',
      })
    }
  }

  async function list() {
    return Promise.all(orderedDefinitions.map(statusFor))
  }

  async function models(id, { refresh = false } = {}) {
    const definition = get(id)
    try {
      const launch = await resolve(id, { refresh })
      return discoverModels(definition, launch)
    } catch (error) {
      return {
        source: modelCapabilitySource(definition),
        models: definition.fallbackModels ?? [],
        error_code: error?.code ?? 'MODEL_PROBE_FAILED',
      }
    }
  }

  function refresh(id = undefined) {
    if (id === undefined) {
      resolutionCache.clear()
      return
    }
    get(id)
    resolutionCache.delete(id)
  }

  return Object.freeze({ list, get, resolve, models, refresh })
}

async function discoverModels(definition, launch) {
  if (typeof definition.fetchModels !== 'function') {
    return {
      source: modelCapabilitySource(definition),
      models: definition.fallbackModels ?? [],
    }
  }

  try {
    const discovered = await definition.fetchModels({ launch })
    if (Array.isArray(discovered)) return { source: 'live', models: discovered }
    if (discovered && typeof discovered === 'object' && Array.isArray(discovered.models)) {
      return discovered
    }
    throw runtimeError('MODEL_PROBE_FAILED', 'Runtime returned an invalid model catalog')
  } catch (error) {
    return {
      source: modelCapabilitySource(definition),
      models: definition.fallbackModels ?? [],
      error_code: error?.code ?? 'MODEL_PROBE_FAILED',
    }
  }
}

function modelCapabilitySource(definition) {
  if (definition.fallbackModels?.length) return 'fallback'
  if (definition.capabilities?.modelSelection === false
    || definition.capabilities?.models === false) return 'not_supported'
  return 'unavailable'
}

function runtimeStatus(definition, { state, launch, modelsSource, errorCode }) {
  return Object.freeze({
    id: definition.id,
    display_name: definition.displayName,
    state,
    launch,
    capabilities: definition.capabilities ?? Object.freeze({}),
    models_source: modelsSource,
    error_code: errorCode,
  })
}

function readClock(clock) {
  if (typeof clock === 'function') return clock()
  if (typeof clock?.now === 'function') return clock.now()
  throw new TypeError('clock must be a function or expose now()')
}

function copyAndFreezeDefinition(value) {
  if (!value || typeof value !== 'object') {
    throw new TypeError('Runtime definition must be an object')
  }
  return deepFreeze(copyValue(value))
}

function copyValue(value) {
  if (Array.isArray(value)) return value.map(copyValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [key, copyValue(nested)]),
  )
}

function deepFreeze(value) {
  Object.freeze(value)
  for (const nested of Object.values(value)) {
    if (nested && typeof nested === 'object' && !Object.isFrozen(nested)) {
      deepFreeze(nested)
    }
  }
  return value
}
