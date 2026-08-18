import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { TaskRecorderError } from './errors.mjs'

export const SERVER_INSTRUCTIONS = `Operate this local Agent Task Control Plane. A Task is a delivery outcome, not a session, turn, or subagent execution. Record every concrete work objective regardless of duration; exclude ordinary chat and non-work questions. Start with agent_tasks_context, preserve Task identity across sessions and worktrees, and use agent_tasks_sync_tree for one root with at most one direct child level. Distinct goals handled in the same conversation remain distinct Tasks. Bind the current execution only to the Task actually being worked; never infer Task identity from timing or prompt similarity. Use only this server to change state; never edit tasks.sqlite directly. SQLite is canonical and owned by taskd; agent_tasks_render is compatibility-only.`

const taskId = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
const taskStatus = z.enum(['planned', 'active', 'waiting', 'blocked', 'done', 'canceled'])
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const revision = z.number().int().positive()
const taskPatch = z.object({
  parent_id: taskId.nullable().optional(),
  project: z.string().min(1).optional(),
  title: z.string().min(1).optional(),
  description: z.string().min(1).nullable().optional(),
  status: taskStatus.optional(),
  start_date: date.optional(),
  due_date: date.nullable().optional(),
  next_action: z.string().min(1).nullable().optional(),
  agent_key: z.string().min(1).nullable().optional(),
  sort_order: z.number().int().nonnegative().optional(),
})
const treeRoot = z.object({
  id: taskId.optional(),
  project: z.string().min(1).optional(),
  title: z.string().min(1),
  description: z.string().min(1).nullable().optional(),
  status: taskStatus,
  start_date: date.optional(),
  due_date: date.nullable().optional(),
  next_action: z.string().min(1).nullable().optional(),
})
const treeChild = z.object({
  id: taskId.optional(),
  title: z.string().min(1),
  description: z.string().min(1).nullable().optional(),
  status: taskStatus,
  sort_order: z.number().int().nonnegative(),
  agent_key: z.string().min(1).nullable().optional(),
  due_date: date.nullable().optional(),
  next_action: z.string().min(1).nullable().optional(),
})
const outputSchema = z.object({}).catchall(z.unknown())

const readAnnotations = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
})

const writeAnnotations = Object.freeze({
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
})

function toolResult(structuredContent, isError = false) {
  return {
    content: [{ type: 'text', text: JSON.stringify(structuredContent, null, 2) }],
    structuredContent,
    ...(isError ? { isError: true } : {}),
  }
}

function errorResult(error) {
  const known = error instanceof TaskRecorderError
  const details = known ? error.details : undefined
  const structuredContent = {
    ok: false,
    error: {
      code: known ? error.code : 'INTERNAL_ERROR',
      message: error instanceof Error ? error.message : String(error),
      ...(details === undefined ? {} : { details }),
    },
  }
  return toolResult(structuredContent, true)
}

function handler(operation) {
  return async (input) => {
    try {
      return toolResult(await operation(input))
    } catch (error) {
      return errorResult(error)
    }
  }
}

