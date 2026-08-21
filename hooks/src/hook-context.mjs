import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { resolve } from 'node:path'
import { promisify } from 'node:util'

const MAX_STDIN_BYTES = 1024 * 1024
const execFileAsync = promisify(execFile)

export function detectAgent(input) {
  const explicit = String(input?.agent ?? input?.source ?? '').toLowerCase()
  if (explicit === 'codex') return 'Codex'
  if (explicit === 'claude') return 'Claude'
  const transcript = String(input?.transcript_path ?? '').toLowerCase()
  if (transcript.includes('/.codex/')) return 'Codex'
  if (transcript.includes('/.claude/')) return 'Claude'
  return 'Unknown'
}
export function sourceKey(input) {
  return detectAgent(input).toLowerCase()
}

export function dynamicContext(input, executionIdValue = null) {
  return {
    session_id: input?.session_id ?? null,
    turn_id: input?.turn_id ?? null,
    execution_id: executionIdValue,
    workfolder: input?.cwd ?? null,
    agent: detectAgent(input),
  }
}

function requiredString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} must be a non-empty string`)
  }
  return value.trim()
}

function optionalString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

export function executionId({ source, sessionId, turnKey }) {
  const identity = [source, sessionId, turnKey, ''].join('\u0000')
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
      git_root: optionalString(gitRoot),
      git_common_dir: optionalString(commonDirectory)
        ? resolve(workfolder, commonDirectory.trim())
        : null,
      git_remote: gitRemote,
      worktree: optionalString(gitRoot) ?? workfolder,
      branch: optionalString(branch),
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

async function envelope(input, turnKey, eventType, suffix, payload) {
  const source = sourceKey(input)
  const sessionId = requiredString(input?.session_id, 'session_id')
  const workfolder = requiredString(input?.cwd, 'cwd')
  return {
    source,
    event_type: eventType,
    external_event_id: `${source}:${suffix}`,
    observed_at: new Date().toISOString(),
    source_session_key: sessionId,
    root_session_key: sessionId,
    source_turn_key: turnKey,
    source_agent_key: null,
    project_id: null,
    ...await gitContext(workfolder),
    payload,
  }
}

export async function sessionStartedEvent(input) {
  const sessionId = requiredString(input?.session_id, 'session_id')
  return envelope(input, null, 'session.started', `session:${sessionId}:started`, {})
}

export async function mainExecutionStartedEvent(input, turnKey) {
  const sessionId = requiredString(input?.session_id, 'session_id')
  return envelope(
    input,
    requiredString(turnKey, 'turn_key'),
    'execution.started',
    `execution:${sessionId}:${turnKey}:started`,
    { kind: 'main' },
  )
}

export async function toolHeartbeatEvent(input, turnKey) {
  const sessionId = requiredString(input?.session_id, 'session_id')
  const eventKey = optionalString(input?.tool_use_id) ?? `${Date.now()}`
  return envelope(
    input,
    requiredString(turnKey, 'turn_key'),
    'execution.heartbeat',
    `execution:${sessionId}:${turnKey}:tool:${eventKey}`,
    { activity: 'tool_use' },
  )
}

export async function mainExecutionStoppedEvent(input, turnKey) {
  const sessionId = requiredString(input?.session_id, 'session_id')
  return envelope(
    input,
    requiredString(turnKey, 'turn_key'),
    'execution.stop',
    `execution:${sessionId}:${turnKey}:stopped`,
    { end_reason: 'stopped' },
  )
}

export async function sessionEndedEvent(input) {
  const sessionId = requiredString(input?.session_id, 'session_id')
  return envelope(
    input,
    null,
    'session.ended',
    `session:${sessionId}:ended`,
    { end_reason: input?.reason === 'error' ? 'error' : 'completed' },
  )
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
