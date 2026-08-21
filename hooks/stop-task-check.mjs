#!/usr/bin/env node

import { fileURLToPath } from 'node:url'

import { mainExecutionStoppedEvent, readHookInput, sourceKey } from './src/hook-context.mjs'
import { sendJournalEvent } from './src/taskd-client.mjs'
import { currentTurn, explicitTurn } from './src/turn-state.mjs'

try {
  const input = await readHookInput()
  if (process.env.AGENT_SUPERVISOR_ROLE !== 'worker' && input.session_id) {
    const source = sourceKey(input)
    const turnKey = explicitTurn(input) ?? (await currentTurn(source, input.session_id))?.turn_key
    if (turnKey) {
      const projectRoot = fileURLToPath(new URL('..', import.meta.url))
      await sendJournalEvent(await mainExecutionStoppedEvent(input, turnKey), {
        projectRoot,
        env: process.env,
      })
    }
  }
} catch {
  // Stop observation must fail open and must never request a continuation.
}
process.stdout.write('{}')
