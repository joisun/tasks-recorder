import assert from 'node:assert/strict'
import test from 'node:test'

import { parseCliArguments, runCli, runCliMain } from '../server/cli.mjs'

test('CLI parses service defaults and the complete Codex import argument set', () => {
  assert.deepEqual(parseCliArguments([]), { type: 'control', command: 'status' })
  assert.deepEqual(parseCliArguments(['start']), { type: 'control', command: 'start' })
  assert.deepEqual(parseCliArguments([
    'import', 'codex', '--session', 'root-session', '--dry-run', '--codex-home', '/tmp/codex',
  ]), {
    type: 'import-codex',
    session_id: 'root-session',
    dry_run: true,
    codex_home: '/tmp/codex',
  })
  assert.throws(
    () => parseCliArguments(['import', 'codex', '--session']),
    /--session requires/,
  )
  assert.throws(
    () => parseCliArguments(['import', 'codex', '--session', 'root', '--unknown']),
    /unknown option/,
  )
})

test('CLI delegates control commands and sends a normalized dry-run batch to taskd', async () => {
  const calls = []
  const control = await runCli([], {
    controlRunner: async (command) => ({ command, ready: true }),
  })
  assert.deepEqual(control, { command: 'status', ready: true })

  const result = await runCli([
    'import', 'codex', '--session', 'root-session', '--dry-run', '--codex-home', '/tmp/codex',
  ], {
    parseImport: async (input) => {
      calls.push({ type: 'parse', input })
      return {
        source: 'codex', session_id: 'root-session', root_turns: 1,
        subagent_executions: 0, records: [{ external_key: 'record-1' }],
        warnings: [{ code: 'SYNTHETIC_WARNING' }],
      }
    },
    configResolver: async () => ({ serverBaseUrl: 'http://127.0.0.1:43127' }),
    clientFactory: ({ baseUrl }) => ({
      importExecutions: async (input) => {
        calls.push({ type: 'request', baseUrl, input })
        return { dry_run: true, would_create: 1, warnings: input.warnings }
      },
    }),
  })

  assert.deepEqual(result, {
    dry_run: true, would_create: 1, warnings: [{ code: 'SYNTHETIC_WARNING' }],
  })
  assert.deepEqual(calls, [
    {
      type: 'parse',
      input: { sessionId: 'root-session', codexHome: '/tmp/codex' },
    },
    {
      type: 'request',
      baseUrl: 'http://127.0.0.1:43127',
      input: {
        source: 'codex', session_id: 'root-session', root_turns: 1,
        subagent_executions: 0, records: [{ external_key: 'record-1' }],
        warnings: [{ code: 'SYNTHETIC_WARNING' }], dry_run: true,
      },
    },
  ])
})

test('CLI surfaces an unavailable taskd instead of writing substitute files', async () => {
  await assert.rejects(runCli([
    'import', 'codex', '--session', 'root-session', '--dry-run',
  ], {
    parseImport: async () => ({
      source: 'codex', session_id: 'root-session', root_turns: 0,
      subagent_executions: 0, records: [], warnings: [],
    }),
    configResolver: async () => ({ serverBaseUrl: 'http://127.0.0.1:43127' }),
    clientFactory: () => ({
      importExecutions: async () => {
        const error = new Error('tasks-recorder taskd is unavailable')
        error.code = 'SERVICE_UNAVAILABLE'
        throw error
      },
    }),
  }), (error) => error.code === 'SERVICE_UNAVAILABLE')
})

test('CLI main returns stable success and failure exit codes with JSON-only stdout', async () => {
  let stdout = ''
  let stderr = ''
  const success = await runCliMain([], {
    stdout: { write: (value) => { stdout += value } },
    stderr: { write: (value) => { stderr += value } },
    controlRunner: async () => ({ ready: true }),
  })
  assert.equal(success, 0)
  assert.deepEqual(JSON.parse(stdout), { ready: true })
  assert.equal(stderr, '')

  stdout = ''
  const failure = await runCliMain(['invalid'], {
    stdout: { write: (value) => { stdout += value } },
    stderr: { write: (value) => { stderr += value } },
  })
  assert.equal(failure, 1)
  assert.equal(stdout, '')
  assert.match(stderr, /usage:/)
})
