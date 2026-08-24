import { readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'

import { readCodexSessionMetadata } from './transcript-reader.mjs'

const DEFAULT_CACHE_TTL_MS = 30_000
const SESSION_ID_SUFFIX = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i

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

function filenameSessionId(path) {
  return basename(path).match(SESSION_ID_SUFFIX)?.[1] ?? null
}

export function createCodexSessionInventory({
  sessionsRoot = join(homedir(), '.codex', 'sessions'),
  cacheTtlMs = DEFAULT_CACHE_TTL_MS,
  clock = () => Date.now(),
  readMetadata = readCodexSessionMetadata,
} = {}) {
  if (!Number.isFinite(cacheTtlMs) || cacheTtlMs < 0) {
    throw new TypeError('cacheTtlMs must be a non-negative number')
  }
  const exactSessionsRoot = resolve(sessionsRoot)
  let index = null
  let expiresAt = 0
  let verified = new Map()

  async function refresh() {
    const bySessionId = new Map()
    for (const path of await listTranscriptFiles(exactSessionsRoot)) {
      const sessionId = filenameSessionId(path)
      if (sessionId === null) continue
      const paths = bySessionId.get(sessionId) ?? []
      paths.push(path)
      bySessionId.set(sessionId, paths)
    }
    index = bySessionId
    verified = new Map()
    expiresAt = Number(clock()) + cacheTtlMs
    return index
  }

  async function currentIndex() {
    if (index === null || Number(clock()) >= expiresAt) return refresh()
    return index
  }

  async function ids() {
    try {
      const current = await currentIndex()
      return new Set([...current.entries()]
        .filter(([, paths]) => paths.length === 1)
        .map(([sessionId]) => sessionId))
    } catch {
      return new Set()
    }
  }

  async function has(sessionId) {
    if (typeof sessionId !== 'string' || sessionId.trim() === '') return false
    let current
    try {
      current = await currentIndex()
    } catch {
      return false
    }
    const paths = current.get(sessionId)
    if (!paths || paths.length !== 1) return false
    const cacheKey = `${sessionId}\u0000${paths[0]}`
    if (verified.has(cacheKey)) return verified.get(cacheKey)
    let matches = false
    try {
      const metadata = await readMetadata(paths[0], { sessionsRoot: exactSessionsRoot })
      matches = metadata.session_id === sessionId
    } catch {
      matches = false
    }
    verified.set(cacheKey, matches)
    return matches
  }

  return { ids, has }
}
