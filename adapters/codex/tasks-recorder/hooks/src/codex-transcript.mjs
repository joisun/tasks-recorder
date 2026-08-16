import { open, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'

const DEFAULT_MAX_BYTES = 64 * 1024

function warning(code) {
  return { code }
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

function nestedValue(value, names, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 6) return null
  for (const name of names) {
    const found = nonEmptyString(value[name])
    if (found !== null) return found
  }
  for (const child of Object.values(value)) {
    const found = nestedValue(child, names, depth + 1)
    if (found !== null) return found
  }
  return null
}

function metadataFrom(record, transcriptPath) {
  const payload = record?.payload
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  const sessionId = nonEmptyString(payload.id ?? record.id)
  const workfolder = nonEmptyString(payload.cwd)
  if (sessionId === null || workfolder === null) return null
  const source = payload.source && typeof payload.source === 'object' ? payload.source : null
  return {
    session_id: sessionId,
    parent_session_id: nestedValue(source, ['parent_thread_id', 'parent_session_id']),
    agent_path: nestedValue(source, ['agent_path']),
    agent_type: nestedValue(source, ['agent_type']),
    workfolder,
    branch: nonEmptyString(payload.git?.branch),
    repository: nonEmptyString(
      payload.git?.repository_url ?? payload.git?.repository ?? payload.git?.repo,
    ),
    transcript_path: transcriptPath,
  }
}

export async function readCodexTranscriptMetadata(path, {
  sessionsRoot = join(homedir(), '.codex', 'sessions'),
  maxBytes = DEFAULT_MAX_BYTES,
} = {}) {
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 1024 * 1024) {
    throw new TypeError('maxBytes must be an integer between 1 and 1048576')
  }

  let root
  let transcriptPath
  try {
    root = await realpath(sessionsRoot)
    transcriptPath = await realpath(path)
  } catch {
    return { metadata: null, warnings: [warning('TRANSCRIPT_UNAVAILABLE')] }
  }
  const pathFromRoot = relative(root, transcriptPath)
  if (pathFromRoot === '..' || pathFromRoot.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(pathFromRoot)) {
    return { metadata: null, warnings: [warning('TRANSCRIPT_PATH_REJECTED')] }
  }

  let handle
  try {
    handle = await open(transcriptPath, 'r')
    const buffer = Buffer.alloc(maxBytes + 1)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    const truncated = bytesRead > maxBytes
    const source = buffer.subarray(0, Math.min(bytesRead, maxBytes)).toString('utf8')
    const lines = source.split('\n')
    if (truncated) lines.pop()
    let malformed = false
    for (const line of lines) {
      if (line.trim() === '') continue
      let record
      try {
        record = JSON.parse(line)
      } catch {
        malformed = true
        continue
      }
      if (record?.type !== 'session_meta') continue
      const metadata = metadataFrom(record, transcriptPath)
      if (metadata === null) {
        return { metadata: null, warnings: [warning('SESSION_META_MALFORMED')] }
      }
      return {
        metadata,
        warnings: malformed ? [warning('TRANSCRIPT_LINE_MALFORMED')] : [],
      }
    }
    if (truncated) {
      return { metadata: null, warnings: [warning('TRANSCRIPT_METADATA_LIMIT')] }
    }
    return {
      metadata: null,
      warnings: [warning(malformed ? 'SESSION_META_MALFORMED' : 'SESSION_META_MISSING')],
    }
  } catch {
    return { metadata: null, warnings: [warning('TRANSCRIPT_UNAVAILABLE')] }
  } finally {
    await handle?.close()
  }
}
