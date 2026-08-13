#!/usr/bin/env node

import { fileURLToPath } from 'node:url'

import { detectAgent, readHookInput } from './src/hook-context.mjs'
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
    const projectRoot = fileURLToPath(new URL('..', import.meta.url))
    await sendHeartbeat({
      session_id: input.session_id,
      agent: detectAgent(input),
      minimum_interval_ms: 10_000,
    }, {
      projectRoot,
      env: process.env,
    })
  }
} catch {
  // Activity tracking must never interfere with the completed tool call.
}
