#!/usr/bin/env node

import { fileURLToPath } from 'node:url'

import { readHookInput, sessionEndedEvent, sourceKey } from './src/hook-context.mjs'
import { sendJournalEvent } from './src/taskd-client.mjs'
import { clearTurnState } from './src/turn-state.mjs'

try {
  const input = await readHookInput()
  if (input.session_id) {
    const source = sourceKey(input)
    const projectRoot = fileURLToPath(new URL('..', import.meta.url))
    await sendJournalEvent(await sessionEndedEvent(input), { projectRoot, env: process.env })
    await clearTurnState(source, input.session_id)
  }
} catch {
  // Session observation and correlation cleanup must fail open.
}

