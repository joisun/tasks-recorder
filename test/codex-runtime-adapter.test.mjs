import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createCodexRuntimeDefinition } from '../server/src/runtime/adapters/codex.mjs'
import { parseCodexJsonLine } from '../server/src/runtime/parsers/codex-jsonl.mjs'

async function runFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'codex-runtime-'))
  const workspace = join(directory, 'workspace')
  const executable = join(directory, 'codex')
  await mkdir(workspace)
  await writeFile(executable, '#!/bin/sh\n')
  await chmod(executable, 0o700)
  return {
    directory,
    executable,
    run: {
      id: '11111111-1111-4111-8111-111111111111',
      etag: 'a'.repeat(64),
      title: 'Registry-owned Codex Run',
      prompt: 'Implement the requested change.',
      workspace,
      cadence: {
        kind: 'daily',
        hour: 9,
        minute: 5,
        timezone_mode: 'system',
      },
      timezone_mode: 'system',
      thread_mode: 'new',
      sandbox_mode: 'read-only',
      model: null,
      reasoning_effort: null,
      timeout_seconds: 600,
      enabled: true,
      agent: 'codex',
    },
  }
}

test('Codex definition uses the resolved executable for Run invocation', async () => {
  const fixture = await runFixture()
  try {
    const definition = createCodexRuntimeDefinition()
    const launch = {
      runtime_id: 'codex',
      executable: fixture.executable,
      version: 'codex-cli 0.150.0',
      source: 'path',
    }
    const invocation = await definition.buildInvocation({
      launch,
      run: fixture.run,
    })

    assert.equal(invocation.command, await realpath(fixture.executable))
    assert.deepEqual(invocation.args.slice(0, 4), [
      'exec', '--json', '--color', 'never',
    ])
    assert.equal(invocation.stdin, fixture.run.prompt)
    assert.equal(invocation.args.includes(fixture.run.prompt), false)
  } finally {
    await rm(fixture.directory, { recursive: true, force: true })
  }
})

test('Codex definition discovers models through the same resolved executable', async () => {
  const calls = []
  const definition = createCodexRuntimeDefinition({
    execFileImpl(command, args, options, callback) {
      calls.push({ command, args, options })
      callback(null, JSON.stringify({
        models: [{
          slug: 'gpt-5.6-sol',
          display_name: 'GPT-5.6 Sol',
          description: 'Frontier coding model',
          visibility: 'list',
          priority: 1,
          default_reasoning_level: 'medium',
          supported_reasoning_levels: [
            { effort: 'low', description: 'Fast' },
            { effort: 'medium', description: 'Balanced' },
          ],
        }],
      }), '')
    },
  })
  const launch = {
    runtime_id: 'codex',
    executable: '/opt/tasks/bin/codex',
    version: 'codex-cli 0.150.0',
    source: 'path',
  }

  assert.deepEqual(await definition.fetchModels({ launch }), {
    source: 'live',
    models: [{
      id: 'gpt-5.6-sol',
      displayName: 'GPT-5.6 Sol',
      description: 'Frontier coding model',
      reasoningLevels: ['low', 'medium'],
      defaultReasoningLevel: 'medium',
      metadata: {},
    }],
  })
  assert.equal(calls[0].command, launch.executable)
  assert.deepEqual(calls[0].args, ['debug', 'models'])
})

test('Codex definition exposes the normalized event parser', () => {
  const definition = createCodexRuntimeDefinition()
  assert.equal(definition.parseEvent, parseCodexJsonLine)
})

test('Codex availability remains independent from login state', () => {
  const definition = createCodexRuntimeDefinition()
  assert.equal(definition.authProbe, undefined)
})

test('Codex definition exposes one interactive session factory without changing one-shot fallback', () => {
  const created = []
  const definition = createCodexRuntimeDefinition({
    interactiveFactory: {
      create(input) {
        created.push(input)
        return { kind: 'interactive-session' }
      },
    },
  })

  assert.equal(definition.capabilities.interactiveSession, true)
  assert.deepEqual(definition.createInteractiveSession({ run: { id: 'run-1' } }), {
    kind: 'interactive-session',
  })
  assert.deepEqual(created, [{ run: { id: 'run-1' } }])
  assert.equal(typeof definition.buildInvocation, 'function')
})
