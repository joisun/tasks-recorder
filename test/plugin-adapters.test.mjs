import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import { buildAdapters } from '../scripts/build-adapters.mjs'

const projectRoot = resolve(new URL('..', import.meta.url).pathname)
const execFileAsync = promisify(execFile)

async function readJson(path) {
  return JSON.parse(await readFile(join(projectRoot, path), 'utf8'))
}

function runHook(script, input, env = {}) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [join(projectRoot, script)], {
      cwd: projectRoot,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (code) => resolveResult({ code, stdout, stderr }))
    child.stdin.end(JSON.stringify(input))
  })
}

function runScript(script, env = {}) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [join(projectRoot, script)], {
      cwd: projectRoot,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (code) => resolveResult({ code, stdout, stderr }))
  })
}

async function hookServer({ sessionContext = {} } = {}) {
  const requests = []
  const server = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    requests.push({
      method: request.method,
      url: request.url,
      body: chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null,
    })
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify(request.method === 'GET'
      ? sessionContext
      : { ok: true, persisted: true }))
  })
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  const { port } = server.address()
  return {
    requests,
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolveClose, reject) => server.close((error) => (
      error ? reject(error) : resolveClose()
    ))),
  }
}

function mcpExchange(script, homeDirectory) {
  return mcpProcessExchange({
    command: process.execPath,
    args: [script],
    cwd: projectRoot,
    homeDirectory,
  })
}

function mcpProcessExchange({ command, args, cwd, homeDirectory }) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, HOME: homeDirectory },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    const responses = []
    const timeout = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`MCP handshake timed out: ${stderr}`))
    }, 5_000)

    child.stdout.on('data', (chunk) => {
      stdout += chunk
      const lines = stdout.split('\n')
      stdout = lines.pop()
      for (const line of lines.filter(Boolean)) responses.push(JSON.parse(line))
      if (responses.some((entry) => entry.id === 2)) {
        clearTimeout(timeout)
        child.stdin.end()
        child.kill('SIGTERM')
        resolveResult(responses)
      }
    })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', reject)
    child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'adapter-test', version: '1.0.0' },
      },
    })}\n`)
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`)
  })
}

test('Codex adapter uses a native manifest, marketplace entry, and MCP config', async () => {
  const manifest = await readJson('adapters/codex/tasks-recorder/.codex-plugin/plugin.json')
  const marketplace = await readJson('.agents/plugins/marketplace.json')
  const mcp = await readJson('adapters/codex/tasks-recorder/.mcp.json')

  assert.equal(manifest.name, 'tasks-recorder')
  assert.equal(manifest.mcpServers, './.mcp.json')
  assert.equal(manifest.license, 'GPL-2.0-only')
  assert.equal(marketplace.name, 'tasks-recorder')
  assert.deepEqual(marketplace.plugins[0].source, {
    source: 'local', path: './adapters/codex/tasks-recorder',
  })
  assert.deepEqual(marketplace.plugins[0].policy, {
    installation: 'AVAILABLE', authentication: 'ON_INSTALL',
  })
  assert.equal(mcp.mcpServers['tasks-recorder'].command, 'node')
  assert.deepEqual(mcp.mcpServers['tasks-recorder'].args, ['dist/mcp-server.mjs'])
  assert.equal(mcp.mcpServers['tasks-recorder'].cwd, '.')
})

test('Claude adapter uses a native manifest, marketplace entry, and wrapped MCP config', async () => {
  const manifest = await readJson('adapters/claude/tasks-recorder/.claude-plugin/plugin.json')
  const marketplace = await readJson('.claude-plugin/marketplace.json')
  const mcp = await readJson('adapters/claude/tasks-recorder/.mcp.json')

  assert.equal(manifest.name, 'tasks-recorder')
  assert.equal(manifest.mcpServers, './.mcp.json')
  assert.equal(manifest.license, 'GPL-2.0-only')
  assert.equal(marketplace.name, 'tasks-recorder')
  assert.equal(marketplace.plugins[0].source, './adapters/claude/tasks-recorder')
  assert.equal(mcp.mcpServers['tasks-recorder'].command, 'node')
  assert.deepEqual(
    mcp.mcpServers['tasks-recorder'].args,
    ['${CLAUDE_PLUGIN_ROOT}/dist/mcp-server.mjs'],
  )
})

