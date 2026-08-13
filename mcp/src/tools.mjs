import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { TaskRecorderError } from './errors.mjs'

export const SERVER_INSTRUCTIONS = `Operate this local Agent Task Control Plane. Record every concrete Agent work task regardless of duration, including short tasks completed in one turn; exclude only ordinary chat, non-work questions, and sessions without a work objective. Start with agent_tasks_context, preserve task identity across sessions and worktrees, and prefer updating a semantically matching task. Use only this server to change task state; never edit tasks.sqlite directly. SQLite is canonical and owned by the local taskd service; agent_tasks_render exists only for legacy Markdown projection compatibility.`

const taskId = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
const taskStatus = z.enum(['planned', 'active', 'waiting', 'blocked', 'done'])
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
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
    { name: 'tasks-recorder', version: '0.3.0' },
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
