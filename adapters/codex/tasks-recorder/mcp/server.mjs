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
    syncTree: (input) => request('/api/v1/tasks/sync-tree', { method: 'POST', body: input }),
    updateTask: ({ id, ...body }) => request(`/api/v1/tasks/${encodeURIComponent(id)}`, { method: 'PATCH', body }),
    archiveTask: ({ id, ...body }) => request(`/api/v1/tasks/${encodeURIComponent(id)}/archive`, { method: 'POST', body }),
    restoreTask: ({ id, ...body }) => request(`/api/v1/tasks/${encodeURIComponent(id)}/restore`, { method: 'POST', body }),
    listExecutions: (filters) => {
      const query = new URLSearchParams(Object.entries(filters).filter(([, value]) => value != null))
      return request(`/api/v1/executions${query.size ? `?${query}` : ''}`)
    },
    assignExecution: ({ id, ...body }) => request(`/api/v1/executions/${encodeURIComponent(id)}/task`, { method: 'PATCH', body }),
    classifyExecution: ({ id, ...body }) => request(`/api/v1/executions/${encodeURIComponent(id)}/classification`, { method: 'PATCH', body }),
    workContext: (input) => request('/api/v1/work/context', { method: 'POST', body: input }),
    workFocus: (input) => request('/api/v1/work/focus', { method: 'POST', body: input }),
    registerIntent: (input) => request('/api/v1/work/intents', { method: 'POST', body: input }),
    workCheckpoint: (input) => request('/api/v1/work/checkpoint', { method: 'POST', body: input }),
    correctAttribution: ({ segment_id: segmentId, ...body }) => request(`/api/v1/segments/${encodeURIComponent(segmentId)}/attribution`, { method: 'PATCH', body }),
    mutateTask: (input) => request('/api/v1/tasks/mutate', { method: 'POST', body: input }),
    syncStructure: (input) => request('/api/v1/tasks/sync-structure', { method: 'POST', body: input }),
    render: () => request('/api/v1/render', { method: 'POST' }),
    check: () => request('/api/v1/check'),
  }
}

const taskId = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
const taskStatus = z.enum(['planned', 'active', 'waiting', 'blocked', 'done', 'canceled'])
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const revision = z.number().int().positive()
const instant = z.string().min(1)
const v3Lifecycle = z.enum(['planned', 'in_progress', 'waiting', 'blocked', 'done', 'canceled'])
const v3TaskPatch = z.object({ project_id: taskId.optional(), parent_id: taskId.nullable().optional(), title: z.string().min(1).optional(), description: z.string().min(1).nullable().optional(), lifecycle: v3Lifecycle.optional(), planned_start_at: instant.nullable().optional(), planned_due_at: instant.nullable().optional(), next_action: z.string().min(1).nullable().optional(), sort_order: z.number().int().nonnegative().optional() })
const v3TaskNode = z.object({ id: taskId, project_id: taskId.optional(), parent_id: taskId.nullable().optional(), title: z.string().min(1).optional(), description: z.string().min(1).nullable().optional(), lifecycle: v3Lifecycle.optional(), planned_start_at: instant.nullable().optional(), planned_due_at: instant.nullable().optional(), next_action: z.string().min(1).nullable().optional(), sort_order: z.number().int().nonnegative().optional(), expected_revision: revision.optional(), patch: v3TaskPatch.optional() })
const taskPatch = z.object({ parent_id: taskId.nullable().optional(), project: z.string().min(1).optional(), title: z.string().min(1).optional(), description: z.string().min(1).nullable().optional(), status: taskStatus.optional(), start_date: date.optional(), due_date: date.nullable().optional(), next_action: z.string().min(1).nullable().optional(), agent_key: z.string().min(1).nullable().optional(), sort_order: z.number().int().nonnegative().optional() })
const treeRoot = z.object({ id: taskId.optional(), project: z.string().min(1).optional(), title: z.string().min(1), description: z.string().min(1).nullable().optional(), status: taskStatus, start_date: date.optional(), due_date: date.nullable().optional(), next_action: z.string().min(1).nullable().optional() })
const treeChild = z.object({ id: taskId.optional(), title: z.string().min(1), description: z.string().min(1).nullable().optional(), status: taskStatus, sort_order: z.number().int().nonnegative(), agent_key: z.string().min(1).nullable().optional(), due_date: date.nullable().optional(), next_action: z.string().min(1).nullable().optional() })
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
  { name: 'tasks-recorder', version: '0.7.1' },
  { instructions: 'Use this local Project Journalist for concrete work. Start with agent_work_context(execution_id); use semantic commands only for real focus, checkpoint, or Task changes. Before spawning a child for a Task, call agent_work_intent with its exact host agent key. Heartbeat and Stop are mechanical events and never require full-tree synchronization. Legacy agent_tasks_* tools are deprecated compatibility projections. Never edit SQLite directly.' },
)