test('each adapter emits host-specific execution context after recording the native turn', async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), 'tasks-recorder-host-context-'))
  const server = await hookServer()
  const env = { HOME: homeDirectory, AGENT_TASKS_SERVER_URL: server.url }
  try {
    const codex = await runHook(
      'adapters/codex/tasks-recorder/hooks/user-prompt-task-sync.mjs',
      {
        hook_event_name: 'UserPromptSubmit', session_id: 'codex-session',
        turn_id: 'codex-turn', cwd: '/workspace/example', prompt: 'private prompt',
      },
      env,
    )
    const claude = await runHook(
      'adapters/claude/tasks-recorder/hooks/user-prompt-task-sync.mjs',
      {
        hook_event_name: 'UserPromptSubmit', session_id: 'claude-session',
        cwd: '/workspace/example', prompt: 'private prompt',
      },
      env,
    )
    for (const [host, result] of [['Codex', codex], ['Claude', claude]]) {
      assert.equal(result.code, 0)
      const output = JSON.parse(result.stdout)
      assert.match(output.hookSpecificOutput.additionalContext, new RegExp(`"agent":"${host}"`))
      assert.match(output.hookSpecificOutput.additionalContext, /"execution_id":"execution-/)
      assert.match(output.hookSpecificOutput.additionalContext, /agent_work_context/)
      assert.doesNotMatch(output.hookSpecificOutput.additionalContext, /agent_tasks_sync_tree/)
    }
    assert.deepEqual(server.requests.map(({ body }) => body.source), ['codex', 'claude'])
    assert.equal(JSON.stringify(server.requests).includes('private prompt'), false)
  } finally {
    await server.close()
    await rm(homeDirectory, { recursive: true, force: true })
  }
})

test('Codex adapter config registers the complete native lifecycle hook surface', async () => {
  const config = await readJson('adapters/codex/tasks-recorder/hooks/hooks.json')
  assert.deepEqual(Object.keys(config.hooks).sort(), [
    'PostToolUse',
    'SessionEnd',
    'SessionStart',
    'Stop',
    'SubagentStart',
    'SubagentStop',
    'UserPromptSubmit',
  ])
  assert.match(config.hooks.PostToolUse[0].matcher, /\.\*/)
  assert.equal('matcher' in config.hooks.Stop[0], false)
  assert.equal(config.hooks.SessionEnd[0].hooks[0].timeout <= 3, true)
})

