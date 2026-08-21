#!/usr/bin/env node

import { readHookInput, sessionStartedEvent } from './src/hook-context.mjs'
import { sendJournalEvent } from './src/taskd-client.mjs'
import { initializeTurnState } from './src/turn-state.mjs'

try {
  const input = await readHookInput()
  if (input.session_id) {
    await initializeTurnState(input.session_id)
    await sendJournalEvent(await sessionStartedEvent(input))
  }
} catch {
  // Session observation and correlation state must fail open.
}