server.registerTool('agent_work_context', { description: 'Read compact same-Project semantic context for one execution without creating or binding Tasks.', inputSchema: { execution_id: z.string().min(1) }, outputSchema, annotations: readAnnotations }, handle(client.workContext))
server.registerTool('agent_work_focus', { description: 'Explicitly focus or unfocus one execution, creating a Segment boundary only when focus changes.', inputSchema: { execution_id: z.string().min(1), task_id: taskId.nullable(), provenance: z.enum(['agent_explicit', 'current_focus']), rationale_code: z.string().min(1), observed_at: instant.optional() }, outputSchema, annotations: writeAnnotations }, handle(client.workFocus))
server.registerTool('agent_work_intent', { description: 'Before spawning a child execution, bind its exact host agent key to one Task with a single-use expiring intent.', inputSchema: { execution_id: z.string().min(1), external_agent_key: z.string().min(1), task_id: taskId, created_at: instant.optional(), expires_at: instant.optional() }, outputSchema, annotations: writeAnnotations }, handle(client.registerIntent))
server.registerTool('agent_work_checkpoint', { description: 'Write one meaningful Segment summary and Task next action with revision concurrency.', inputSchema: { execution_id: z.string().min(1), task_id: taskId, expected_revision: revision, summary: z.string().min(1).max(4000), next_action: z.string().min(1), observed_at: instant.optional() }, outputSchema, annotations: writeAnnotations }, handle(client.workCheckpoint))
server.registerTool('agent_work_attribution_correct', { description: 'Explicitly correct one Segment attribution while preserving audit history.', inputSchema: { segment_id: z.string().min(1), task_id: taskId, provenance: z.enum(['agent_explicit', 'user']), rationale_code: z.string().min(1), observed_at: instant.optional() }, outputSchema, annotations: writeAnnotations }, handle(client.correctAttribution))
server.registerTool('agent_tasks_mutate', { description: 'Create, update/move, or change lifecycle of one canonical Project Task.', inputSchema: { action: z.enum(['create', 'update', 'status']), task: v3TaskNode }, outputSchema, annotations: writeAnnotations }, handle(client.mutateTask))
server.registerTool('agent_tasks_sync_structure', { description: 'Atomically reconcile one Main Task and its exact revisioned direct-child set.', inputSchema: { project_id: taskId, main_task: v3TaskNode, expected_children: z.array(z.object({ id: taskId, revision })), children: z.array(v3TaskNode) }, outputSchema, annotations: writeAnnotations }, handle(client.syncStructure))