test('Codex native hooks emit privacy-bounded Event Envelopes without Stop continuation', async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), 'tasks-recorder-codex-hooks-'))
  const sessionsRoot = join(homeDirectory, '.codex', 'sessions')
  await mkdir(sessionsRoot, { recursive: true })
  const parentTranscript = join(sessionsRoot, 'root.jsonl')
  const childTranscript = join(sessionsRoot, 'child.jsonl')
  await writeFile(parentTranscript, JSON.stringify({
    type: 'session_meta', payload: { id: 'root-session', cwd: '/workspace' },
  }))
  await writeFile(childTranscript, JSON.stringify({
    type: 'session_meta',
    payload: {
      id: 'child-session', cwd: '/workspace',
      source: { subagent: { thread_spawn: {
        parent_thread_id: 'root-session', agent_path: '/root/researcher', agent_type: 'explorer',
      } } },
    },
  }))
  const server = await hookServer()
  const env = { HOME: homeDirectory, AGENT_TASKS_SERVER_URL: server.url }
  try {
    const cases = [
      ['session-start.mjs', {
        hook_event_name: 'SessionStart', session_id: 'root-session', cwd: '/workspace',
        transcript_path: parentTranscript, source: 'startup', model: 'gpt-5.6',
      }],
      ['user-prompt-task-sync.mjs', {
        hook_event_name: 'UserPromptSubmit', session_id: 'root-session', turn_id: 'turn-1',
        cwd: '/workspace', transcript_path: parentTranscript, prompt: 'Implement the task tree',
      }],
      ['task-heartbeat.mjs', {
        hook_event_name: 'PostToolUse', session_id: 'root-session', turn_id: 'turn-1',
        cwd: '/workspace', transcript_path: parentTranscript, tool_name: 'update_plan',
        tool_use_id: 'tool-use-1',
        tool_input: { explanation: 'Refine', plan: [{ step: 'Build', status: 'in_progress' }] },
        tool_response: { private: 'must-not-be-forwarded' },
      }],
      ['subagent-start.mjs', {
        hook_event_name: 'SubagentStart', session_id: 'root-session', turn_id: 'turn-1',
        cwd: '/workspace', transcript_path: parentTranscript,
        agent_id: 'child-session', agent_type: 'explorer',
      }],
      ['subagent-stop.mjs', {
        hook_event_name: 'SubagentStop', session_id: 'root-session', turn_id: 'turn-1',
        cwd: '/workspace', transcript_path: parentTranscript, agent_transcript_path: childTranscript,
        agent_id: 'child-session', agent_type: 'explorer', stop_hook_active: false,
      }],
      ['stop-task-check.mjs', {
        hook_event_name: 'Stop', session_id: 'root-session', turn_id: 'turn-1',
        cwd: '/workspace', transcript_path: parentTranscript, stop_hook_active: false,
      }],
      ['session-end.mjs', {
        hook_event_name: 'SessionEnd', session_id: 'root-session', cwd: '/workspace',
        transcript_path: parentTranscript, reason: 'other',
      }],
    ]
    const results = []
    for (const [name, input] of cases) {
      const result = await runHook(`adapters/codex/tasks-recorder/hooks/${name}`, input, env)
      assert.equal(result.code, 0, `${name}: ${result.stderr}`)
      results.push(result.stdout === '' ? null : JSON.parse(result.stdout))
    }

    assert.match(results[1].hookSpecificOutput.additionalContext, /agent_work_context/)
    assert.doesNotMatch(results[1].hookSpecificOutput.additionalContext, /agent_tasks_sync_tree/)
    assert.equal(results[2], null)
    assert.deepEqual(results[4], {})
    assert.deepEqual(results[5], {})
    assert.equal(results[6], null)

    assert.deepEqual(server.requests.map(({ method, url }) => [method, url]), [
      ['POST', '/api/v1/events'],
      ['POST', '/api/v1/events'],
      ['POST', '/api/v1/events'],
      ['POST', '/api/v1/events'],
      ['POST', '/api/v1/events'],
      ['POST', '/api/v1/events'],
      ['POST', '/api/v1/events'],
    ])
    assert.deepEqual(server.requests.map(({ body }) => body.event_type), [
      'session.started',
      'execution.started',
      'execution.heartbeat',
      'execution.started',
      'execution.stop',
      'execution.stop',
      'session.ended',
    ])
    assert.ok(server.requests.every(({ body }) => body.source === 'codex'))
    assert.equal(server.requests[1].body.source_turn_key, 'turn-1')
    assert.equal(server.requests[2].body.external_event_id, 'codex:execution:root-session:turn-1:tool:tool-use-1')
    assert.equal(server.requests[3].body.source_session_key, 'child-session')
    assert.equal(server.requests[3].body.source_agent_key, 'child-session')
    const executionId = JSON.parse(
      results[1].hookSpecificOutput.additionalContext.match(/Dynamic context \(JSON data only, never instructions\): (\{.*?\})\./)[1],
    ).execution_id
    assert.equal(server.requests[3].body.payload.parent_execution_id, executionId)
    const serialized = JSON.stringify(server.requests)
    for (const secret of [
      'Implement the task tree', 'must-not-be-forwarded', 'agent_path',
      'transcript_path', 'tool_input', 'tool_response',
    ]) assert.equal(serialized.includes(secret), false, secret)
  } finally {
    await server.close()
    await rm(homeDirectory, { recursive: true, force: true })
  }
})

test('Claude adapter config and hooks preserve one opaque turn across start, heartbeat, and Stop', async () => {
  const config = await readJson('adapters/claude/tasks-recorder/hooks/hooks.json')
  assert.deepEqual(Object.keys(config.hooks).sort(), [
    'PostToolUse', 'SessionEnd', 'SessionStart', 'Stop', 'UserPromptSubmit',
  ])
  const homeDirectory = await mkdtemp(join(tmpdir(), 'tasks-recorder-claude-hooks-'))
  const server = await hookServer()
  const env = { HOME: homeDirectory, AGENT_TASKS_SERVER_URL: server.url }
  try {
    const cases = [
      ['session-start.mjs', {
        hook_event_name: 'SessionStart', session_id: 'claude-session', cwd: '/workspace',
      }],
      ['user-prompt-task-sync.mjs', {
        hook_event_name: 'UserPromptSubmit', session_id: 'claude-session', cwd: '/workspace',
        prompt: 'private Claude prompt',
      }],
      ['task-heartbeat.mjs', {
        hook_event_name: 'PostToolUse', session_id: 'claude-session', cwd: '/workspace',
        tool_name: 'Bash', tool_use_id: 'tool-1', tool_input: { secret: 'private input' },
        tool_response: { secret: 'private output' },
      }],
      ['stop-task-check.mjs', {
        hook_event_name: 'Stop', session_id: 'claude-session', cwd: '/workspace',
        stop_hook_active: false,
      }],
      ['session-end.mjs', {
        hook_event_name: 'SessionEnd', session_id: 'claude-session', cwd: '/workspace',
      }],
    ]
    const results = []
    for (const [name, input] of cases) {
      const result = await runHook(`adapters/claude/tasks-recorder/hooks/${name}`, input, env)
      assert.equal(result.code, 0, `${name}: ${result.stderr}`)
      results.push(result.stdout === '' ? null : JSON.parse(result.stdout))
    }
    assert.match(results[1].hookSpecificOutput.additionalContext, /agent_work_context/)
    assert.deepEqual(results[3], {})
    assert.deepEqual(server.requests.map(({ body }) => body.event_type), [
      'session.started', 'execution.started', 'execution.heartbeat',
      'execution.stop', 'session.ended',
    ])
    assert.deepEqual(server.requests.slice(1, 4).map(({ body }) => body.source_turn_key), [
      'turn-1', 'turn-1', 'turn-1',
    ])
    assert.ok(server.requests.every(({ body }) => body.source === 'claude'))
    assert.equal(JSON.stringify(server.requests).includes('private'), false)
  } finally {
    await server.close()
    await rm(homeDirectory, { recursive: true, force: true })
  }
})

