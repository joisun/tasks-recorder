#!/usr/bin/env node

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

class TaskRecorderError extends Error {
  constructor(code, message, details) {
    super(message)
    this.code = code
    this.details = details
  }
}

function requireLocalOrigin(value) {
  let url
  try {
    url = new URL(value)
  } catch (error) {
    throw new TaskRecorderError('CONFIG_INVALID', 'Tasks Recorder service URL is invalid.', { cause: error.message })
  }
  if (
    url.protocol !== 'http:'
    || url.hostname !== '127.0.0.1'
    || url.username !== ''
    || url.password !== ''
    || !['', '/'].includes(url.pathname)
    || url.search !== ''
    || url.hash !== ''
  ) {
    throw new TaskRecorderError('CONFIG_INVALID', 'Tasks Recorder service URL must be an http://127.0.0.1 origin.')
  }
  return url.origin
}

async function resolveBaseUrl(env = process.env) {
  if (env.AGENT_TASKS_SERVER_URL) return requireLocalOrigin(env.AGENT_TASKS_SERVER_URL)
  let config
  const path = join(homedir(), '.config', 'tasks-recorder', 'config.json')
  try {
    config = JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    throw new TaskRecorderError('CONFIG_INVALID', `Unable to read Tasks Recorder config at ${path}. Install the service first.`, { cause: error.message })
  }
  const host = config.server_host ?? '127.0.0.1'
  const port = config.server_port ?? 43127
  if (host !== '127.0.0.1' || !Number.isInteger(port)) {
    throw new TaskRecorderError('CONFIG_INVALID', 'Tasks Recorder service must use a valid 127.0.0.1 port.')
  }
  return requireLocalOrigin(`http://${host}:${port}`)
}

function createClient(baseUrl) {
  async function request(path, { method = 'GET', body } = {}) {
    let response
    try {
      response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(5_000),
      })
    } catch {
      throw new TaskRecorderError('SERVICE_UNAVAILABLE', 'Tasks Recorder service is unavailable. Run `tasks-recorder status` or install the service.')
    }
    const result = await response.json().catch(() => {
      throw new TaskRecorderError('SERVICE_RESPONSE_INVALID', 'Tasks Recorder service returned invalid JSON.')
    })
    if (!response.ok) {
      throw new TaskRecorderError(result?.error?.code ?? 'SERVICE_REQUEST_FAILED', result?.error?.message ?? `HTTP ${response.status}`, result?.error?.details)
    }
    return result
  }
  return {
    context: (input) => request('/api/v1/context', { method: 'POST', body: input }),
    list: (filters) => {
      const query = new URLSearchParams(Object.entries(filters).filter(([, value]) => value != null))
      return request(`/api/v1/tasks${query.size ? `?${query}` : ''}`).then(({ tasks }) => ({ tasks }))
    },
    show: ({ id }) => request(`/api/v1/tasks/${encodeURIComponent(id)}`),
    upsert: (input) => request(`/api/v1/tasks/${encodeURIComponent(input.id)}`, { method: 'PUT', body: input }),
    complete: (input) => request(`/api/v1/tasks/${encodeURIComponent(input.id)}/complete`, { method: 'POST', body: input }),
    render: () => request('/api/v1/render', { method: 'POST' }),
    check: () => request('/api/v1/check'),
  }
}

const taskId = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
const taskStatus = z.enum(['planned', 'active', 'waiting', 'blocked', 'done'])
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const outputSchema = z.object({}).catchall(z.unknown())
const readAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
const writeAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }

function result(value, isError = false) {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }], structuredContent: value, ...(isError ? { isError: true } : {}) }
}

function handle(operation) {
  return async (input) => {
    try {
      return result(await operation(input))
    } catch (error) {
      return result({ ok: false, error: { code: error.code ?? 'INTERNAL_ERROR', message: error.message ?? String(error), ...(error.details === undefined ? {} : { details: error.details }) } }, true)
    }
  }
}

const client = createClient(await resolveBaseUrl())
const server = new McpServer(
  { name: 'tasks-recorder', version: '0.3.0' },
  { instructions: 'Use this local task control plane for concrete Agent work. Call agent_tasks_context first and never edit SQLite directly.' },
)

server.registerTool('agent_tasks_context', { description: 'Find unfinished task candidates for this session and workfolder.', inputSchema: { session_id: z.string().min(1), workfolder: z.string().min(1), agent: z.string().min(1).optional() }, outputSchema, annotations: readAnnotations }, handle(client.context))
server.registerTool('agent_tasks_list', { description: 'List persisted tasks using optional filters.', inputSchema: { project: z.string().min(1).optional(), status: taskStatus.optional(), workfolder: z.string().min(1).optional(), branch: z.string().min(1).optional() }, outputSchema, annotations: readAnnotations }, handle(client.list))
server.registerTool('agent_tasks_show', { description: 'Show one task and its linked contexts.', inputSchema: { id: taskId }, outputSchema, annotations: readAnnotations }, handle(client.show))
server.registerTool('agent_tasks_upsert', { description: 'Create or update a concrete Agent work task.', inputSchema: { id: taskId, title: z.string().min(1), status: taskStatus, session_id: z.string().min(1), workfolder: z.string().min(1), agent: z.string().min(1).optional(), project: z.string().min(1).optional(), parent_id: taskId.nullable().optional(), start_date: date.optional(), due_date: date.nullable().optional(), next_action: z.string().min(1).nullable().optional() }, outputSchema, annotations: writeAnnotations }, handle(client.upsert))
server.registerTool('agent_tasks_complete', { description: 'Mark a task done and record final session activity.', inputSchema: { id: taskId, session_id: z.string().min(1), workfolder: z.string().min(1), agent: z.string().min(1).optional() }, outputSchema, annotations: writeAnnotations }, handle(client.complete))
server.registerTool('agent_tasks_render', { description: 'Rebuild legacy Markdown projections.', inputSchema: {}, outputSchema, annotations: writeAnnotations }, handle(client.render))
server.registerTool('agent_tasks_check', { description: 'Check service and storage integrity.', inputSchema: {}, outputSchema, annotations: readAnnotations }, handle(client.check))

await server.connect(new StdioServerTransport())
