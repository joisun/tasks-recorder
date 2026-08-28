import { runtimeError } from './runtime-errors.mjs'
import { createRuntimeEnvironment } from './runtime-environment.mjs'

const DEFAULT_MAXIMUM_CANDIDATES = 8

export function createExecutableResolver({
  env = process.env,
  runtimeEnvironment = createRuntimeEnvironment({ env }),
  candidatePaths = (definition) => runtimeEnvironment.executableCandidates(definition),
  canonicalize = async (path) => path,
  probe,
  maximumCandidates = DEFAULT_MAXIMUM_CANDIDATES,
} = {}) {
  if (typeof probe !== 'function') {
    throw new TypeError('createExecutableResolver requires a probe function')
  }

  return Object.freeze({
    async resolve(definition) {
      const candidates = collectCandidates(definition, env, candidatePaths)
      const seen = new Set()
      let inspected = 0

      for (const candidate of candidates) {
        let executable
        try {
          executable = await canonicalize(candidate.path)
        } catch {
          continue
        }
        if (!executable || seen.has(executable)) continue
        seen.add(executable)
        if (inspected >= maximumCandidates) break
        inspected += 1

        let result
        try {
          result = await probe(executable, definition.versionProbe)
        } catch {
          continue
        }
        if (!result) continue

        return {
          runtime_id: definition.id,
          executable,
          version: result.version,
          source: candidate.source,
        }
      }

      throw runtimeError(
        'RUNTIME_UNAVAILABLE',
        `No working executable found for runtime ${definition.id}`,
        { runtime_id: definition.id },
      )
    },
  })
}

function collectCandidates(definition, env, candidatePaths) {
  const candidates = []
  const override = env[definition.launch.overrideEnv]?.trim()
  if (override) candidates.push({ path: override, source: 'override' })

  for (const path of candidatePaths(definition) ?? []) {
    if (typeof path === 'string' && path.trim()) {
      candidates.push({ path: path.trim(), source: 'path' })
    }
  }
  return candidates
}
