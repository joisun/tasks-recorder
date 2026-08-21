#!/usr/bin/env node

import { fileURLToPath } from 'node:url'

import { readHookInput, sourceKey, toolHeartbeatEvent } from './src/hook-context.mjs'
import { sendJournalEvent } from './src/taskd-client.mjs'
import { currentTurn, explicitTurn } from './src/turn-state.mjs'

try {
  const input = await readHookInput()
  const toolName = String(input.tool_name ?? '')
  if (
    process.env.AGENT_SUPERVISOR_ROLE !== 'worker'
    && input.session_id
    && !toolName.includes('tasks-recorder')
    && !toolName.includes('agent_tasks_')
  ) {
    const source = sourceKey(input)
    const turnKey = explicitTurn(input) ?? (await currentTurn(source, input.session_id))?.turn_key
    if (turnKey) {
      const projectRoot = fileURLToPath(new URL('..', import.meta.url))
      await sendJournalEvent(await toolHeartbeatEvent(input, turnKey), {
        projectRoot,
        env: process.env,
      })
    }
  }
} catch {
  // Activity tracking must never interfere with the completed tool call.
}
