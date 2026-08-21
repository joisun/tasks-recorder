#!/usr/bin/env node

import { readHookInput, toolHeartbeatEvent } from './src/hook-context.mjs'
import { sendJournalEvent } from './src/taskd-client.mjs'

try {
  const input = await readHookInput()
  if (process.env.AGENT_SUPERVISOR_ROLE !== 'worker' && input.session_id) {
    await sendJournalEvent(await toolHeartbeatEvent(input))
  }
} catch {
  // Activity tracking must never interfere with the completed tool call.
}
