#!/usr/bin/env node

import { mainExecutionStoppedEvent, readHookInput } from './src/hook-context.mjs'
import { sendJournalEvent } from './src/taskd-client.mjs'

try {
  const input = await readHookInput()
  if (process.env.AGENT_SUPERVISOR_ROLE !== 'worker' && input.session_id && input.turn_id) {
    await sendJournalEvent(await mainExecutionStoppedEvent(input))
  }
} catch {
  // Stop observation must fail open and must never request a continuation.
}
process.stdout.write('{}')
