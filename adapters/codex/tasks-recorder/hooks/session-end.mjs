#!/usr/bin/env node

import { readHookInput } from './src/hook-context.mjs'
import { sendLifecycle } from './src/taskd-client.mjs'

try {
  const input = await readHookInput()
  if (input.session_id) {
    await sendLifecycle('session-end', {
      root_session_id: input.session_id,
      interrupted: false,
    })
  }
} catch {
  // Session cleanup must fail open.
}
