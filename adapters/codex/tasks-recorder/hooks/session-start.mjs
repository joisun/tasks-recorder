#!/usr/bin/env node

import { readHookInput } from './src/hook-context.mjs'
import { sendLifecycle } from './src/taskd-client.mjs'

try {
  const input = await readHookInput()
  if (input.session_id) {
    await sendLifecycle('session-start', {
      root_session_id: input.session_id,
      session_id: input.session_id,
    })
  }
} catch {
  // Lifecycle recording must never prevent a Codex session from starting.
}
