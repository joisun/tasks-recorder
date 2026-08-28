import assert from 'node:assert/strict'
import test from 'node:test'

import { createApiServer } from '../server/src/api-server.mjs'
import { createRevisionHub } from '../server/src/revision-hub.mjs'

async function fixture(runtimeRegistry) {
  const hub = createRevisionHub({ instanceId: 'runtime-api-test', keepaliveMs: 60_000 })
  const api = createApiServer({
    service: {},
    store: {},
    hub,
    host: '127.0.0.1',
    port: 0,
    dashboardHtml: '<!doctype html>',
    runtimeRegistry,
    packageVersion: '0.6.0-test',
    apiVersion: 4,
  })
  const address = await api.listen()
  return {
    url: address.url,
    async close() {
      await api.close()
      hub.close()
    },
  }
}

async function json(url, path, options = {}) {
  const response = await fetch(`${url}${path}`, options)
  return { status: response.status, body: await response.json() }
}

test('meta exposes the runtime-registry compatibility handshake', async () => {
  const current = await fixture({
    list: async () => [],
    refresh: () => {},
    models: async () => ({ source: 'not_supported', models: [] }),
  })
  try {
    assert.deepEqual((await json(current.url, '/api/v1/meta')).body, {
      service: 'tasks-recorder',
      service_version: '0.6.0-test',
      api_version: 4,
      capabilities: {
        runtime_registry: true,
        unified_runs: false,
        internal_scheduler: false,
      },
    })
  } finally {
    await current.close()
  }
})

test('known runtime model route remains explicit when the binary is unavailable', async () => {
  const current = await fixture({
    list: async () => [{ id: 'codex', state: 'unavailable' }],
    refresh: () => {},
    get: (id) => {
      if (id !== 'codex') throw Object.assign(new Error('missing'), { code: 'RUNTIME_NOT_FOUND' })
      return { id: 'codex' }
    },
    models: async () => ({
      source: 'unavailable',
      models: [],
      error_code: 'RUNTIME_UNAVAILABLE',
    }),
  })
  try {
    const result = await json(current.url, '/api/v1/runtimes/codex/models')
    assert.equal(result.status, 503)
    assert.equal(result.body.error.code, 'MODEL_CATALOG_UNAVAILABLE')
    assert.notEqual(result.body.error.code, 'ROUTE_NOT_FOUND')
  } finally {
    await current.close()
  }
})