test('Codex lifecycle hooks fail open and Stop does not loop', async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), 'tasks-recorder-fail-open-'))
  const env = { HOME: homeDirectory, AGENT_TASKS_SERVER_URL: 'http://127.0.0.1:9' }
  try {
    for (const [name, input] of [
      ['session-start.mjs', { hook_event_name: 'SessionStart', session_id: 's', cwd: '/w' }],
      ['user-prompt-task-sync.mjs', { hook_event_name: 'UserPromptSubmit', session_id: 's', turn_id: 't', cwd: '/w' }],
      ['task-heartbeat.mjs', { hook_event_name: 'PostToolUse', session_id: 's', turn_id: 't', cwd: '/w', tool_name: 'Bash', tool_use_id: 'u' }],
      ['subagent-start.mjs', { hook_event_name: 'SubagentStart', session_id: 's', turn_id: 't', cwd: '/w', agent_id: 'a', agent_type: 'worker' }],
      ['subagent-stop.mjs', { hook_event_name: 'SubagentStop', session_id: 's', turn_id: 't', cwd: '/w', agent_id: 'a', agent_type: 'worker' }],
      ['session-end.mjs', { hook_event_name: 'SessionEnd', session_id: 's', cwd: '/w', reason: 'other' }],
      ['stop-task-check.mjs', { hook_event_name: 'Stop', session_id: 's', turn_id: 't', cwd: '/w', stop_hook_active: false }],
      ['stop-task-check.mjs', { hook_event_name: 'Stop', session_id: 's', turn_id: 't', cwd: '/w', stop_hook_active: true }],
    ]) {
      const result = await runHook(`adapters/codex/tasks-recorder/hooks/${name}`, input, env)
      assert.equal(result.code, 0, name)
      if (name === 'subagent-stop.mjs' || name === 'stop-task-check.mjs') {
        assert.deepEqual(JSON.parse(result.stdout), {})
      }
    }
  } finally {
    await rm(homeDirectory, { recursive: true, force: true })
  }
})

test('both bundled MCP clients initialize and advertise task tools without project node_modules', async () => {
  await buildAdapters({ projectRoot })
  const homeDirectory = await mkdtemp(join(tmpdir(), 'tasks-recorder-adapter-'))
  try {
    const configDirectory = join(homeDirectory, '.config', 'tasks-recorder')
    await mkdir(configDirectory, { recursive: true })
    await writeFile(join(configDirectory, 'config.json'), JSON.stringify({
      output_dir: '.', server_host: '127.0.0.1', server_port: 43127,
    }))

    for (const host of ['codex', 'claude']) {
      const script = join(projectRoot, 'adapters', host, 'tasks-recorder', 'dist', 'mcp-server.mjs')
      const responses = await mcpExchange(script, homeDirectory)
      const initialized = responses.find((entry) => entry.id === 1)
      const tools = responses.find((entry) => entry.id === 2)
      assert.equal(initialized.result.serverInfo.name, 'tasks-recorder')
      const names = new Set(tools.result.tools.map(({ name }) => name))
      for (const name of [
        'agent_work_context',
        'agent_work_focus',
        'agent_work_intent',
        'agent_work_checkpoint',
        'agent_work_attribution_correct',
        'agent_tasks_mutate',
        'agent_tasks_sync_structure',
        'agent_tasks_context',
        'agent_tasks_complete',
        'agent_tasks_sync_tree',
        'agent_tasks_update',
        'agent_tasks_archive',
        'agent_tasks_restore',
        'agent_task_executions_list',
        'agent_task_execution_assign',
        'agent_task_execution_classify',
      ]) {
        assert.ok(names.has(name), `${host} adapter is missing ${name}`)
      }
    }
  } finally {
    await rm(homeDirectory, { recursive: true, force: true })
  }
})

