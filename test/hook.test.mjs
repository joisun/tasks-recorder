import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { detectAgent } from '../hooks/src/hook-context.mjs'

const projectRoot = new URL('..', import.meta.url).pathname

function runHook(script, input, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      cwd: projectRoot,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr }))
    child.stdin.end(JSON.stringify(input))
  })
}

async function hookFixture() {
  const homeDirectory = await mkdtemp(join(tmpdir(), 'tasks-recorder-root-hook-'))
  const configDirectory = join(homeDirectory, '.config', 'tasks-recorder')
  await mkdir(configDirectory, { recursive: true })
  await writeFile(join(configDirectory, 'config.json'), JSON.stringify({
    output_dir: '.',
    server_host: '127.0.0.1',
    server_port: 43127,
  }))
  const requests = []
  const server = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end('{"ok":true,"persisted":true}')
  })
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  const { port } = server.address()
  return {
    homeDirectory,
    requests,
    env: {
      HOME: homeDirectory,
      AGENT_TASKS_SERVER_URL: `http://127.0.0.1:${port}`,
    },
    async cleanup() {
      await new Promise((resolveClose, reject) => server.close((error) => (
        error ? reject(error) : resolveClose()
      )))
      await rm(homeDirectory, { recursive: true, force: true })
    },
  }
}

test('detectAgent identifies Codex and Claude transcript roots', () => {
  assert.equal(detectAgent({ transcript_path: '/Users/me/.codex/sessions/a.jsonl' }), 'Codex')
  assert.equal(detectAgent({ transcript_path: '/Users/me/.claude/projects/a.jsonl' }), 'Claude')
  assert.equal(detectAgent({ transcript_path: null }), 'Unknown')
})
test('canonical hooks emit the same Event Envelope contract and never block Stop', async () => {
  const fixture = await hookFixture()
  const base = {
    session_id: 'session-1',
    cwd: '/workspace/example',
    transcript_path: '/Users/me/.codex/sessions/a.jsonl',
  }
  try {
    const cases = [
      ['hooks/session-start.mjs', { ...base, hook_event_name: 'SessionStart' }],
      ['hooks/user-prompt-task-sync.mjs', {
        ...base, hook_event_name: 'UserPromptSubmit', turn_id: 'turn-1',
        prompt: 'private prompt',
      }],
      ['hooks/task-heartbeat.mjs', {
        ...base, hook_event_name: 'PostToolUse', turn_id: 'turn-1',
        tool_name: 'Bash', tool_use_id: 'tool-1',
        tool_input: { secret: 'private input' },
      }],
      ['hooks/stop-task-check.mjs', {
        ...base, hook_event_name: 'Stop', turn_id: 'turn-1', stop_hook_active: false,
      }],
      ['hooks/session-end.mjs', { ...base, hook_event_name: 'SessionEnd' }],
    ]
    const results = []
    for (const [script, input] of cases) {
      const result = await runHook(script, input, fixture.env)
      assert.equal(result.code, 0, `${script}: ${result.stderr}`)
      results.push(result.stdout === '' ? null : JSON.parse(result.stdout))
    }

    assert.match(results[1].hookSpecificOutput.additionalContext, /agent_work_context/)
    assert.match(results[1].hookSpecificOutput.additionalContext, /"execution_id":"execution-/)
    assert.doesNotMatch(results[1].hookSpecificOutput.additionalContext, /agent_tasks_sync_tree/)
    assert.deepEqual(results[3], {})
    assert.deepEqual(fixture.requests.map(({ event_type }) => event_type), [
      'session.started',
      'execution.started',
      'execution.heartbeat',
      'execution.stop',
      'session.ended',
    ])
    assert.ok(fixture.requests.every(({ source }) => source === 'codex'))
    assert.equal(JSON.stringify(fixture.requests).includes('private'), false)
  } finally {
    await fixture.cleanup()
  }
})

test('canonical lifecycle hooks fail open while taskd is unavailable', async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), 'tasks-recorder-root-fail-open-'))
  const configDirectory = join(homeDirectory, '.config', 'tasks-recorder')
  await mkdir(configDirectory, { recursive: true })
  await writeFile(join(configDirectory, 'config.json'), JSON.stringify({
    output_dir: '.',
    server_host: '127.0.0.1',
    server_port: 43127,
  }))
  const env = {
    HOME: homeDirectory,
    AGENT_TASKS_SERVER_URL: 'http://127.0.0.1:9',
  }
  const input = {
    session_id: 'session-1',
    turn_id: 'turn-1',
    cwd: '/workspace/example',
    transcript_path: '/Users/me/.codex/sessions/a.jsonl',
  }
  try {
    const heartbeat = await runHook('hooks/task-heartbeat.mjs', {
      ...input, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'tool-1',
    }, env)
    assert.equal(heartbeat.code, 0)
    assert.equal(heartbeat.stdout, '')

    const stop = await runHook('hooks/stop-task-check.mjs', {
      ...input, hook_event_name: 'Stop', stop_hook_active: false,
    }, env)
    assert.equal(stop.code, 0)
    assert.deepEqual(JSON.parse(stop.stdout), {})
  } finally {
    await rm(homeDirectory, { recursive: true, force: true })
  }
})
