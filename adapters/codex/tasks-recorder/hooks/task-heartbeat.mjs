#!/usr/bin/env node

import { readHookInput } from './src/hook-context.mjs'
import { sendHeartbeat } from './src/taskd-client.mjs'

try {
  const input = await readHookInput()
  const toolName = String(input.tool_name ?? '')
  if (
    process.env.AGENT_SUPERVISOR_ROLE !== 'worker'
    && input.session_id
    && !toolName.includes('tasks-recorder')
    && !toolName.includes('agent_tasks_')
  ) {
    await sendHeartbeat({
      session_id: input.session_id,
      agent: 'Codex',
      minimum_interval_ms: 10_000,
    })
  }
} catch {
  // Activity tracking must never interfere with the completed tool call.
}
