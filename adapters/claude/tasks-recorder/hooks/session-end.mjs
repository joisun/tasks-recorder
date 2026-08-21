#!/usr/bin/env node

import { readHookInput, sessionEndedEvent } from './src/hook-context.mjs'
import { sendJournalEvent } from './src/taskd-client.mjs'
import { clearTurnState } from './src/turn-state.mjs'

try {
  const input = await readHookInput()
  if (input.session_id) {
    await sendJournalEvent(await sessionEndedEvent(input))
    await clearTurnState(input.session_id)
  }
} catch {
  // Session observation and correlation cleanup must fail open.
}
