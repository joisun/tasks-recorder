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
    response.end(JSON.stringify(request.method === 'GET' ? sessionContext : { changed: true }))
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

test('each adapter hook emits host-specific task context', async () => {
  for (const [host, script, rootVariable] of [
    ['Codex', 'adapters/codex/tasks-recorder/hooks/user-prompt-task-sync.mjs', 'PLUGIN_ROOT'],
    ['Claude', 'adapters/claude/tasks-recorder/hooks/user-prompt-task-sync.mjs', 'CLAUDE_PLUGIN_ROOT'],
  ]) {
    const result = await runHook(script, {
      hook_event_name: 'UserPromptSubmit',
      session_id: 'session-1',
      cwd: '/workspace/example',
    }, { [rootVariable]: join(projectRoot, script, '..', '..') })
    assert.equal(result.code, 0)
    const output = JSON.parse(result.stdout)
    assert.match(output.hookSpecificOutput.additionalContext, new RegExp(`"agent":"${host}"`))
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

test('Codex native hooks send stable lifecycle records and state-aware sync feedback', async () => {
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
  const server = await hookServer({
    sessionContext: {
      root_session_id: 'root-session',
      pending_plan_observation_count: 1,
      unassigned_execution_count: 1,
      active_executions: [{ id: 'execution-1', task_id: 'task-a', classification: 'work' }],
    },
  })
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
      ['session-end.mjs', {
        hook_event_name: 'SessionEnd', session_id: 'root-session', cwd: '/workspace',
        transcript_path: parentTranscript, reason: 'other',
      }],
      ['stop-task-check.mjs', {
        hook_event_name: 'Stop', session_id: 'root-session', turn_id: 'turn-1',
        cwd: '/workspace', transcript_path: parentTranscript, stop_hook_active: false,
      }],
    ]
    const results = []
    for (const [name, input] of cases) {
      const result = await runHook(`adapters/codex/tasks-recorder/hooks/${name}`, input, env)
      assert.equal(result.code, 0, `${name}: ${result.stderr}`)
      results.push(result.stdout === '' ? null : JSON.parse(result.stdout))
    }

    assert.match(results[1].hookSpecificOutput.additionalContext, /agent_tasks_sync_tree/)
    assert.match(results[2].hookSpecificOutput.additionalContext, /update_plan/)
    assert.deepEqual(results[4], {})
    assert.equal(results[6].decision, 'block')
    assert.match(results[6].reason, /未绑定|unassigned/i)

    assert.deepEqual(server.requests.map(({ method, url }) => [method, url]), [
      ['POST', '/api/v1/lifecycle/session-start'],
      ['POST', '/api/v1/lifecycle/turn-start'],
      ['POST', '/api/v1/lifecycle/tool-use'],
      ['POST', '/api/v1/lifecycle/subagent-start'],
      ['POST', '/api/v1/lifecycle/subagent-stop'],
      ['POST', '/api/v1/lifecycle/session-end'],
      ['GET', '/api/v1/sessions/root-session/context'],
    ])
    assert.equal(server.requests[1].body.external_key, 'codex:turn:root-session:turn-1:0')
    assert.equal(server.requests[2].body.external_key, 'codex:tool:root-session:turn-1:tool-use-1')
    assert.deepEqual(server.requests[2].body.plan, {
      explanation: 'Refine', plan: [{ step: 'Build', status: 'in_progress' }],
    })
    assert.equal(JSON.stringify(server.requests[2].body).includes('must-not-be-forwarded'), false)
    assert.equal(server.requests[3].body.external_key, 'codex:subagent:root-session:child-session')
    assert.equal(server.requests[3].body.session_id, 'child-session')
    assert.equal(server.requests[4].body.agent_path, '/root/researcher')
    assert.equal(server.requests[4].body.transcript_path.endsWith('/child.jsonl'), true)
  } finally {
    await server.close()
    await rm(homeDirectory, { recursive: true, force: true })
  }
})

test('Codex lifecycle hooks fail open and Stop does not loop', async () => {
  const env = { AGENT_TASKS_SERVER_URL: 'http://127.0.0.1:9' }
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
  try {
    for (const host of ['codex', 'claude']) {
      const hook = await runHook(`adapters/${host}/tasks-recorder/hooks/task-heartbeat.mjs`, {
        hook_event_name: 'PostToolUse', session_id: 'session-1', tool_name: 'Bash',
      }, { AGENT_TASKS_SERVER_URL: remoteOverride })
      assert.equal(hook.code, 0)

      const bundle = `adapters/${host}/tasks-recorder/dist/mcp-server.mjs`
      const mcp = await runScript(bundle, { AGENT_TASKS_SERVER_URL: remoteOverride })
      assert.notEqual(mcp.code, 0)
      assert.match(mcp.stderr, /127\.0\.0\.1/)
    }
    assert.equal(requests, 0)
  } finally {
    await new Promise((resolveClose, reject) => probe.close((error) => error ? reject(error) : resolveClose()))
  }
})
