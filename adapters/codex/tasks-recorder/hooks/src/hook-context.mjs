const MAX_STDIN_BYTES = 1024 * 1024

export function dynamicContext(input) {
  return {
    session_id: input?.session_id ?? null,
    turn_id: input?.turn_id ?? null,
    workfolder: input?.cwd ?? null,
    agent: 'Codex',
  }
}

function requiredString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} must be a non-empty string`)
  }
  return value.trim()
}

function optionalString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

export function turnLifecycleInput(input) {
  const sessionId = requiredString(input?.session_id, 'session_id')
  const turnId = requiredString(input?.turn_id, 'turn_id')
  return {
    external_key: `codex:turn:${sessionId}:${turnId}:0`,
    root_session_id: sessionId,
    session_id: sessionId,
    turn_id: turnId,
    agent_type: 'Codex',
    ...(optionalString(input.transcript_path) ? { transcript_path: input.transcript_path.trim() } : {}),
    workfolder: requiredString(input?.cwd, 'cwd'),
  }
}

export function toolLifecycleInput(input) {
  const sessionId = requiredString(input?.session_id, 'session_id')
  const turnId = requiredString(input?.turn_id, 'turn_id')
  const toolUseId = requiredString(input?.tool_use_id, 'tool_use_id')
  const toolName = requiredString(input?.tool_name, 'tool_name')
  return {
    external_key: `codex:tool:${sessionId}:${turnId}:${toolUseId}`,
    root_session_id: sessionId,
    session_id: sessionId,
    turn_id: turnId,
    tool_name: toolName,
    ...(toolName === 'update_plan' ? { plan: input.tool_input } : {}),
  }
}

export function subagentLifecycleKey(input) {
  return `codex:subagent:${requiredString(input?.session_id, 'session_id')}:${requiredString(input?.agent_id, 'agent_id')}`
}

export function subagentStartLifecycleInput(input) {
  const rootSessionId = requiredString(input?.session_id, 'session_id')
  const agentId = requiredString(input?.agent_id, 'agent_id')
  return {
    external_key: subagentLifecycleKey(input),
    root_session_id: rootSessionId,
    session_id: agentId,
    parent_session_id: rootSessionId,
    turn_id: requiredString(input?.turn_id, 'turn_id'),
    agent_id: agentId,
    agent_type: requiredString(input?.agent_type, 'agent_type'),
    ...(optionalString(input.agent_path) ? { agent_path: input.agent_path.trim() } : {}),
    workfolder: requiredString(input?.cwd, 'cwd'),
  }
}

export async function readHookInput(stream = process.stdin) {
  const chunks = []
  let bytes = 0
  for await (const chunk of stream) {
    bytes += chunk.length
    if (bytes > MAX_STDIN_BYTES) throw new Error('hook input exceeds 1 MiB')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
}
