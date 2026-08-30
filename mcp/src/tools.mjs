import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { TaskRecorderError } from './errors.mjs'

export const SERVER_INSTRUCTIONS = `Operate this local Project Journalist control plane. Observation, Source Session, Execution, and Work Segment are facts; Project, Main Task, and Subtask are user-owned semantics. Start concrete work with agent_work_context(execution_id). Use agent_work_focus and agent_work_checkpoint only for real semantic changes; ordinary heartbeat and Stop are handled by host adapters and must never trigger list + full-tree synchronization. Before spawning a child execution for a Task, register the exact host agent key with agent_work_intent. Preserve Task identity and use entity revisions. Use agent_tasks_mutate for one Task and agent_tasks_sync_structure only for a deliberate Main Task/direct-child structure change. Never infer Task identity from timing, branch, prompt similarity, or subagent identity. Never edit tasks.sqlite directly. Legacy agent_tasks_* tools remain compatibility-only where their descriptions say so.`

const taskId = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
const taskStatus = z.enum(['planned', 'active', 'waiting', 'blocked', 'done', 'canceled'])
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const revision = z.number().int().positive()
const instant = z.string().min(1)
const v3Lifecycle = z.enum(['planned', 'in_progress', 'waiting', 'blocked', 'done', 'canceled'])
const v3TaskPatch = z.object({
  project_id: taskId.optional(),
  parent_id: taskId.nullable().optional(),
  title: z.string().min(1).optional(),
  description: z.string().min(1).nullable().optional(),
  lifecycle: v3Lifecycle.optional(),
  planned_start_at: instant.nullable().optional(),
  planned_due_at: instant.nullable().optional(),
  next_action: z.string().min(1).nullable().optional(),
  sort_order: z.number().int().nonnegative().optional(),
})
const v3TaskNode = z.object({
  id: taskId,
  project_id: taskId.optional(),
  parent_id: taskId.nullable().optional(),
  title: z.string().min(1).optional(),
  description: z.string().min(1).nullable().optional(),
  lifecycle: v3Lifecycle.optional(),
  planned_start_at: instant.nullable().optional(),
  planned_due_at: instant.nullable().optional(),
  next_action: z.string().min(1).nullable().optional(),
  sort_order: z.number().int().nonnegative().optional(),
  expected_revision: revision.optional(),
  patch: v3TaskPatch.optional(),
})
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
    { name: 'tasks-recorder', version: '0.7.2' },
    { instructions: SERVER_INSTRUCTIONS },
  )

  server.registerTool('agent_work_context', {
    description: 'Read compact Project, current Segment/focus, and at most three same-Project Main Task candidates for one execution. This query never creates or binds Tasks.',
    inputSchema: { execution_id: z.string().min(1) },
    outputSchema,
    annotations: readAnnotations,
  }, handler((input) => service.workContext(input)))

  server.registerTool('agent_work_focus', {
    description: 'Explicitly focus or unfocus one execution. A changed focus closes the current Segment and starts a new Segment; do not call for heartbeat.',
    inputSchema: {
      execution_id: z.string().min(1),
      task_id: taskId.nullable(),
      provenance: z.enum(['agent_explicit', 'current_focus']),
      rationale_code: z.string().min(1),
      observed_at: instant.optional(),
    },
    outputSchema,
    annotations: writeAnnotations,
  }, handler((input) => service.workFocus(input)))

  server.registerTool('agent_work_intent', {
    description: 'Before spawning a child execution, bind its exact host agent key to one Task. The intent is single-use and expires; never infer child ownership from timing or agent type.',
    inputSchema: {
      execution_id: z.string().min(1),
      external_agent_key: z.string().min(1),
      task_id: taskId,
      created_at: instant.optional(),
      expires_at: instant.optional(),
    },
    outputSchema,
    annotations: writeAnnotations,
  }, handler((input) => service.registerIntent(input)))

  server.registerTool('agent_work_checkpoint', {
    description: 'Write one compact checkpoint to the current Segment and its focused Task next action using Task revision concurrency.',
    inputSchema: {
      execution_id: z.string().min(1),
      task_id: taskId,
      expected_revision: revision,
      summary: z.string().min(1).max(4_000),
      next_action: z.string().min(1),
      observed_at: instant.optional(),
    },
    outputSchema,
    annotations: writeAnnotations,
  }, handler((input) => service.workCheckpoint(input)))

  server.registerTool('agent_work_attribution_correct', {
    description: 'Correct one Work Segment attribution explicitly; the prior attribution remains auditable.',
    inputSchema: {
      segment_id: z.string().min(1),
      task_id: taskId,
      provenance: z.enum(['agent_explicit', 'user']),
      rationale_code: z.string().min(1),
      observed_at: instant.optional(),
    },
    outputSchema,
    annotations: writeAnnotations,
  }, handler((input) => service.correctAttribution(input)))

  server.registerTool('agent_tasks_mutate', {
    description: 'Create, update/move, or change lifecycle of one canonical Project Task using entity revision concurrency.',
    inputSchema: {
      action: z.enum(['create', 'update', 'status']),
      task: v3TaskNode,
    },
    outputSchema,
    annotations: writeAnnotations,
  }, handler((input) => service.mutateTask(input)))

  server.registerTool('agent_tasks_sync_structure', {
    description: 'Atomically reconcile one Main Task and its direct children after checking the exact current child id/revision set. Omitted verified children become canceled.',
    inputSchema: {
      project_id: taskId,
      main_task: v3TaskNode,
      expected_children: z.array(z.object({ id: taskId, revision })),
      children: z.array(v3TaskNode),
    },
    outputSchema,
    annotations: writeAnnotations,
  }, handler((input) => service.syncStructure(input)))

  server.registerTool('agent_tasks_context', {
    description: 'Deprecated lossy compatibility query. Use agent_work_context(execution_id); this projection cannot represent multiple Work Segments.',
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
    description: 'Deprecated compatibility mutation. Use agent_tasks_mutate plus agent_work_focus.',
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
    description: 'Deprecated compatibility mutation. Use agent_tasks_mutate with explicit lifecycle done.',
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
    description: 'Deprecated lossy compatibility mutation. Use agent_tasks_sync_structure only for structure changes and agent_work_focus separately.',
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