server.registerTool('agent_tasks_context', { description: 'Find unfinished task candidates for this session and workfolder.', inputSchema: { session_id: z.string().min(1), workfolder: z.string().min(1), agent: z.string().min(1).optional() }, outputSchema, annotations: readAnnotations }, handle(client.context))
server.registerTool('agent_tasks_list', { description: 'List persisted tasks using optional filters.', inputSchema: { project: z.string().min(1).optional(), status: taskStatus.optional(), workfolder: z.string().min(1).optional(), branch: z.string().min(1).optional() }, outputSchema, annotations: readAnnotations }, handle(client.list))
server.registerTool('agent_tasks_show', { description: 'Show one task and its linked contexts.', inputSchema: { id: taskId }, outputSchema, annotations: readAnnotations }, handle(client.show))
server.registerTool('agent_tasks_upsert', { description: 'Create or update a concrete Agent work task.', inputSchema: { id: taskId, title: z.string().min(1), status: taskStatus, session_id: z.string().min(1), workfolder: z.string().min(1), agent: z.string().min(1).optional(), project: z.string().min(1).optional(), parent_id: taskId.nullable().optional(), start_date: date.optional(), due_date: date.nullable().optional(), next_action: z.string().min(1).nullable().optional() }, outputSchema, annotations: writeAnnotations }, handle(client.upsert))
server.registerTool('agent_tasks_complete', { description: 'Mark a task done and record final session activity.', inputSchema: { id: taskId, session_id: z.string().min(1), workfolder: z.string().min(1), agent: z.string().min(1).optional() }, outputSchema, annotations: writeAnnotations }, handle(client.complete))
server.registerTool('agent_tasks_sync_tree', { description: 'Atomically synchronize one root task and its direct children.', inputSchema: { session_id: z.string().min(1), turn_id: z.string().min(1), workfolder: z.string().min(1), expected_revision: revision.nullable(), root: treeRoot, children: z.array(treeChild), focus_task_id: taskId.nullable().optional() }, outputSchema, annotations: writeAnnotations }, handle((input) => client.syncTree({ ...input, actor: 'agent' })))
server.registerTool('agent_tasks_update', { description: 'Update Task metadata with revision concurrency.', inputSchema: { id: taskId, expected_revision: revision, patch: taskPatch }, outputSchema, annotations: writeAnnotations }, handle((input) => client.updateTask({ ...input, actor: 'agent' })))
server.registerTool('agent_tasks_archive', { description: 'Archive a done or canceled Task.', inputSchema: { id: taskId, expected_revision: revision }, outputSchema, annotations: writeAnnotations }, handle((input) => client.archiveTask({ ...input, actor: 'agent' })))
server.registerTool('agent_tasks_restore', { description: 'Restore an archived or soft-deleted Task.', inputSchema: { id: taskId, expected_revision: revision }, outputSchema, annotations: writeAnnotations }, handle((input) => client.restoreTask({ ...input, actor: 'agent' })))
server.registerTool('agent_task_executions_list', { description: 'List main and subagent execution intervals.', inputSchema: { task_id: taskId.optional(), root_session_id: z.string().min(1).optional(), session_id: z.string().min(1).optional(), status: z.enum(['active', 'completed', 'interrupted', 'unknown']).optional(), unassigned: z.boolean().optional() }, outputSchema, annotations: readAnnotations }, handle(client.listExecutions))
server.registerTool('agent_task_execution_assign', { description: 'Assign or unassign an execution using expected task state.', inputSchema: { id: z.string().min(1), task_id: taskId.nullable(), expected_task_id: taskId.nullable() }, outputSchema, annotations: writeAnnotations }, handle((input) => client.assignExecution({ ...input, actor: 'agent' })))
server.registerTool('agent_task_execution_classify', { description: 'Classify an execution using expected state.', inputSchema: { id: z.string().min(1), classification: z.enum(['unknown', 'work', 'non_work']), expected_classification: z.enum(['unknown', 'work', 'non_work']), expected_task_id: taskId.nullable() }, outputSchema, annotations: writeAnnotations }, handle((input) => client.classifyExecution({ ...input, actor: 'agent' })))
server.registerTool('agent_tasks_render', { description: 'Rebuild legacy Markdown projections.', inputSchema: {}, outputSchema, annotations: writeAnnotations }, handle(client.render))
server.registerTool('agent_tasks_check', { description: 'Check service and storage integrity.', inputSchema: {}, outputSchema, annotations: readAnnotations }, handle(client.check))

await server.connect(new StdioServerTransport())
