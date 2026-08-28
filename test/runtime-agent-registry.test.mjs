import assert from 'node:assert/strict'
import test from 'node:test'

import { createRuntimeAgentRegistry } from '../server/src/runtime/runtime-agent-registry.mjs'
import { runtimeError } from '../server/src/runtime/runtime-errors.mjs'

const CODEX_DEFINITION = {
  id: 'codex',
  displayName: 'Codex',
  capabilities: { models: true, session_resume: true },
}

const CLAUDE_DEFINITION = {
  id: 'claude',
  displayName: 'Claude Code',
  capabilities: { models: true, session_resume: true },
}

test('registry rejects duplicate runtime IDs', () => {
  assert.throws(
    () => createRuntimeAgentRegistry({
      definitions: [CODEX_DEFINITION, { ...CODEX_DEFINITION }],
      resolver: { resolve: async () => null },
    }),
    /Duplicate runtime ID: codex/,
  )
})

test('registry reports one unavailable runtime without hiding healthy runtimes', async () => {
  const registry = createRuntimeAgentRegistry({
    definitions: [CODEX_DEFINITION, CLAUDE_DEFINITION],
    resolver: {
      resolve: async ({ id }) => {
        if (id === 'claude') {
          throw runtimeError('RUNTIME_UNAVAILABLE', 'missing')
        }
        return {
          runtime_id: id,
          executable: '/bin/codex',
          version: '1',
          source: 'path',
        }
      },
    },
    ttlMs: 300_000,
  })

  const statuses = await registry.list()
  assert.equal(statuses.find(({ id }) => id === 'codex').state, 'ready')
  assert.equal(statuses.find(({ id }) => id === 'claude').state, 'unavailable')
})

test('registry caches detection until the runtime is refreshed', async () => {
  let resolutions = 0
  const registry = createRuntimeAgentRegistry({
    definitions: [CODEX_DEFINITION],
    resolver: {
      resolve: async ({ id }) => ({
        runtime_id: id,
        executable: `/bin/codex-${++resolutions}`,
        version: '1',
        source: 'path',
      }),
    },
    clock: () => 1_000,
    ttlMs: 300_000,
  })

  const first = await registry.resolve('codex')
  const cached = await registry.resolve('codex')
  registry.refresh('codex')
  const refreshed = await registry.resolve('codex')

  assert.equal(first.executable, '/bin/codex-1')
  assert.equal(cached, first)
  assert.equal(refreshed.executable, '/bin/codex-2')
  assert.equal(resolutions, 2)
})

test('registry does not cache an unavailable result', async () => {
  let resolutions = 0
  const registry = createRuntimeAgentRegistry({
    definitions: [CODEX_DEFINITION],
    resolver: {
      resolve: async ({ id }) => {
        resolutions += 1
        if (resolutions === 1) throw runtimeError('RUNTIME_UNAVAILABLE', 'missing')
        return {
          runtime_id: id,
          executable: '/bin/codex',
          version: '1',
          source: 'path',
        }
      },
    },
    clock: () => 1_000,
    ttlMs: 300_000,
  })

  await assert.rejects(
    registry.resolve('codex'),
    ({ code }) => code === 'RUNTIME_UNAVAILABLE',
  )
  assert.equal((await registry.resolve('codex')).executable, '/bin/codex')
  assert.equal(resolutions, 2)
})

test('registry copies and deeply freezes runtime definitions', () => {
  const source = {
    ...CODEX_DEFINITION,
    capabilities: { models: true },
  }
  const registry = createRuntimeAgentRegistry({
    definitions: [source],
    resolver: { resolve: async () => null },
  })
  const registered = registry.get('codex')

  source.capabilities.models = false

  assert.equal(registered.capabilities.models, true)
  assert.equal(Object.isFrozen(registered), true)
  assert.equal(Object.isFrozen(registered.capabilities), true)
})

test('registry availability does not run adapter authentication probes', async () => {
  let probes = 0
  const registry = createRuntimeAgentRegistry({
    definitions: [{
      ...CODEX_DEFINITION,
      authProbe: async () => {
        probes += 1
        return { state: 'authentication_required' }
      },
    }],
    resolver: {
      resolve: async ({ id }) => ({
        runtime_id: id,
        executable: '/bin/codex',
        version: '1',
        source: 'path',
      }),
    },
  })

  const [status] = await registry.list()
  assert.equal(status.state, 'ready')
  assert.equal(status.launch.executable, '/bin/codex')
  assert.equal(probes, 0)
})

test('runtime status reports the model source discovered through the resolved executable', async () => {
  let modelExecutable = null
  const registry = createRuntimeAgentRegistry({
    definitions: [{
      ...CODEX_DEFINITION,
      fetchModels: async ({ launch }) => {
        modelExecutable = launch.executable
        return { source: 'live', models: [{ id: 'gpt-live' }] }
      },
    }],
    resolver: {
      resolve: async ({ id }) => ({
        runtime_id: id,
        executable: '/resolved/codex',
        version: '1',
        source: 'path',
      }),
    },
  })

  const [status] = await registry.list()

  assert.equal(status.state, 'ready')
  assert.equal(status.models_source, 'live')
  assert.equal(modelExecutable, '/resolved/codex')
})
