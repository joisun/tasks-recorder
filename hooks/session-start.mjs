#!/usr/bin/env node

import { fileURLToPath } from 'node:url'

import { readHookInput, sessionStartedEvent, sourceKey } from './src/hook-context.mjs'
import { sendJournalEvent } from './src/taskd-client.mjs'
import { initializeTurnState } from './src/turn-state.mjs'

try {
  const input = await readHookInput()
  if (input.session_id) {
    const source = sourceKey(input)
    await initializeTurnState(source, input.session_id)
    const projectRoot = fileURLToPath(new URL('..', import.meta.url))
    await sendJournalEvent(await sessionStartedEvent(input), { projectRoot, env: process.env })
  }
} catch {
  // Session observation and correlation state must fail open.
}

