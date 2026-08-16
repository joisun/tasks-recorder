#!/usr/bin/env node

import { readHookInput, subagentStartLifecycleInput } from './src/hook-context.mjs'
import { sendLifecycle } from './src/taskd-client.mjs'

try {
  const input = await readHookInput()
  await sendLifecycle('subagent-start', subagentStartLifecycleInput(input))
} catch {
  // Subagent recording must fail open.
}
