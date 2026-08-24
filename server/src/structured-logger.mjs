import { randomUUID } from 'node:crypto'
import { chmod, mkdir, open, readdir, rename, rm, stat, utimes } from 'node:fs/promises'
import { join } from 'node:path'

const EVENT_FIELDS = new Map([
  ['event.accepted', new Set([
    'source', 'event_type', 'deduped', 'persisted', 'observation_id', 'execution_id',
    'project_resolution',
  ])],
  ['event.rejected', new Set(['source', 'event_type', 'error_code'])],
  ['lifecycle.transition', new Set([
    'operation', 'execution_id', 'execution_count', 'task_count',
  ])],
  ['maintenance.failed', new Set(['operation', 'error_code'])],
  ['spool.queued', new Set(['count', 'error_code'])],
  ['spool.replayed', new Set(['count', 'pending', 'error_code'])],
  ['spool.dropped', new Set(['count', 'error_code'])],
  ['recovery.completed', new Set(['recovered_count', 'stale_count', 'error_code'])],
  ['migration.completed', new Set(['created_count', 'updated_count', 'error_code'])],
])
const WARNING_EVENTS = new Set(['event.rejected', 'spool.dropped', 'maintenance.failed'])

function loggerError(code, message, fields = []) {
  const error = new Error(message)
  error.code = code
  error.fields = fields
  return error
}

function positiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${field} must be a positive safe integer`)
  }
  return value
}

function timestamp(clock) {
  const value = clock()
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.valueOf())) throw new TypeError('clock must return a valid date')
  return date
}

function validateFields(event, fields) {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
    throw loggerError('LOG_FIELDS_INVALID', 'log fields must be an object')
  }
  const allowed = EVENT_FIELDS.get(event)
  if (!allowed) throw loggerError('LOG_EVENT_UNSUPPORTED', `unsupported log event ${event}`)
  const unknown = Object.keys(fields).filter((field) => !allowed.has(field)).sort()
  if (unknown.length > 0) {
    throw loggerError('LOG_FIELDS_INVALID', 'log fields contain unsupported keys', unknown)
  }
  for (const [field, value] of Object.entries(fields)) {
    const primitive = value === null || ['string', 'number', 'boolean'].includes(typeof value)
    if (!primitive || (typeof value === 'number' && !Number.isFinite(value))) {
      throw loggerError('LOG_FIELDS_INVALID', `${field} must be a JSON primitive`, [field])
    }
    if (typeof value === 'string' && value.length > 1024) {
      throw loggerError('LOG_FIELDS_INVALID', `${field} exceeds 1024 characters`, [field])
    }
  }
}

async function ensureDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await chmod(directory, 0o700)
}

async function logFiles(directory) {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
  const files = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.ndjson')) continue
    const path = join(directory, entry.name)
    const metadata = await stat(path)
    files.push({ name: entry.name, path, bytes: metadata.size, modified_at: metadata.mtimeMs })
  }
  return files.sort((left, right) => (
    left.modified_at - right.modified_at || left.name.localeCompare(right.name)
  ))
}

export function createStructuredLogger({
  directory,
  maxFileBytes = 1024 * 1024,
  maxFiles = 5,
  maxAgeMs = 14 * 24 * 60 * 60 * 1000,
  clock = () => new Date(),
  uuid = randomUUID,
} = {}) {
  if (typeof directory !== 'string' || directory.trim() === '') {
    throw new TypeError('directory must be a non-empty string')
  }
  const fileCap = positiveInteger(maxFileBytes, 'maxFileBytes')
  const retentionFiles = positiveInteger(maxFiles, 'maxFiles')
  const retentionAge = positiveInteger(maxAgeMs, 'maxAgeMs')
  const activePath = join(directory, 'tasks-recorder.ndjson')
  let queue = Promise.resolve()
  let lastWrittenAt = null
  let lastErrorCode = null

  async function prune(nowMs) {
    let files = await logFiles(directory)
    let pruned = 0
    for (const file of files) {
      if (file.path === activePath || nowMs - file.modified_at <= retentionAge) continue
      await rm(file.path, { force: true })
      pruned += 1
    }
    files = await logFiles(directory)
    while (files.length > retentionFiles) {
      const candidate = files.find((file) => file.path !== activePath) ?? files[0]
      await rm(candidate.path, { force: true })
      files = files.filter((file) => file.path !== candidate.path)
      pruned += 1
    }
    return pruned
  }

  async function writeNow(event, fields) {
    const now = timestamp(clock)
    const record = {
      timestamp: now.toISOString(),
      level: WARNING_EVENTS.has(event) ? 'warn' : 'info',
      event,
      ...fields,
    }
    const line = `${JSON.stringify(record)}\n`
    const bytes = Buffer.byteLength(line)
    if (bytes > fileCap) throw loggerError('LOG_RECORD_TOO_LARGE', 'log record exceeds file cap')
    await ensureDirectory(directory)
    let rotated = false
    const current = await stat(activePath).catch((error) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (current && current.size > 0 && current.size + bytes > fileCap) {
      const rotatedPath = join(
        directory,
        `tasks-recorder-${now.valueOf()}-${String(uuid()).replace(/[^a-zA-Z0-9_-]/g, '-')}.ndjson`,
      )
      await rename(activePath, rotatedPath)
      await chmod(rotatedPath, 0o600)
      rotated = true
    }
    const handle = await open(activePath, 'a', 0o600)
    try {
      await handle.writeFile(line, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await chmod(activePath, 0o600)
    await utimes(activePath, now, now)
    const pruned = await prune(now.valueOf())
    lastWrittenAt = now.toISOString()
    lastErrorCode = null
    return { written: true, path: activePath, rotated, pruned }
  }

  function write(event, fields = {}) {
    try {
      validateFields(event, fields)
    } catch (error) {
      return Promise.reject(error)
    }
    const operation = queue.then(() => writeNow(event, fields))
    queue = operation.catch((error) => {
      lastErrorCode = error.code ?? 'LOG_WRITE_FAILED'
    })
    return operation
  }

  async function status() {
    await queue
    const files = await logFiles(directory)
    return {
      files: files.length,
      bytes: files.reduce((total, file) => total + file.bytes, 0),
      last_written_at: lastWrittenAt,
      last_error_code: lastErrorCode,
    }
  }

  return { write, status }
}
