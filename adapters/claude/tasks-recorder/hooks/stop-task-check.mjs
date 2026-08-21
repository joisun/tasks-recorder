#!/usr/bin/env node

import { mainExecutionStoppedEvent, readHookInput } from './src/hook-context.mjs'
import { sendJournalEvent } from './src/taskd-client.mjs'
import { currentTurn } from './src/turn-state.mjs'

try {
  const input = await readHookInput()
  if (process.env.AGENT_SUPERVISOR_ROLE !== 'worker' && input.session_id) {
    const turn = await currentTurn(input.session_id)
    if (turn?.turn_key) {
      await sendJournalEvent(await mainExecutionStoppedEvent(input, turn.turn_key))
    }
  }
} catch {
  // Stop observation must fail open and must never request a continuation.
}
process.stdout.write('{}')
