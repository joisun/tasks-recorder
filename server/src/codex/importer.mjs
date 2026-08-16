import { readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import { TaskRecorderError } from '../../../mcp/src/errors.mjs'
import {
  readCodexSessionMetadata,
  readCodexTranscript,
} from './transcript-reader.mjs'

function requiredString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TaskRecorderError('CODEX_IMPORT_INPUT_INVALID', `${field} must be a non-empty string`, {
      field,
    })
  }
  return value.trim()
}

async function listTranscriptFiles(directory) {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
  const files = []
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await listTranscriptFiles(path))
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(path)
  }
  return files
}

async function scanMetadata(files, sessionsRoot) {
  const records = []
  for (const path of files) {
    try {
      records.push({ path, metadata: await readCodexSessionMetadata(path, { sessionsRoot }) })
    } catch (error) {
      if (!(error instanceof TaskRecorderError)) throw error
    }
  }
  return records
}

export async function resolveCodexSession({
  sessionId,
  codexHome = join(homedir(), '.codex'),
} = {}) {
  const exactSessionId = requiredString(sessionId, 'sessionId')
  const sessionsRoot = resolve(codexHome, 'sessions')
  const files = await listTranscriptFiles(sessionsRoot)
  const metadataRecords = await scanMetadata(files, sessionsRoot)
  const candidates = metadataRecords.filter(({ metadata }) => metadata.session_id === exactSessionId)
  if (candidates.length === 0) {
    throw new TaskRecorderError(
      'CODEX_SESSION_NOT_FOUND',
      `Codex session ${exactSessionId} was not found`,
      { session_id: exactSessionId },
    )
  }
  if (candidates.length > 1) {
    throw new TaskRecorderError(
      'CODEX_SESSION_AMBIGUOUS',
      `Codex session ${exactSessionId} resolves to multiple transcripts`,
      { session_id: exactSessionId, count: candidates.length },
    )
  }
  return { ...candidates[0], sessionsRoot, metadataRecords }
}

function rootTurnRecord(root, turn) {
  return {
    external_key: `codex:turn:${root.metadata.session_id}:${turn.turn_id}:0`,
    kind: 'main',
    root_session_id: root.metadata.session_id,
    session_id: root.metadata.session_id,
    turn_id: turn.turn_id,
    agent_id: null,
    agent_type: 'Codex',
    agent_path: null,
    parent_external_key: null,
    transcript_path: root.metadata.transcript_path,
    task_id: null,
    classification: 'unknown',
    workfolder: root.metadata.workfolder,
    git_root: null,
    worktree: root.metadata.workfolder,
    branch: root.metadata.branch,
    status: turn.status,
    started_at: turn.started_at,
    last_seen_at: turn.last_seen_at,
    ended_at: turn.ended_at,
  }
}

function childExecutionState(child) {
  if (child.turns.length === 0) {
    const startedAt = child.metadata.timestamp
    return {
      status: 'unknown',
      started_at: startedAt,
      last_seen_at: child.last_event_at ?? startedAt,
      ended_at: null,
    }
  }
  const first = child.turns[0]
  const last = child.turns.at(-1)
  return {
    status: last.status,
    started_at: first.started_at,
    last_seen_at: last.last_seen_at,
    ended_at: last.ended_at,
  }
}

function childRecord(rootSessionId, child, spawn) {
  const state = childExecutionState(child)
  const turnId = spawn?.turn_id ?? null
  return {
    external_key: `codex:import:subagent:${rootSessionId}:${child.metadata.session_id}`,
    kind: 'subagent',
    root_session_id: rootSessionId,
    session_id: child.metadata.session_id,
    turn_id: turnId,
    agent_id: child.metadata.session_id,
    agent_type: child.metadata.agent_type ?? spawn?.agent_type ?? null,
    agent_path: child.metadata.agent_path,
    parent_external_key: turnId === null
      ? null
      : `codex:turn:${rootSessionId}:${turnId}:0`,
    transcript_path: child.metadata.transcript_path,
    task_id: null,
    classification: 'unknown',
    workfolder: child.metadata.workfolder,
    git_root: null,
    worktree: child.metadata.workfolder,
    branch: child.metadata.branch,
    ...state,
  }
}

function matchSpawn(child, spawns, usedCallIds) {
  const exact = spawns.filter((spawn) => (
    !usedCallIds.has(spawn.call_id)
    && spawn.task_name === child.metadata.agent_path
  ))
  const childStart = child.turns[0]?.started_at ?? child.metadata.timestamp
  const candidate = exact.find((spawn) => (
    spawn.timestamp === null || childStart === null || spawn.timestamp <= childStart
  )) ?? exact[0] ?? null
  if (candidate !== null) usedCallIds.add(candidate.call_id)
  return candidate
}

function importWarning(code, details) {
  return { code, ...(details === undefined ? {} : { details }) }
}

export async function parseCodexImport({
  sessionId,
  codexHome = join(homedir(), '.codex'),
} = {}) {
  const resolved = await resolveCodexSession({ sessionId, codexHome })
  const root = await readCodexTranscript(resolved.path, { sessionsRoot: resolved.sessionsRoot })
  if (root.metadata.parent_session_id !== null) {
    throw new TaskRecorderError(
      'CODEX_IMPORT_ROOT_REQUIRED',
      'Codex historical import requires a root session',
      { session_id: root.metadata.session_id },
    )
  }

  const childMetadata = resolved.metadataRecords
    .filter(({ metadata }) => metadata.parent_session_id === root.metadata.session_id)
    .sort((left, right) => (
      (left.metadata.timestamp ?? '').localeCompare(right.metadata.timestamp ?? '')
      || left.metadata.session_id.localeCompare(right.metadata.session_id)
    ))
  const children = []
  for (const { path } of childMetadata) {
    children.push(await readCodexTranscript(path, { sessionsRoot: resolved.sessionsRoot }))
  }

  const warnings = [...root.warnings]
  for (const spawn of root.failed_spawns) {
    warnings.push(importWarning('CODEX_SUBAGENT_SPAWN_FAILED', {
      call_id: spawn.call_id,
      turn_id: spawn.turn_id,
    }))
  }
  for (const child of children) warnings.push(...child.warnings)

  const usedCallIds = new Set()
  const childRecords = children.map((child) => {
    const spawn = matchSpawn(child, root.successful_spawns, usedCallIds)
    if (spawn === null) {
      warnings.push(importWarning('CODEX_CHILD_SPAWN_UNMATCHED', {
        session_id: child.metadata.session_id,
      }))
    }
    return childRecord(root.metadata.session_id, child, spawn)
  })
  for (const spawn of root.successful_spawns) {
    if (usedCallIds.has(spawn.call_id)) continue
    warnings.push(importWarning('CODEX_CHILD_TRANSCRIPT_MISSING', {
      call_id: spawn.call_id,
      turn_id: spawn.turn_id,
    }))
  }

  const records = [
    ...root.turns.map((turn) => rootTurnRecord(root, turn)),
    ...childRecords.sort((left, right) => (
      left.started_at.localeCompare(right.started_at)
      || left.session_id.localeCompare(right.session_id)
    )),
  ]
  return {
    source: 'codex',
    session_id: root.metadata.session_id,
    root_turns: root.turns.length,
    subagent_executions: childRecords.length,
    records,
    warnings,
  }
}
