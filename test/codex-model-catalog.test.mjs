import assert from 'node:assert/strict'
import test from 'node:test'

import { createCodexModelCatalog } from '../server/src/scheduler/codex-model-catalog.mjs'

function debugModels(models) {
  return JSON.stringify({ models })
}

function model({
  slug,
  displayName = slug,
  visibility = 'list',
  priority = 10,
  defaultReasoning = 'medium',
  efforts = ['low', 'medium', 'high'],
  description = `${displayName} description`,
} = {}) {
  return {
    slug,
    display_name: displayName,
    description,
    visibility,
    priority,
    default_reasoning_level: defaultReasoning,
    supported_reasoning_levels: efforts.map((effort) => ({
      effort,
      description: `${effort} description that must not cross the API boundary`,
    })),
    base_instructions: 'private and unbounded model instructions',
  }
}

function commandFixture(outputs) {
  const calls = []
  let index = 0
  return {
    calls,
    execFileImpl(command, args, options, callback) {
      calls.push({ command, args, options })
      const output = outputs[Math.min(index, outputs.length - 1)]
      index += 1
      if (output instanceof Error) callback(output)
      else callback(null, output, '')
    },
  }
}

test('Codex model catalog uses the shell-free debug command and exposes only visible bounded metadata', async () => {
  const command = commandFixture([debugModels([
    model({ slug: 'gpt-hidden', visibility: 'hide', priority: 0 }),
    model({ slug: 'gpt-5.6-terra', displayName: 'GPT-5.6-Terra', priority: 2 }),
    model({
      slug: 'gpt-5.6-sol', displayName: 'GPT-5.6-Sol', priority: 1,
      defaultReasoning: 'low', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    }),
  ])])
  const catalog = createCodexModelCatalog({
    codexPath: '/opt/homebrew/bin/codex',
    execFileImpl: command.execFileImpl,
  })

  assert.deepEqual(await catalog.list(), [
    {
      slug: 'gpt-5.6-sol',
      display_name: 'GPT-5.6-Sol',
      description: 'GPT-5.6-Sol description',
      default_reasoning_level: 'low',
      supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    },
    {
      slug: 'gpt-5.6-terra',
      display_name: 'GPT-5.6-Terra',
      description: 'GPT-5.6-Terra description',
      default_reasoning_level: 'medium',
      supported_reasoning_levels: ['low', 'medium', 'high'],
    },
  ])
  assert.deepEqual(command.calls, [{
    command: '/opt/homebrew/bin/codex',
    args: ['debug', 'models'],
    options: {
      encoding: 'utf8',
      timeout: 5_000,
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true,
    },
  }])
})

test('Codex model catalog caches the last successful snapshot for a bounded TTL', async () => {
  let now = 1_000
  const command = commandFixture([
    debugModels([model({ slug: 'gpt-first' })]),
    debugModels([model({ slug: 'gpt-second' })]),
  ])
  const catalog = createCodexModelCatalog({
    codexPath: '/codex', execFileImpl: command.execFileImpl,
    clock: () => now, ttlMs: 300_000,
  })

  assert.equal((await catalog.list())[0].slug, 'gpt-first')
  now += 299_999
  assert.equal((await catalog.list())[0].slug, 'gpt-first')
  assert.equal(command.calls.length, 1)
  now += 2
  assert.equal((await catalog.list())[0].slug, 'gpt-second')
  assert.equal(command.calls.length, 2)
})

test('Codex model catalog validates the selected model and its own reasoning levels', async () => {
  const command = commandFixture([debugModels([
    model({ slug: 'gpt-sol', defaultReasoning: 'low', efforts: ['low', 'ultra'] }),
    model({ slug: 'gpt-luna', defaultReasoning: 'low', efforts: ['low', 'high'] }),
  ])])
  const catalog = createCodexModelCatalog({ codexPath: '/codex', execFileImpl: command.execFileImpl })

  assert.deepEqual(await catalog.validate({ model: 'gpt-sol', reasoning_effort: 'ultra' }), { ok: true })
  assert.deepEqual(await catalog.validate({ model: null, reasoning_effort: 'high' }), { ok: true })
  assert.deepEqual(await catalog.validate({ model: 'gpt-sol', reasoning_effort: 'high' }), {
    ok: false, error_code: 'CODEX_REASONING_UNSUPPORTED',
  })
  assert.deepEqual(await catalog.validate({ model: 'gpt-missing', reasoning_effort: null }), {
    ok: false, error_code: 'CODEX_MODEL_UNAVAILABLE',
  })
})

test('Codex model preflight does not require a catalog when both selections inherit Codex defaults', async () => {
  const command = commandFixture([Object.assign(new Error('debug models unavailable'), { code: 'ENOENT' })])
  const catalog = createCodexModelCatalog({ codexPath: '/codex', execFileImpl: command.execFileImpl })

  assert.deepEqual(await catalog.validate({ model: null, reasoning_effort: null }), { ok: true })
  assert.equal(command.calls.length, 0)
})

test('Codex model catalog turns malformed or failed CLI output into a bounded typed error', async () => {
  for (const output of [
    '{broken',
    debugModels([model({ slug: '../unsafe' })]),
    Object.assign(new Error('secret path and stderr'), { code: 'ENOENT', stderr: 'private stderr' }),
  ]) {
    const command = commandFixture([output])
    const catalog = createCodexModelCatalog({ codexPath: '/private/codex', execFileImpl: command.execFileImpl })
    await assert.rejects(catalog.list(), (error) => {
      assert.equal(error.code, 'CODEX_MODEL_CATALOG_UNAVAILABLE')
      assert.equal(error.message, 'Codex model catalog is unavailable')
      assert.doesNotMatch(JSON.stringify(error), /private|secret|stderr/)
      return true
    })
  }
})