export function createTasksRecorderServer({ service }) {
  const server = new McpServer(
    { name: 'tasks-recorder', version: '0.5.0' },
    { instructions: SERVER_INSTRUCTIONS },
  )

  server.registerTool('agent_tasks_context', {
    description: 'Find unfinished task candidates for the current Codex session and workfolder, enriched with Git/worktree context.',
    inputSchema: {
      session_id: z.string().min(1),
      workfolder: z.string().min(1),
      agent: z.string().min(1).optional(),
    },
    outputSchema,
    annotations: readAnnotations,
  }, handler((input) => service.context(input)))

  server.registerTool('agent_tasks_list', {
    description: 'List persisted Agent tasks using optional project, status, workfolder, and branch filters.',
    inputSchema: {
      project: z.string().min(1).optional(),
      status: taskStatus.optional(),
      workfolder: z.string().min(1).optional(),
      branch: z.string().min(1).optional(),
    },
    outputSchema,
    annotations: readAnnotations,
  }, handler(async (filters) => ({ tasks: await service.list(filters) })))

  server.registerTool('agent_tasks_show', {
    description: 'Show one task with its parent, children, and every linked Codex session/workfolder context.',
    inputSchema: { id: taskId },
    outputSchema,
    annotations: readAnnotations,
  }, handler(({ id }) => service.show(id)))

  server.registerTool('agent_tasks_upsert', {
    description: 'Create or update a concrete Agent work task and link the current session context.',
    inputSchema: {
      id: taskId,
      title: z.string().min(1),
      status: taskStatus,
      session_id: z.string().min(1),
      workfolder: z.string().min(1),
      agent: z.string().min(1).optional(),
      project: z.string().min(1).optional(),
      parent_id: taskId.nullable().optional(),
      start_date: date.optional(),
      due_date: date.nullable().optional(),
      next_action: z.string().min(1).nullable().optional(),
      description: z.string().min(1).nullable().optional(),
      agent_key: z.string().min(1).nullable().optional(),
      sort_order: z.number().int().nonnegative().optional(),
    },
    outputSchema,
    annotations: writeAnnotations,
  }, handler((input) => service.upsert(input)))

  server.registerTool('agent_tasks_complete', {
    description: 'Mark a persisted Agent work task done and record its final session activity.',
    inputSchema: {
      id: taskId,
      session_id: z.string().min(1),
      workfolder: z.string().min(1),
      agent: z.string().min(1).optional(),
    },
    outputSchema,
    annotations: writeAnnotations,
  }, handler((input) => service.complete(input)))

  server.registerTool('agent_tasks_sync_tree', {
    description: 'Atomically synchronize one root task and its direct children, then bind the current turn focus.',
    inputSchema: {
      session_id: z.string().min(1),
      turn_id: z.string().min(1),
      workfolder: z.string().min(1),
      expected_revision: revision.nullable(),
      root: treeRoot,
      children: z.array(treeChild),
      focus_task_id: taskId.nullable().optional(),
    },
    outputSchema,
    annotations: writeAnnotations,
  }, handler((input) => service.syncTree({ ...input, actor: 'agent' })))

  server.registerTool('agent_tasks_update', {
    description: 'Update Task metadata using optimistic revision concurrency.',
    inputSchema: { id: taskId, expected_revision: revision, patch: taskPatch },
    outputSchema,
    annotations: writeAnnotations,
  }, handler((input) => service.updateTask({ ...input, actor: 'agent' })))

  server.registerTool('agent_tasks_archive', {
    description: 'Archive a done or canceled Task without deleting its history.',
    inputSchema: { id: taskId, expected_revision: revision },
    outputSchema,
    annotations: writeAnnotations,
  }, handler((input) => service.archiveTask({ ...input, actor: 'agent' })))

  server.registerTool('agent_tasks_restore', {
    description: 'Restore an archived or soft-deleted Task.',
    inputSchema: { id: taskId, expected_revision: revision },
    outputSchema,
    annotations: writeAnnotations,
  }, handler((input) => service.restoreTask({ ...input, actor: 'agent' })))

  server.registerTool('agent_task_executions_list', {
    description: 'List main and subagent execution intervals, including unassigned inbox items.',
    inputSchema: {
      task_id: taskId.optional(),
      root_session_id: z.string().min(1).optional(),
      session_id: z.string().min(1).optional(),
      status: z.enum(['active', 'completed', 'interrupted', 'unknown']).optional(),
      unassigned: z.boolean().optional(),
    },
    outputSchema,
    annotations: readAnnotations,
  }, handler(async (filters) => ({ executions: await service.listExecutions(filters) })))

  server.registerTool('agent_task_execution_assign', {
    description: 'Assign or unassign an execution using compare-and-set task identity.',
    inputSchema: {
      id: z.string().min(1),
      task_id: taskId.nullable(),
      expected_task_id: taskId.nullable(),
    },
    outputSchema,
    annotations: writeAnnotations,
  }, handler((input) => service.assignExecution({ ...input, actor: 'agent' })))

  server.registerTool('agent_task_execution_classify', {
    description: 'Classify an execution as unknown, work, or non-work using expected state.',
    inputSchema: {
      id: z.string().min(1),
      classification: z.enum(['unknown', 'work', 'non_work']),
      expected_classification: z.enum(['unknown', 'work', 'non_work']),
      expected_task_id: taskId.nullable(),
    },
    outputSchema,
    annotations: writeAnnotations,
  }, handler((input) => service.classifyExecution({ ...input, actor: 'agent' })))

  server.registerTool('agent_tasks_render', {
    description: 'Compatibility tool: rebuild legacy Tasks.md and History.md projections from canonical SQLite.',
    inputSchema: {},
    outputSchema,
    annotations: writeAnnotations,
  }, handler(() => service.render()))

  server.registerTool('agent_tasks_check', {
    description: 'Check SQLite integrity, embedded Dashboard availability, and legacy projection freshness without changing state.',
    inputSchema: {},
    outputSchema,
    annotations: readAnnotations,
  }, handler(() => service.check()))

  return server
}
