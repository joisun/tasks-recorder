#!/usr/bin/env node

import { readHookInput, subagentStartedEvent } from './src/hook-context.mjs'
import { sendJournalEvent } from './src/taskd-client.mjs'

try {
  const input = await readHookInput()
  await sendJournalEvent(await subagentStartedEvent(input))
} catch {
  // Subagent recording must fail open.
}
