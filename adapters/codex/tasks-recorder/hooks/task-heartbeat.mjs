#!/usr/bin/env node

import { readHookInput, toolLifecycleInput } from './src/hook-context.mjs'
import { sendLifecycle } from './src/taskd-client.mjs'

try {
  const input = await readHookInput()
  if (process.env.AGENT_SUPERVISOR_ROLE !== 'worker' && input.session_id) {
    await sendLifecycle('tool-use', toolLifecycleInput(input))
    if (input.tool_name === 'update_plan') {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PostToolUse',
          additionalContext: 'update_plan was observed by tasks-recorder; synchronize the same root/child identities with agent_tasks_sync_tree before stopping.',
        },
      }))
    }
  }
} catch {
  // Activity tracking must never interfere with the completed tool call.
}
