import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { startTaskd } from '../server/src/taskd-runtime.mjs'

const SESSION_ID = '019fcfae-8d5b-7640-aec8-83a114810589'

async function writeFakeCodex(directory) {
  const path = join(directory, 'codex')
  await writeFile(path, `#!/usr/bin/env node
const readline = require('node:readline')
const args = process.argv.slice(2)
if (args.includes('--version')) {
  process.stdout.write('codex-cli 0.999.0\\n')
  process.exit(0)
}
if (args[0] === 'login' && args[1] === 'status') {
  process.stdout.write('Logged in\\n')
  process.exit(0)
}
if (args[0] === 'mcp' && args[1] === 'list' && args[2] === '--json') {
  if (!args.includes('--disable') || !args.includes('plugins')
    || !args.includes('apps._default.enabled=false')) process.exit(15)
  process.stdout.write('[]\\n')
  process.exit(0)
}
if (args[0] !== 'app-server') process.exit(12)
if (!args.includes('--disable') || !args.includes('plugins')
  || !args.includes('apps._default.enabled=false')) process.exit(16)
const rl = readline.createInterface({ input: process.stdin })
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n')
const result = (id, value) => send({ jsonrpc: '2.0', id, result: value })
let turnStarted = false
rl.on('line', (line) => {
  const request = JSON.parse(line)
  if (request.method === 'initialize') return result(request.id, { userAgent: 'codex-cli 0.999.0' })
  if (request.method === 'skills/list') {
    if (request.params.forceReload !== true) process.exit(17)
    return result(request.id, { data: [{
      cwd: request.params.cwds[0], errors: [],
      skills: [{ name: 'report', path: '/skills/report/SKILL.md', enabled: true }],
    }] })
  }
  if (request.method === 'thread/start') {
    const config = request.params.config
    if (config?.skills?.config?.[0]?.path !== '/skills/report/SKILL.md'
      || config.skills.config[0].enabled !== false
      || config.features?.skill_search !== false
      || config.features?.skill_mcp_dependency_install !== false
      || JSON.stringify(config).includes('web_search')) process.exit(18)
    return result(request.id, { thread: { id: '${SESSION_ID}', turns: [] } })
  }
  if (request.method === 'turn/start') {
    if (!request.params.input[0].text.includes('Create the report')) process.exit(13)
    result(request.id, { turn: { id: 'turn-1', status: 'inProgress', items: [] } })
    turnStarted = true
    send({ jsonrpc: '2.0', method: 'turn/started', params: { threadId: '${SESSION_ID}', turn: { id: 'turn-1', status: 'inProgress', items: [] } } })
    send({ jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { threadId: '${SESSION_ID}', turnId: 'turn-1', itemId: 'message-1', delta: 'Starting report. ' } })
    return
  }
  if (request.method === 'turn/steer' && turnStarted) {
    if (request.params.expectedTurnId !== 'turn-1' || !request.params.input[0].text.includes('summary')) process.exit(14)
    result(request.id, { turnId: 'turn-1' })
    send({ jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { threadId: '${SESSION_ID}', turnId: 'turn-1', itemId: 'message-1', delta: 'Added summary.' } })
    send({ jsonrpc: '2.0', method: 'item/completed', params: { threadId: '${SESSION_ID}', turnId: 'turn-1', item: { id: 'files-1', type: 'fileChange', status: 'completed', changes: [{ path: 'report.md', kind: 'update' }] } } })
    send({ jsonrpc: '2.0', method: 'item/completed', params: { threadId: '${SESSION_ID}', turnId: 'turn-1', item: { id: 'message-1', type: 'agentMessage', text: 'Report created with summary.' } } })
    send({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: '${SESSION_ID}', turn: { id: 'turn-1', status: 'completed', items: [] } } })
    return
  }
  if (request.method === 'turn/interrupt') {
    result(request.id, {})
    send({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: '${SESSION_ID}', turn: { id: 'turn-1', status: 'interrupted', items: [] } } })
  }
})
`, { mode: 0o700 })
  await chmod(path, 0o700)
  return path
}

