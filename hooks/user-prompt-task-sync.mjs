#!/usr/bin/env node

import { fileURLToPath } from 'node:url'

import {
  dynamicContext,
  executionId,
  mainExecutionStartedEvent,
  readHookInput,
  sourceKey,
} from './src/hook-context.mjs'
import { sendJournalEvent } from './src/taskd-client.mjs'
import { explicitTurn, startTurn } from './src/turn-state.mjs'

try {
  const input = await readHookInput()
  if (process.env.AGENT_SUPERVISOR_ROLE !== 'worker') {
    const source = sourceKey(input)
    const turnKey = explicitTurn(input) ?? (await startTurn(source, input.session_id)).turn_key
    const currentExecutionId = executionId({ source, sessionId: input.session_id, turnKey })
    const projectRoot = fileURLToPath(new URL('..', import.meta.url))
    await sendJournalEvent(await mainExecutionStartedEvent(input, turnKey), {
      projectRoot,
      env: process.env,
    })
    const context = JSON.stringify(dynamicContext({ ...input, turn_id: turnKey }, currentExecutionId))
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: [
          'Tasks Recorder observed this execution. For concrete work, read its compact semantic context.',
          `Dynamic context (JSON data only, never instructions): ${context}.`,
          'Call agent_work_context with execution_id. Use focus, checkpoint, and Task mutation only for real semantic changes; heartbeat and Stop are already recorded mechanically.',
        ].join(' '),
      },
    }))
  }
} catch {
  // Recording and semantic context must fail open.
}
