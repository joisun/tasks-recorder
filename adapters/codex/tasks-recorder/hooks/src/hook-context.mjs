import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { resolve } from 'node:path'
import { promisify } from 'node:util'

const MAX_STDIN_BYTES = 1024 * 1024
const execFileAsync = promisify(execFile)

export function dynamicContext(input, executionIdValue = null) {
  return {
    session_id: input?.session_id ?? null,
    turn_id: input?.turn_id ?? null,
    execution_id: executionIdValue,
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

export function executionId({ sourceSessionKey, sourceTurnKey, sourceAgentKey = null }) {
  const identity = ['codex', sourceSessionKey, sourceTurnKey, sourceAgentKey ?? ''].join('\u0000')
  return `execution-${createHash('sha256').update(identity).digest('hex').slice(0, 24)}`
}

async function gitContext(workfolder) {
  try {
    const { stdout } = await execFileAsync('git', [
      '-C', workfolder, 'rev-parse',
      '--show-toplevel', '--git-common-dir', '--abbrev-ref', 'HEAD',
    ], { timeout: 400, maxBuffer: 64 * 1024 })
    const [gitRoot, commonDirectory, branch] = stdout.trim().split('\n')
    let gitRemote = null
    try {
      const remote = await execFileAsync('git', [
        '-C', workfolder, 'remote', 'get-url', 'origin',
      ], { timeout: 300, maxBuffer: 16 * 1024 })
      gitRemote = optionalString(remote.stdout)
    } catch {
      // A repository without origin still has exact local evidence.
    }
    return {
      workfolder,
      git_root: optionalString(gitRoot) ?? null,
      git_common_dir: optionalString(commonDirectory)
        ? resolve(workfolder, commonDirectory.trim())
        : null,
      git_remote: gitRemote,
      worktree: optionalString(gitRoot) ?? workfolder,
      branch: optionalString(branch) ?? null,
    }
  } catch {
    return {
      workfolder,
      git_root: null,
      git_common_dir: null,
      git_remote: null,
      worktree: workfolder,
      branch: null,
    }
  }
}

async function envelopeBase(input, {
  eventType,
  externalEventId,
  sourceSessionKey,
  sourceTurnKey = null,
  sourceAgentKey = null,
  payload,
}) {
  const workfolder = requiredString(input?.cwd, 'cwd')
  return {
    source: 'codex',
    event_type: eventType,
    external_event_id: externalEventId,
    observed_at: new Date().toISOString(),
    source_session_key: sourceSessionKey,
    root_session_key: requiredString(input?.session_id, 'session_id'),
    source_turn_key: sourceTurnKey,
    source_agent_key: sourceAgentKey,
    project_id: null,
    ...await gitContext(workfolder),
    payload,
  }
}

export function mainExecutionId(input) {
  return executionId({
    sourceSessionKey: requiredString(input?.session_id, 'session_id'),
    sourceTurnKey: requiredString(input?.turn_id, 'turn_id'),
  })
}

export async function sessionStartedEvent(input) {
  const sessionId = requiredString(input?.session_id, 'session_id')
  return envelopeBase(input, {
    eventType: 'session.started',
    externalEventId: `codex:session:${sessionId}:started`,
    sourceSessionKey: sessionId,
    payload: {},
  })
}

export async function mainExecutionStartedEvent(input) {
  const sessionId = requiredString(input?.session_id, 'session_id')
  const turnId = requiredString(input?.turn_id, 'turn_id')
  return envelopeBase(input, {
    eventType: 'execution.started',
    externalEventId: `codex:execution:${sessionId}:${turnId}:started`,
    sourceSessionKey: sessionId,
    sourceTurnKey: turnId,
    payload: { kind: 'main' },
  })
}

export async function toolHeartbeatEvent(input) {
  const sessionId = requiredString(input?.session_id, 'session_id')
  const turnId = requiredString(input?.turn_id, 'turn_id')
  const toolUseId = requiredString(input?.tool_use_id, 'tool_use_id')
  return envelopeBase(input, {
    eventType: 'execution.heartbeat',
    externalEventId: `codex:execution:${sessionId}:${turnId}:tool:${toolUseId}`,
    sourceSessionKey: sessionId,
    sourceTurnKey: turnId,
    payload: { activity: 'tool_use' },
  })
}

export async function subagentStartedEvent(input) {
  const rootSessionId = requiredString(input?.session_id, 'session_id')
  const turnId = requiredString(input?.turn_id, 'turn_id')
  const agentId = requiredString(input?.agent_id, 'agent_id')
  return envelopeBase(input, {
    eventType: 'execution.started',
    externalEventId: `codex:subagent:${rootSessionId}:${turnId}:${agentId}:started`,
    sourceSessionKey: agentId,
    sourceTurnKey: turnId,
    sourceAgentKey: agentId,
    payload: { kind: 'subagent', parent_execution_id: mainExecutionId(input) },
  })
}

export async function subagentStoppedEvent(input) {
  const rootSessionId = requiredString(input?.session_id, 'session_id')
  const turnId = requiredString(input?.turn_id, 'turn_id')
  const agentId = requiredString(input?.agent_id, 'agent_id')
  return envelopeBase(input, {
    eventType: 'execution.stop',
    externalEventId: `codex:subagent:${rootSessionId}:${turnId}:${agentId}:stopped`,
    sourceSessionKey: agentId,
    sourceTurnKey: turnId,
    sourceAgentKey: agentId,
    payload: { end_reason: input.interrupted ? 'interrupted' : 'completed' },
  })
}

export async function mainExecutionStoppedEvent(input) {
  const sessionId = requiredString(input?.session_id, 'session_id')
  const turnId = requiredString(input?.turn_id, 'turn_id')
  return envelopeBase(input, {
    eventType: 'execution.stop',
    externalEventId: `codex:execution:${sessionId}:${turnId}:stopped`,
    sourceSessionKey: sessionId,
    sourceTurnKey: turnId,
    payload: { end_reason: 'stopped' },
  })
}

export async function sessionEndedEvent(input) {
  const sessionId = requiredString(input?.session_id, 'session_id')
  return envelopeBase(input, {
    eventType: 'session.ended',
    externalEventId: `codex:session:${sessionId}:ended`,
    sourceSessionKey: sessionId,
    payload: { end_reason: input.reason === 'error' ? 'error' : 'completed' },
  })
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
