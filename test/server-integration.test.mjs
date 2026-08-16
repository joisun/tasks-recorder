import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

import { temporaryApi } from './helpers.mjs'

test('stdio MCP is a thin client of taskd and exposes no embedded Dashboard resources', async () => {
  const taskd = await temporaryApi()
  const dataDirectory = join(taskd.directory, '.config', 'tasks-recorder')
  await mkdir(dataDirectory, { recursive: true })
  await writeFile(join(dataDirectory, 'config.json'), JSON.stringify({ output_dir: taskd.directory }))
  const serverPath = new URL('../mcp/server.mjs', import.meta.url).pathname
  const inheritedEnv = Object.fromEntries(Object.entries(process.env).filter((entry) => entry[1] !== undefined))
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    cwd: taskd.directory,
    env: {
      ...inheritedEnv,
      HOME: taskd.directory,
      AGENT_TASKS_SERVER_URL: taskd.url,
      AGENT_TASKS_DATABASE_PATH: taskd.databasePath,
      AGENT_TASKS_OUTPUT_DIR: taskd.directory,
    },
    stderr: 'pipe',
    maxBufferSize: 5 * 1024 * 1024,
  })
  const client = new Client({ name: 'integration-test', version: '1.0.0' })
  try {
    await client.connect(transport)
    const tools = await client.listTools()
    assert.deepEqual(
      tools.tools.map(({ name }) => name).sort(),
      [
        'agent_task_execution_assign', 'agent_task_execution_classify',
        'agent_task_executions_list', 'agent_tasks_archive',
        'agent_tasks_check', 'agent_tasks_complete', 'agent_tasks_context', 'agent_tasks_list',
        'agent_tasks_render', 'agent_tasks_restore', 'agent_tasks_show',
        'agent_tasks_sync_tree', 'agent_tasks_update', 'agent_tasks_upsert',
      ],
    )

    const written = await client.callTool({
      name: 'agent_tasks_upsert',
      arguments: {
        id: 'mcp-task', title: 'MCP task', status: 'active',
        session_id: 'mcp-session', workfolder: taskd.directory, agent: 'Codex',
      },
    })
    assert.equal(written.structuredContent.change.revision, 1)
    assert.equal(taskd.hub.current().revision, 1)
    assert.equal(taskd.store.show('mcp-task').task.title, 'MCP task')

    const shown = await client.callTool({ name: 'agent_tasks_show', arguments: { id: 'mcp-task' } })
    assert.equal(shown.structuredContent.task.title, 'MCP task')
    const completed = await client.callTool({
      name: 'agent_tasks_complete',
      arguments: { id: 'mcp-task', session_id: 'mcp-session', workfolder: taskd.directory, agent: 'Codex' },
    })
    assert.equal(completed.structuredContent.task.status, 'done')
    assert.equal(taskd.hub.current().revision, 2)
  } finally {
    await client.close().catch(() => {})
    await taskd.cleanup()
  }
})