test('Codex MCP config launches its bundled server outside the plugin directory', async () => {
  await buildAdapters({ projectRoot })
  const homeDirectory = await mkdtemp(join(tmpdir(), 'tasks-recorder-codex-mcp-'))
  try {
    const configDirectory = join(homeDirectory, '.config', 'tasks-recorder')
    await mkdir(configDirectory, { recursive: true })
    await writeFile(join(configDirectory, 'config.json'), JSON.stringify({
      output_dir: '.', server_host: '127.0.0.1', server_port: 43127,
    }))

    const pluginRoot = join(projectRoot, 'adapters', 'codex', 'tasks-recorder')
    const config = await readJson('adapters/codex/tasks-recorder/.mcp.json')
    const server = config.mcpServers['tasks-recorder']
    const workspace = await mkdtemp(join(tmpdir(), 'tasks-recorder-workspace-'))
    try {
      const responses = await mcpProcessExchange({
        command: server.command,
        args: server.args,
        cwd: server.cwd ? resolve(pluginRoot, server.cwd) : workspace,
        homeDirectory,
      })
      const tools = responses.find((entry) => entry.id === 2)
      assert.ok(tools.result.tools.some(({ name }) => name === 'agent_tasks_context'))
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  } finally {
    await rm(homeDirectory, { recursive: true, force: true })
  }
})

test('concurrent adapter builds never publish partial bundles', async () => {
  for (let round = 0; round < 10; round += 1) {
    await Promise.all(Array.from({ length: 6 }, () => buildAdapters({ projectRoot })))
    for (const host of ['codex', 'claude']) {
      const bundle = join(projectRoot, 'adapters', host, 'tasks-recorder', 'dist', 'mcp-server.mjs')
      await execFileAsync(process.execPath, ['--check', bundle])
      assert.match(await readFile(bundle, 'utf8'), /await server\.connect\(new StdioServerTransport\(\)\);/)
    }
  }
})

test('both adapters reject non-127.0.0.1 service overrides before sending hook or MCP traffic', async () => {
  await buildAdapters({ projectRoot })
  let requests = 0
  const probe = createServer((_request, response) => {
    requests += 1
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end('{"ok":true}')
  })
  await new Promise((resolveListen) => probe.listen(0, '127.0.0.1', resolveListen))
  const { port } = probe.address()
  const remoteOverride = `http://localhost:${port}`
  const homeDirectory = await mkdtemp(join(tmpdir(), 'tasks-recorder-remote-origin-'))
  try {
    const codexHook = await runHook('adapters/codex/tasks-recorder/hooks/task-heartbeat.mjs', {
      hook_event_name: 'PostToolUse', session_id: 'session-1', turn_id: 'turn-1',
      cwd: '/workspace', tool_name: 'Bash', tool_use_id: 'tool-1',
    }, { HOME: homeDirectory, AGENT_TASKS_SERVER_URL: remoteOverride })
    assert.equal(codexHook.code, 0)
    const claudeHook = await runHook('adapters/claude/tasks-recorder/hooks/user-prompt-task-sync.mjs', {
      hook_event_name: 'UserPromptSubmit', session_id: 'session-1', cwd: '/workspace',
    }, { HOME: homeDirectory, AGENT_TASKS_SERVER_URL: remoteOverride })
    assert.equal(claudeHook.code, 0)

    for (const host of ['codex', 'claude']) {
      const bundle = `adapters/${host}/tasks-recorder/dist/mcp-server.mjs`
      const mcp = await runScript(bundle, { AGENT_TASKS_SERVER_URL: remoteOverride })
      assert.notEqual(mcp.code, 0)
      assert.match(mcp.stderr, /127\.0\.0\.1/)
    }
    assert.equal(requests, 0)
  } finally {
    await new Promise((resolveClose, reject) => probe.close((error) => error ? reject(error) : resolveClose()))
    await rm(homeDirectory, { recursive: true, force: true })
  }
})
