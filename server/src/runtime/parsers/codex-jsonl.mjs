import { isAbsolute, relative, resolve, sep } from 'node:path'

import { runtimeEvent } from '../runtime-event.mjs'

const DEFAULT_LINE_BYTES = 256 * 1024
const DEFAULT_FINAL_BYTES = 8 * 1024
const DEFAULT_FILE_CHANGES = 128
const DEFAULT_FILE_PATH_BYTES = 2048
const FILE_CHANGE_KINDS = new Set(['add', 'update', 'delete'])

export function parseCodexJsonLine(line, context) {
  const event = decodeCodexEvent(line)
  if (!event) return []

  const envelope = (type, payload) => runtimeEvent({
    runId: context.runId,
    sequence: context.sequence,
    observedAt: context.observedAt,
    type,
    payload,
  })

  if (event.type === 'thread.started' && boundedString(event.thread_id, 256)) {
    return [envelope('session', { session_id: event.thread_id })]
  }
  if (event.type === 'item.completed' && event.item?.type === 'agent_message'
    && boundedString(event.item.text, DEFAULT_FINAL_BYTES)) {
    return [envelope('text_delta', { text: event.item.text })]
  }
  if (event.type === 'item.completed' && event.item?.type === 'file_change'
    && event.item.status === 'completed' && Array.isArray(event.item.changes)) {
    const workspace = canonicalWorkspace(context.workspace)
    const changes = event.item.changes
      .map((change) => containedFileChange(change, workspace, DEFAULT_FILE_PATH_BYTES))
      .filter(Boolean)
      .slice(0, DEFAULT_FILE_CHANGES)
    return changes.length > 0 ? [envelope('file_change', { changes })] : []
  }
  if (event.type === 'turn.completed') return [envelope('done', {})]
  return []
}

export function createCodexJsonlCollector({
  workspace = null,
  maxLineBytes = DEFAULT_LINE_BYTES,
  maxFinalMessageBytes = DEFAULT_FINAL_BYTES,
  maxFileChanges = DEFAULT_FILE_CHANGES,
  maxFilePathBytes = DEFAULT_FILE_PATH_BYTES,
} = {}) {
  const lineCap = positive(maxLineBytes, 'maxLineBytes')
  const finalCap = positive(maxFinalMessageBytes, 'maxFinalMessageBytes')
  const fileCap = positive(maxFileChanges, 'maxFileChanges')
  const pathCap = positive(maxFilePathBytes, 'maxFilePathBytes')
  const workspaceRoot = canonicalWorkspace(workspace)
  if (workspace !== null && workspaceRoot === null) {
    throw new TypeError('workspace must be a non-empty string or null')
  }

  let pending = Buffer.alloc(0)
  let discarding = false
  let threadId = null
  let finalMessage = null
  let terminalSeen = false
  let malformedLines = 0
  let oversizedLines = 0
  const fileChanges = new Map()

  function consume(line) {
    if (line.byteLength > lineCap) {
      oversizedLines += 1
      return
    }
    const event = decodeCodexEvent(line)
    if (!event) {
      malformedLines += 1
      return
    }
    if (event.type === 'thread.started' && threadId === null
      && boundedString(event.thread_id, 256)) {
      threadId = event.thread_id
    }
    if (event.type === 'item.completed' && event.item?.type === 'file_change'
      && event.item.status === 'completed' && Array.isArray(event.item.changes)) {
      for (const candidate of event.item.changes) {
        const change = containedFileChange(candidate, workspaceRoot, pathCap)
        if (change === null || (!fileChanges.has(change.path) && fileChanges.size >= fileCap)) {
          continue
        }
        fileChanges.set(change.path, change)
      }
    }
    if (!terminalSeen) {
      const text = agentMessage(event)
      if (text !== null && Buffer.byteLength(text) <= finalCap) finalMessage = text
      if (event.type === 'turn.completed') terminalSeen = true
    }
  }

  function write(chunk) {
    const source = toBuffer(chunk)
    let offset = 0
    while (offset < source.byteLength) {
      if (discarding) {
        const newline = source.indexOf(0x0a, offset)
        if (newline === -1) return
        discarding = false
        offset = newline + 1
        continue
      }

      const newline = source.indexOf(0x0a, offset)
      const piece = newline === -1
        ? source.subarray(offset)
        : source.subarray(offset, newline)
      if (pending.byteLength + piece.byteLength > lineCap) {
        oversizedLines += 1
        pending = Buffer.alloc(0)
        if (newline === -1) {
          discarding = true
          return
        }
      } else if (newline === -1) {
        pending = pending.byteLength === 0
          ? Buffer.from(piece)
          : Buffer.concat([pending, piece])
        return
      } else {
        const line = pending.byteLength === 0
          ? piece
          : Buffer.concat([pending, piece])
        pending = Buffer.alloc(0)
        consume(line)
      }
      offset = newline + 1
    }
  }

  function finish() {
    if (!discarding && pending.byteLength) consume(pending)
    pending = Buffer.alloc(0)
    return Object.freeze({
      thread_id: threadId,
      final_message: finalMessage,
      file_changes: Object.freeze(
        [...fileChanges.values()].map((change) => Object.freeze(change)),
      ),
      malformed_lines: malformedLines,
      oversized_lines: oversizedLines,
      terminal_seen: terminalSeen,
      buffered_bytes: pending.byteLength,
    })
  }

  return Object.freeze({ write, finish })
}

function decodeCodexEvent(line) {
  const bytes = Buffer.isBuffer(line) ? line : Buffer.from(line)
  if (bytes.byteLength > DEFAULT_LINE_BYTES) return null
  try {
    const event = JSON.parse(bytes.toString('utf8'))
    return isObject(event) ? event : null
  } catch {
    return null
  }
}

function containedFileChange(change, workspace, pathCap) {
  if (!workspace || !isObject(change) || !FILE_CHANGE_KINDS.has(change.kind)
    || !boundedString(change.path, pathCap)) return null
  const absolute = isAbsolute(change.path) ? resolve(change.path) : resolve(workspace, change.path)
  const child = relative(workspace, absolute)
  if (child === '' || isAbsolute(child) || child === '..' || child.startsWith(`..${sep}`)) {
    return null
  }
  const path = child.split(sep).join('/')
  return Buffer.byteLength(path) <= pathCap ? { path, kind: change.kind } : null
}

function canonicalWorkspace(workspace) {
  return typeof workspace === 'string' && workspace.trim() !== ''
    ? resolve(workspace)
    : null
}

function agentMessage(event) {
  const item = event?.item
  return event?.type === 'item.completed' && item?.type === 'agent_message'
    && typeof item.text === 'string'
    ? item.text
    : null
}

function toBuffer(chunk) {
  if (Buffer.isBuffer(chunk)) return chunk
  if (chunk instanceof Uint8Array) {
    return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
  }
  if (typeof chunk === 'string') return Buffer.from(chunk, 'utf8')
  throw new TypeError('JSONL chunks must be bytes or strings')
}

function positive(value, field) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${field} must be a positive safe integer`)
  }
  return value
}

function boundedString(value, maximum) {
  return typeof value === 'string' && value.length > 0
    && Buffer.byteLength(value) <= maximum
}

function isObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
}
