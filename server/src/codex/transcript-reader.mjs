import { createReadStream } from 'node:fs'
import { open, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import readline from 'node:readline'

import { TaskRecorderError } from '../../../mcp/src/errors.mjs'

const DEFAULT_METADATA_BYTES = 64 * 1024
const DEFAULT_LINE_BYTES = 4 * 1024 * 1024

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

function warning(code, details) {
  return { code, ...(details === undefined ? {} : { details }) }
}

function ensurePositiveLimit(value, field, maximum) {
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${field} must be an integer between 1 and ${maximum}`)
  }
}

function isContained(root, target) {
  const pathFromRoot = relative(root, target)
  return pathFromRoot !== '..'
    && !pathFromRoot.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
    && !isAbsolute(pathFromRoot)
}

async function resolveTranscriptPath(path, sessionsRoot) {
  let root
  let transcriptPath
  try {
    [root, transcriptPath] = await Promise.all([realpath(sessionsRoot), realpath(path)])
  } catch (error) {
    throw new TaskRecorderError(
      'CODEX_TRANSCRIPT_UNAVAILABLE',
      'Codex transcript is unavailable',
      { cause: error.code ?? error.message },
    )
  }
  if (!isContained(root, transcriptPath)) {
    throw new TaskRecorderError(
      'CODEX_TRANSCRIPT_PATH_REJECTED',
      'Codex transcript must be inside the sessions directory',
    )
  }
  return { root, transcriptPath }
}

function normalizeMetadata(record, transcriptPath) {
  const payload = record?.payload
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  const sessionId = nonEmptyString(payload.id) ?? nonEmptyString(payload.session_id)
  const workfolder = nonEmptyString(payload.cwd)
  if (sessionId === null || workfolder === null) return null
  const spawn = payload.source?.subagent?.thread_spawn
  return {
    session_id: sessionId,
    parent_session_id: nonEmptyString(payload.parent_thread_id)
      ?? nonEmptyString(spawn?.parent_thread_id),
    agent_path: nonEmptyString(payload.agent_path) ?? nonEmptyString(spawn?.agent_path),
    agent_type: nonEmptyString(payload.agent_role)
      ?? nonEmptyString(spawn?.agent_role)
      ?? nonEmptyString(payload.agent_type)
      ?? nonEmptyString(spawn?.agent_type),
    workfolder,
    branch: nonEmptyString(payload.git?.branch),
    repository: nonEmptyString(
      payload.git?.repository_url ?? payload.git?.repository ?? payload.git?.repo,
    ),
    timestamp: normalizeTimestamp(record.timestamp ?? payload.timestamp),
    transcript_path: transcriptPath,
  }
}

function normalizeTimestamp(value) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) return null
  return new Date(value).toISOString()
}

function normalizeTurnEvent(record) {
  const payload = record?.payload
  if (record?.type !== 'event_msg' || !payload || typeof payload !== 'object') return null
  const turnId = nonEmptyString(payload.turn_id)
  const timestamp = normalizeTimestamp(record.timestamp)
  if (turnId === null || timestamp === null) return null
  if (payload.type === 'task_started') {
    return { type: 'started', turn_id: turnId, timestamp }
  }
  if (payload.type === 'task_complete') {
    return { type: 'completed', turn_id: turnId, timestamp }
  }
  if (payload.type === 'turn_aborted') {
    return { type: 'interrupted', turn_id: turnId, timestamp }
  }
  return null
}

function lineLooksRelevant(line, spawnCallIds) {
  if (
    line.includes('"session_meta"')
    || line.includes('"task_started"')
    || line.includes('"task_complete"')
    || line.includes('"turn_aborted"')
    || line.includes('"spawn_agent"')
  ) return true
  if (!line.includes('"function_call_output"')) return false
  const callId = line.match(/"call_id"\s*:\s*"([^"\\]+)"/)?.[1]
  return callId !== undefined && spawnCallIds.has(callId)
}

function parseSpawnArguments(value) {
  if (typeof value !== 'string') return {}
  try {
    const parsed = JSON.parse(value)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return {
      requested_name: nonEmptyString(parsed.task_name),
      agent_type: nonEmptyString(parsed.agent_type),
    }
  } catch {
    return {}
  }
}

function successfulSpawnName(value) {
  if (typeof value !== 'string') return null
  try {
    const parsed = JSON.parse(value)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return nonEmptyString(parsed.task_name)
  } catch {
    return null
  }
}

function finalizeTurns(turnMap) {
  return [...turnMap.values()]
    .map((turn) => ({
      turn_id: turn.turn_id,
      status: turn.terminal?.type ?? 'unknown',
      started_at: turn.started_at,
      last_seen_at: turn.terminal?.timestamp ?? turn.last_seen_at ?? turn.started_at,
      ended_at: turn.terminal?.timestamp ?? null,
    }))
    .sort((left, right) => (
      left.started_at.localeCompare(right.started_at)
      || left.turn_id.localeCompare(right.turn_id)
    ))
}

export async function readCodexSessionMetadata(path, {
  sessionsRoot = join(homedir(), '.codex', 'sessions'),
  maxBytes = DEFAULT_METADATA_BYTES,
} = {}) {
  ensurePositiveLimit(maxBytes, 'maxBytes', 1024 * 1024)
  const { transcriptPath } = await resolveTranscriptPath(path, sessionsRoot)
  const handle = await open(transcriptPath, 'r')
  try {
    const buffer = Buffer.alloc(maxBytes + 1)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    const truncated = bytesRead > maxBytes
    const source = buffer.subarray(0, Math.min(bytesRead, maxBytes)).toString('utf8')
    const lines = source.split('\n')
    if (truncated) lines.pop()
    for (const line of lines) {
      if (line.trim() === '') continue
      let record
      try {
        record = JSON.parse(line)
      } catch {
        continue
      }
      if (record?.type !== 'session_meta') continue
      const metadata = normalizeMetadata(record, transcriptPath)
      if (metadata === null) {
        throw new TaskRecorderError(
          'CODEX_SESSION_META_INVALID',
          'Codex session metadata is missing required lifecycle fields',
        )
      }
      return metadata
    }
    throw new TaskRecorderError(
      truncated ? 'CODEX_SESSION_META_LIMIT' : 'CODEX_SESSION_META_MISSING',
      truncated
        ? 'Codex session metadata was not found within the bounded prefix'
        : 'Codex session metadata is missing',
    )
  } finally {
    await handle.close()
  }
}

export async function readCodexTranscript(path, {
  sessionsRoot = join(homedir(), '.codex', 'sessions'),
  maxLineBytes = DEFAULT_LINE_BYTES,
} = {}) {
  ensurePositiveLimit(maxLineBytes, 'maxLineBytes', 16 * 1024 * 1024)
  const { transcriptPath } = await resolveTranscriptPath(path, sessionsRoot)
  const metadata = await readCodexSessionMetadata(transcriptPath, { sessionsRoot })
  const turns = new Map()
  const spawnCalls = new Map()
  const successfulSpawns = []
  const failedSpawns = []
  const warnings = []
  let currentTurnId = null
  let lastEventAt = metadata.timestamp
  let lineNumber = 0

  const input = createReadStream(transcriptPath, { encoding: 'utf8' })
  for await (const line of readline.createInterface({ input, crlfDelay: Infinity })) {
    lineNumber += 1
    if (line.trim() === '' || !lineLooksRelevant(line, spawnCalls)) continue
    if (Buffer.byteLength(line) > maxLineBytes) {
      warnings.push(warning('TRANSCRIPT_LINE_LIMIT', { line: lineNumber }))
      continue
    }
    let record
    try {
      record = JSON.parse(line)
    } catch {
      warnings.push(warning('TRANSCRIPT_LINE_MALFORMED', { line: lineNumber }))
      continue
    }

    const turnEvent = normalizeTurnEvent(record)
    if (turnEvent !== null) {
      lastEventAt = turnEvent.timestamp
      if (turnEvent.type === 'started') {
        currentTurnId = turnEvent.turn_id
        const existing = turns.get(turnEvent.turn_id)
        if (!existing) {
          turns.set(turnEvent.turn_id, {
            turn_id: turnEvent.turn_id,
            started_at: turnEvent.timestamp,
            last_seen_at: turnEvent.timestamp,
            terminal: null,
          })
        }
      } else {
        const turn = turns.get(turnEvent.turn_id)
        if (turn) {
          if (turn.terminal === null || turnEvent.timestamp > turn.terminal.timestamp) {
            turn.terminal = turnEvent
          }
          turn.last_seen_at = turnEvent.timestamp
        }
        if (currentTurnId === turnEvent.turn_id) currentTurnId = null
      }
      continue
    }

    const payload = record?.payload
    if (record?.type !== 'response_item' || !payload || typeof payload !== 'object') continue
    if (payload.type === 'function_call' && payload.name === 'spawn_agent') {
      const callId = nonEmptyString(payload.call_id)
      if (callId === null || spawnCalls.has(callId)) continue
      spawnCalls.set(callId, {
        call_id: callId,
        turn_id: currentTurnId,
        timestamp: normalizeTimestamp(record.timestamp),
        ...parseSpawnArguments(payload.arguments),
      })
      continue
    }
    if (payload.type !== 'function_call_output') continue
    const callId = nonEmptyString(payload.call_id)
    const spawn = callId === null ? null : spawnCalls.get(callId)
    if (!spawn || spawn.resolved) continue
    spawn.resolved = true
    const taskName = successfulSpawnName(payload.output)
    if (taskName === null) {
      failedSpawns.push({
        call_id: spawn.call_id,
        turn_id: spawn.turn_id,
        timestamp: normalizeTimestamp(record.timestamp) ?? spawn.timestamp,
      })
    } else {
      successfulSpawns.push({
        call_id: spawn.call_id,
        turn_id: spawn.turn_id,
        timestamp: normalizeTimestamp(record.timestamp) ?? spawn.timestamp,
        task_name: taskName,
        agent_type: spawn.agent_type ?? null,
      })
    }
  }

  return {
    metadata,
    turns: finalizeTurns(turns),
    successful_spawns: successfulSpawns.sort((left, right) => (
      (left.timestamp ?? '').localeCompare(right.timestamp ?? '')
      || left.call_id.localeCompare(right.call_id)
    )),
    failed_spawns: failedSpawns.sort((left, right) => left.call_id.localeCompare(right.call_id)),
    last_event_at: lastEventAt,
    warnings,
  }
}