async function request(url, path, { method = 'GET', body } = {}) {
  const response = await fetch(`${url}${path}`, {
    method,
    ...(body === undefined ? {} : {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  })
  return { status: response.status, body: await response.json() }
}

async function waitForRun(url, runId) {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const result = await request(url, `/api/v1/runs/${runId}`)
    if (!['queued', 'running'].includes(result.body.run.status)) return result.body.run
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('Run did not finish')
}

async function waitForActiveTurn(url, runId) {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const result = await request(url, `/api/v1/runs/${runId}`)
    if (result.body.run.status === 'running' && result.body.run.turn_revision === 1) {
      return result.body.run
    }
    if (!['queued', 'running'].includes(result.body.run.status)) {
      throw new Error(`Run stopped before exposing an active Turn: ${JSON.stringify(result.body.run)}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('Run did not expose an active Turn')
}

test('taskd executes Markdown Schedules through the direct runtime registry pipeline', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'tasks-recorder-runtime-e2e-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const workspace = join(root, 'workspace')
  const data = join(root, 'data')
  await mkdir(workspace)
  await mkdir(data)
  const codexPath = await writeFakeCodex(root)

  const runtime = await startTaskd({
    config: {
      databasePath: join(data, 'journal.sqlite'),
      schedulerDatabasePath: join(data, 'scheduler.sqlite'),
      scheduleDefinitionsDirectory: join(data, 'schedules'),
      schedulerLogsDirectory: join(data, 'run-logs'),
      codexPath,
      outputDir: root,
      serverHost: '127.0.0.1',
      serverPort: 0,
    },
    dashboardPath: join(root, 'index.html'),
    dashboardHtml: '<!doctype html><title>Tasks Recorder</title>',
    gitResolver: async () => ({}),
    renderer: async () => ({}),
    dashboardAdapter: () => ({ generated_at: new Date().toISOString(), tasks: [], warnings: [] }),
  })
  t.after(() => runtime.close())

  assert.equal(runtime.scheduler.ready, true)
  const created = await request(runtime.address.url, '/api/v1/schedules', {
    method: 'POST',
    body: {
      title: 'Create report',
      prompt: 'Create the report in report.md.',
      workspace,
      agent: 'codex',
      cadence: { kind: 'daily', hour: 9, minute: 0 },
      sandbox_mode: 'workspace-write',
      model: null,
      reasoning_effort: null,
      timeout_seconds: 600,
    },
  })
  assert.equal(created.status, 200, JSON.stringify(created.body))
  assert.equal(created.body.job.agent, 'codex')
  assert.deepEqual(created.body.job.capabilities, {
    skills: 'disabled',
    integrations: 'disabled',
  })

  const launched = await request(runtime.address.url, '/api/v1/runs', {
    method: 'POST',
    body: {
      schedule_id: created.body.job.id,
      origin: 'manual',
      idempotency_key: 'manual-e2e-run',
    },
  })
  assert.equal(launched.status, 202, JSON.stringify(launched.body))
  assert.equal(launched.body.run.status, 'queued')

  const active = await waitForActiveTurn(runtime.address.url, launched.body.run.id)
  assert.equal(active.interactive, true)
  assert.equal(active.session_id, null)

  const steered = await request(runtime.address.url, `/api/v1/runs/${active.id}/steer`, {
    method: 'POST',
    body: { expected_turn_revision: 1, text: 'Please add a summary.' },
  })
  assert.equal(steered.status, 202, JSON.stringify(steered.body))
  assert.deepEqual(steered.body, {
    accepted: true,
    run_id: active.id,
    turn_revision: 1,
  })

  const run = await waitForRun(runtime.address.url, launched.body.run.id)
  assert.equal(run.status, 'succeeded')
  assert.equal(run.runtime_id, 'codex')
  assert.equal(run.session_id, SESSION_ID)
  assert.deepEqual(run.file_changes, [
    { path: 'report.md', kind: 'update' },
  ])
  assert.equal(run.final_message, 'Report created with summary.')
})
