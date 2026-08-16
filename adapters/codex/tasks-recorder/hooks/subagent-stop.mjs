#!/usr/bin/env node

import { readCodexTranscriptMetadata } from './src/codex-transcript.mjs'
import { readHookInput, subagentLifecycleKey } from './src/hook-context.mjs'
import { sendLifecycle } from './src/taskd-client.mjs'

try {
  const input = await readHookInput()
  const enrichment = input.agent_transcript_path
    ? await readCodexTranscriptMetadata(input.agent_transcript_path)
    : { metadata: null }
  const metadata = enrichment.metadata
  await sendLifecycle('subagent-stop', {
    external_key: subagentLifecycleKey(input),
    root_session_id: input.session_id,
    session_id: metadata?.session_id ?? input.agent_id,
    agent_id: input.agent_id,
    agent_type: metadata?.agent_type ?? input.agent_type,
    ...(metadata?.agent_path ? { agent_path: metadata.agent_path } : {}),
    ...(metadata?.transcript_path ? { transcript_path: metadata.transcript_path } : {}),
    ...(metadata?.workfolder ? { workfolder: metadata.workfolder } : {}),
    ...(metadata?.branch ? { branch: metadata.branch } : {}),
    interrupted: false,
  })
} catch {
  // Subagent recording must fail open.
}
process.stdout.write('{}')
