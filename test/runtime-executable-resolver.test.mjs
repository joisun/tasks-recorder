import assert from 'node:assert/strict'
import test from 'node:test'

import { createExecutableResolver } from '../server/src/runtime/executable-resolver.mjs'

const CODEX_DEFINITION = Object.freeze({
  id: 'codex',
  launch: Object.freeze({
    overrideEnv: 'CODEX_BIN',
    executableNames: Object.freeze(['codex']),
    packagedCandidates: Object.freeze([]),
    platformResolvers: Object.freeze([]),
  }),
  versionProbe: Object.freeze({
    args: Object.freeze(['--version']),
    timeout_ms: 5_000,
  }),
})

test('resolver skips a broken override and selects the next probed candidate', async () => {
  const probed = []
  const resolver = createExecutableResolver({
    env: {
      CODEX_BIN: '/broken/codex',
      PATH: '/tools/bin',
    },
    candidatePaths: () => ['/tools/bin/codex'],
    canonicalize: async (path) => path,
    probe: async (path) => {
      probed.push(path)
      return path === '/tools/bin/codex'
        ? { version: 'codex-cli 0.150.0' }
        : null
    },
  })

  assert.deepEqual(await resolver.resolve(CODEX_DEFINITION), {
    runtime_id: 'codex',
    executable: '/tools/bin/codex',
    version: 'codex-cli 0.150.0',
    source: 'path',
  })
  assert.deepEqual(probed, ['/broken/codex', '/tools/bin/codex'])
})

test('resolver bounds executable probes after candidate validation', async () => {
  const probed = []
  const resolver = createExecutableResolver({
    env: {},
    candidatePaths: () => ['/one/codex', '/two/codex', '/three/codex'],
    maximumCandidates: 2,
    canonicalize: async (path) => path,
    probe: async (path) => {
      probed.push(path)
      return path === '/three/codex' ? { version: 'unexpected' } : null
    },
  })

  await assert.rejects(
    resolver.resolve(CODEX_DEFINITION),
    ({ code }) => code === 'RUNTIME_UNAVAILABLE',
  )
  assert.deepEqual(probed, ['/one/codex', '/two/codex'])
})

test('resolver does not spend the probe budget on missing PATH entries', async () => {
  const missing = Array.from({ length: 12 }, (_, index) => `/npm-${index}/codex`)
  const executable = '/opt/homebrew/bin/codex'
  const probed = []
  const resolver = createExecutableResolver({
    env: {},
    candidatePaths: () => [...missing, executable],
    maximumCandidates: 8,
    canonicalize: async (path) => {
      if (path !== executable) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      return path
    },
    probe: async (path) => {
      probed.push(path)
      return { version: 'codex-cli 0.150.0' }
    },
  })

  assert.deepEqual(await resolver.resolve(CODEX_DEFINITION), {
    runtime_id: 'codex',
    executable,
    version: 'codex-cli 0.150.0',
    source: 'path',
  })
  assert.deepEqual(probed, [executable])
})

test('resolver searches well-known user toolchain directories outside process PATH', async () => {
  const executable = '/Users/tester/.local/bin/codex'
  const resolver = createExecutableResolver({
    env: {
      HOME: '/Users/tester',
      PATH: '/usr/bin:/bin',
    },
    canonicalize: async (path) => {
      if (path !== executable) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      return path
    },
    probe: async () => ({ version: 'codex-cli 0.150.0' }),
  })

  assert.equal((await resolver.resolve(CODEX_DEFINITION)).executable, executable)
})
