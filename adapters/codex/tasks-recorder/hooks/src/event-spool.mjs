import { createHash, randomUUID } from 'node:crypto'
import {
  chmod,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
} from 'node:fs/promises'
import { join } from 'node:path'

import { parseEventEnvelope } from './event-envelope.mjs'

const DEFAULT_MAX_BYTES = 4 * 1024 * 1024
const DEFAULT_MAX_FILES = 512
const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
const DEFAULT_LOCK_WAIT_MS = 500
const DEFAULT_LOCK_STALE_MS = 5_000

function positiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${field} must be a positive safe integer`)
  }
  return value
}

function clockMillis(clock) {
  const value = clock()
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.valueOf())) throw new TypeError('clock must return a valid date')
  return date.valueOf()
}

function safeFilePart(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 96) || 'event'
}

function heartbeatIdentity(envelope) {
  return createHash('sha256').update([
    envelope.source,
    envelope.source_session_key,
    envelope.source_turn_key,
    envelope.source_agent_key ?? '',
  ].join('\u0000')).digest('hex').slice(0, 24)
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function isHeartbeatName(name) {
  return name.startsWith('heartbeat-')
}

async function ensureDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await chmod(directory, 0o700)
}

async function spoolFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.ndjson')) continue
    const path = join(directory, entry.name)
    const metadata = await stat(path)
    files.push({
      name: entry.name,
      path,
      bytes: metadata.size,
      modified_at: metadata.mtimeMs,
      heartbeat: isHeartbeatName(entry.name),
    })
  }
  return files.sort((left, right) => (
    left.modified_at - right.modified_at || left.name.localeCompare(right.name)
  ))
}

async function replayClaimFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const claims = []
  for (const entry of entries) {
    const marker = '.replaying-'
    const markerIndex = entry.name.indexOf(marker)
    if (!entry.isFile() || markerIndex === -1) continue
    const originalName = entry.name.slice(0, markerIndex)
    if (!originalName.endsWith('.ndjson')) continue
    const path = join(directory, entry.name)
    const metadata = await stat(path)
    claims.push({
      path,
      original_path: join(directory, originalName),
      original_name: originalName,
      modified_at: metadata.mtimeMs,
      heartbeat: isHeartbeatName(originalName),
    })
  }
  return claims
}

function summarize(files) {
  return {
    backlog_files: files.length,
    backlog_bytes: files.reduce((total, file) => total + file.bytes, 0),
    boundary_files: files.filter((file) => !file.heartbeat).length,
    heartbeat_files: files.filter((file) => file.heartbeat).length,
  }
}

async function atomicWrite(path, contents, temporaryPath) {
  const handle = await open(temporaryPath, 'wx', 0o600)
  try {
    await handle.writeFile(contents, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await rename(temporaryPath, path)
    await chmod(path, 0o600)
  } catch (error) {
    await rm(temporaryPath, { force: true })
    throw error
  }
}

export function createEventSpool({
  directory,
  maxBytes = DEFAULT_MAX_BYTES,
  maxFiles = DEFAULT_MAX_FILES,
  maxAgeMs = DEFAULT_MAX_AGE_MS,
  lockWaitMs = DEFAULT_LOCK_WAIT_MS,
  lockStaleMs = DEFAULT_LOCK_STALE_MS,
  clock = () => new Date(),
  uuid = randomUUID,
  validateEvent = parseEventEnvelope,
} = {}) {
  if (typeof directory !== 'string' || directory.trim() === '') {
    throw new TypeError('directory must be a non-empty string')
  }
  const byteCap = positiveInteger(maxBytes, 'maxBytes')
  const fileCap = positiveInteger(maxFiles, 'maxFiles')
  const ageCap = positiveInteger(maxAgeMs, 'maxAgeMs')
  const lockWait = positiveInteger(lockWaitMs, 'lockWaitMs')
  const lockStale = positiveInteger(lockStaleMs, 'lockStaleMs')
  if (typeof validateEvent !== 'function') throw new TypeError('validateEvent must be a function')
  const metrics = {
    queued: 0,
    dropped: 0,
    replayed: 0,
    isolated: 0,
    evicted: 0,
    expired: 0,
    recovered_claims: 0,
    last_replay_at: null,
    last_replay_error: null,
  }

  function recordQueue(result) {
    if (result.queued) metrics.queued += 1
    if (result.dropped) metrics.dropped += 1
    metrics.evicted += result.evicted
    metrics.expired += result.expired
    return result
  }

  async function withDirectoryLock(operation) {
    await ensureDirectory(directory)
    const lockPath = join(directory, '.write-lock')
    const deadline = Date.now() + lockWait
    while (true) {
      try {
        await mkdir(lockPath, { mode: 0o700 })
        break
      } catch (error) {
        if (error.code !== 'EEXIST') throw error
        const lockMetadata = await stat(lockPath).catch(() => null)
        if (lockMetadata && Date.now() - lockMetadata.mtimeMs > lockStale) {
          await rm(lockPath, { recursive: true, force: true })
          continue
        }
        if (Date.now() >= deadline) {
          const timeout = new Error('event spool writer lock timed out')
          timeout.code = 'SPOOL_LOCK_TIMEOUT'
          throw timeout
        }
        await delay(5)
      }
    }
    try {
      return await operation()
    } finally {
      await rm(lockPath, { recursive: true, force: true })
    }
  }

  async function removeExpired(files, now) {
    let expired = 0
    for (const file of files) {
      if (now - file.modified_at <= ageCap) continue
      await unlink(file.path).catch((error) => {
        if (error.code !== 'ENOENT') throw error
      })
      expired += 1
    }
    return expired
  }

  async function queue(input) {
    const envelope = validateEvent(input)
    const contents = `${JSON.stringify(envelope)}\n`
    const bytes = Buffer.byteLength(contents)
    const now = clockMillis(clock)
    const heartbeat = envelope.event_type === 'execution.heartbeat'
    const targetName = heartbeat
      ? `heartbeat-${heartbeatIdentity(envelope)}.ndjson`
      : `${String(now).padStart(13, '0')}-boundary-${safeFilePart(uuid())}.ndjson`
    const path = join(directory, targetName)
    if (bytes > byteCap) {
      return recordQueue({
        queued: false,
        dropped: true,
        reason: 'event_exceeds_spool_capacity',
        path: null,
        coalesced: false,
        evicted: 0,
        expired: 0,
      })
    }

    const result = await withDirectoryLock(async () => {
      let files = await spoolFiles(directory)
      const expired = await removeExpired(files, now)
      if (expired > 0) files = await spoolFiles(directory)
      const existingTarget = files.find((file) => file.path === path)
      files = files.filter((file) => file.path !== path)
      let totalBytes = files.reduce((total, file) => total + file.bytes, 0)
      let evicted = 0

      while (files.length + 1 > fileCap || totalBytes + bytes > byteCap) {
        const candidate = files.find((file) => file.heartbeat)
          ?? (heartbeat ? null : files[0])
        if (!candidate) {
          return {
            queued: false,
            dropped: true,
            reason: 'spool_capacity_exhausted',
            path: null,
            coalesced: existingTarget !== undefined,
            evicted,
            expired,
          }
        }
        await unlink(candidate.path).catch((error) => {
          if (error.code !== 'ENOENT') throw error
        })
        files = files.filter((file) => file.path !== candidate.path)
        totalBytes -= candidate.bytes
        evicted += 1
      }

      const temporaryPath = join(directory, `.${targetName}.${safeFilePart(uuid())}.tmp`)
      await atomicWrite(path, contents, temporaryPath)
      return {
        queued: true,
        dropped: false,
        reason: null,
        path,
        coalesced: existingTarget !== undefined,
        evicted,
        expired,
      }
    })
    return recordQueue(result)
  }

  async function status() {
    await ensureDirectory(directory)
    const [files, claims] = await Promise.all([
      spoolFiles(directory),
      replayClaimFiles(directory),
    ])
    return { ...summarize(files), claim_files: claims.length, ...metrics }
  }

  async function recoverStaleClaims() {
    return withDirectoryLock(async () => {
      const now = Date.now()
      const claims = await replayClaimFiles(directory)
      let recovered = 0
      for (const claim of claims) {
        if (now - claim.modified_at <= lockStale) continue
        const existing = await stat(claim.original_path).catch(() => null)
        if (existing && claim.heartbeat) {
          await rm(claim.path, { force: true })
        } else if (existing) {
          const fallback = `${claim.original_path}.${safeFilePart(uuid())}.ndjson`
          await rename(claim.path, fallback)
          await chmod(fallback, 0o600)
        } else {
          await rename(claim.path, claim.original_path)
          await chmod(claim.original_path, 0o600)
        }
        recovered += 1
      }
      metrics.recovered_claims += recovered
      return recovered
    })
  }

  async function claim(file) {
    return withDirectoryLock(async () => {
      const claimedPath = `${file.path}.replaying-${safeFilePart(uuid())}`
      try {
        await rename(file.path, claimedPath)
      } catch (error) {
        if (error.code === 'ENOENT') return null
        throw error
      }
      await chmod(claimedPath, 0o600)
      return { ...file, original_path: file.path, path: claimedPath }
    })
  }

  async function restoreClaim(file) {
    return withDirectoryLock(async () => {
      const existing = await stat(file.original_path).catch(() => null)
      if (existing && file.heartbeat) {
        await rm(file.path, { force: true })
        return
      }
      if (existing) {
        const fallback = `${file.original_path}.${safeFilePart(uuid())}.ndjson`
        await rename(file.path, fallback)
        await chmod(fallback, 0o600)
        return
      }
      await rename(file.path, file.original_path)
      await chmod(file.original_path, 0o600)
    })
  }

  async function isolate(file) {
    const invalidPath = `${file.original_path}.${safeFilePart(uuid())}.invalid`
    await rename(file.path, invalidPath)
    await chmod(invalidPath, 0o600)
  }

  async function replay(send, { isPermanentError = () => false } = {}) {
    if (typeof send !== 'function') throw new TypeError('send must be a function')
    if (typeof isPermanentError !== 'function') {
      throw new TypeError('isPermanentError must be a function')
    }
    await ensureDirectory(directory)
    const recoveredClaims = await recoverStaleClaims()
    const files = await spoolFiles(directory)
    let replayed = 0
    let isolated = 0
    for (const file of files) {
      const claimed = await claim(file)
      if (!claimed) continue
      let envelope
      try {
        const lines = (await readFile(claimed.path, 'utf8'))
          .split('\n')
          .filter((line) => line.trim() !== '')
        if (lines.length !== 1) throw new Error('spool record must contain exactly one event')
        envelope = validateEvent(JSON.parse(lines[0]))
      } catch {
        await isolate(claimed)
        isolated += 1
        metrics.isolated += 1
        continue
      }
      try {
        await send(envelope)
      } catch (error) {
        let permanent = false
        try {
          permanent = isPermanentError(error, envelope) === true
        } catch {
          // A broken classifier must retain the event instead of risking data loss.
        }
        if (permanent) {
          await isolate(claimed)
          isolated += 1
          metrics.isolated += 1
          continue
        }
        await restoreClaim(claimed)
        metrics.last_replay_at = new Date(clockMillis(clock)).toISOString()
        metrics.last_replay_error = 'SPOOL_REPLAY_SEND_FAILED'
        const pending = (await status()).backlog_files
        return {
          replayed,
          isolated,
          pending,
          last_error: 'SPOOL_REPLAY_SEND_FAILED',
          recovered_claims: recoveredClaims,
        }
      }
      await unlink(claimed.path).catch((error) => {
        if (error.code !== 'ENOENT') throw error
      })
      replayed += 1
      metrics.replayed += 1
    }
    metrics.last_replay_at = new Date(clockMillis(clock)).toISOString()
    metrics.last_replay_error = null
    return {
      replayed,
      isolated,
      pending: (await status()).backlog_files,
      last_error: null,
      recovered_claims: recoveredClaims,
    }
  }

  return { queue, replay, status }
}
