import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

import { buildAdapters } from '../scripts/build-adapters.mjs'

const projectRoot = resolve(new URL('..', import.meta.url).pathname)

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

function mcpExchange(script, homeDirectory) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [script], {
      cwd: projectRoot,
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
  assert.deepEqual(mcp.mcpServers['tasks-recorder'].args, ['${PLUGIN_ROOT}/dist/mcp-server.mjs'])
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
      assert.ok(tools.result.tools.some(({ name }) => name === 'agent_tasks_context'))
      assert.ok(tools.result.tools.some(({ name }) => name === 'agent_tasks_complete'))
    }
  } finally {
    await rm(homeDirectory, { recursive: true, force: true })
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
