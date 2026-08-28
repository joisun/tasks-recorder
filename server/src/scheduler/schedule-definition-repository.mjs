import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import {
  chmod, lstat, mkdir, open, readdir, realpath, rename, rm, stat,
} from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'

import { definitionEtag, parseScheduleDefinition, serializeScheduleDefinition } from './schedule-definition-codec.mjs'
import { SchedulerError } from './scheduler-errors.mjs'

const MAX_DEFINITION_BYTES = 256 * 1024
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const PATCH_FIELDS = new Set([
  'title', 'prompt', 'workspace', 'agent', 'cadence', 'sandbox_mode', 'model', 'reasoning_effort', 'timeout_seconds',
])

function fail(code, message, details) {
  throw new SchedulerError(code, message, details)
}

function boundedMessage(error) {
  return String(error?.message ?? error ?? 'Invalid Schedule definition')
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .slice(0, 512)
}

function id(value) {
  if (typeof value !== 'string' || !UUID.test(value)) fail('SCHEDULE_ID_INVALID', 'Schedule id must be a UUID', { id: value })
  return value.toLowerCase()
}

function isWithin(root, path) {
  const value = relative(root, path)
  return value === '' || (!value.startsWith('..') && !isAbsolute(value))
}

function slug(value) {
  const normalized = String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 56)
  return normalized || 'schedule'
}

async function syncDirectory(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try { await handle.sync() } finally { await handle.close() }
}

async function safeRead(path) {
  const before = await lstat(path)
  if (before.isSymbolicLink() || !before.isFile()) fail('SCHEDULE_DEFINITION_UNSAFE_FILE', 'Schedule definition must be a regular file', { source_path: path })
  if (before.size > MAX_DEFINITION_BYTES) fail('SCHEDULE_DEFINITION_TOO_LARGE', 'Schedule definition exceeds 256 KiB', { source_path: path })
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      fail('SCHEDULE_DEFINITION_UNSAFE_FILE', 'Schedule definition changed during open', { source_path: path })
    }
    const source = await handle.readFile('utf8')
    const after = await handle.stat()
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) {
      fail('SCHEDULE_DEFINITION_UNSTABLE', 'Schedule definition changed while reading', { source_path: path })
    }
    return { source, metadata: after }
  } finally { await handle.close() }
}

async function atomicWrite(path, source, { expectedEtag = null, create = false } = {}) {
  const directory = dirname(path)
  const temporary = join(directory, `.${basename(path)}.${randomUUID()}.tmp`)
  let handle
  try {
    if (create) {
      try { await lstat(path); fail('SCHEDULE_DEFINITION_PATH_CONFLICT', 'Schedule definition path already exists', { source_path: path }) } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
    } else {
      const current = await safeRead(path)
      if (definitionEtag(current.source) !== expectedEtag) {
        fail('SCHEDULE_VERSION_CONFLICT', 'Schedule definition changed on disk', { source_path: path })
      }
    }
    handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
    await handle.writeFile(source, 'utf8')
    await handle.sync()
    await handle.close()
    handle = null
    if (!create) {
      const current = await safeRead(path)
      if (definitionEtag(current.source) !== expectedEtag) {
        fail('SCHEDULE_VERSION_CONFLICT', 'Schedule definition changed before commit', { source_path: path })
      }
    }
    await rename(temporary, path)
    await chmod(path, 0o600)
    await syncDirectory(directory)
  } catch (error) {
    await handle?.close().catch(() => {})
    await rm(temporary, { force: true }).catch(() => {})
    throw error
  }
}

export function createScheduleDefinitionRepository({
  rootDirectory,
  clock = () => new Date(),
  hardenRoot = false,
} = {}) {
  if (typeof rootDirectory !== 'string' || !isAbsolute(rootDirectory) || rootDirectory.includes('\0')) {
    throw new TypeError('rootDirectory must be an absolute local path')
  }
  const requestedRoot = resolve(rootDirectory)
  let root = requestedRoot
  let initialized = false
  let jobs = new Map()
  let invalid = []

  async function initialize() {
    if (initialized) return
    await mkdir(requestedRoot, { recursive: true, mode: 0o700 })
    const metadata = await lstat(requestedRoot)
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) fail('SCHEDULE_DEFINITIONS_ROOT_UNSAFE', 'Definitions root must be a real directory')
    root = await realpath(requestedRoot)
    if (hardenRoot) await chmod(root, 0o700)
    initialized = true
  }

  async function files(directory, output = []) {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const path = join(directory, entry.name)
      if (!isWithin(root, path)) continue
      if (entry.isDirectory()) await files(path, output)
      else if (extname(entry.name).toLowerCase() === '.md') output.push({ path, unsafe: entry.isSymbolicLink() || !entry.isFile() })
    }
    return output
  }

  async function scan() {
    await initialize()
    const found = new Map()
    const errors = []
    for (const candidate of await files(root)) {
      try {
        if (candidate.unsafe) fail('SCHEDULE_DEFINITION_UNSAFE_FILE', 'Schedule definition must not be a symlink', { source_path: candidate.path })
        const { source, metadata } = await safeRead(candidate.path)
        const definition = parseScheduleDefinition(source, { sourcePath: candidate.path, clock })
        if (definition === null) continue
        definition.updated_at = metadata.mtime.toISOString()
        const group = found.get(definition.id) ?? []
        group.push(definition)
        found.set(definition.id, group)
      } catch (error) {
        errors.push({
          source_path: candidate.path,
          error_code: typeof error?.code === 'string' ? error.code : 'SCHEDULE_DEFINITION_INVALID',
          message: boundedMessage(error),
        })
      }
    }
    const next = new Map()
    for (const [scheduleId, definitions] of found) {
      if (definitions.length === 1) {
        next.set(scheduleId, definitions[0])
        continue
      }
      for (const definition of definitions) {
        errors.push({
          source_path: definition.source_path,
          error_code: 'SCHEDULE_DEFINITION_DUPLICATE_ID',
          message: `Duplicate Schedule id: ${scheduleId}`,
        })
      }
    }
    jobs = next
    invalid = errors.sort((left, right) => left.source_path.localeCompare(right.source_path))
    return { jobs: [...jobs.values()], invalid: [...invalid] }
  }

  async function ensureScanned() {
    if (!initialized) await scan()
  }

  async function current(value) {
    await ensureScanned()
    const scheduleId = id(value)
    const definition = jobs.get(scheduleId)
    if (!definition) fail('SCHEDULE_NOT_FOUND', `Schedule ${scheduleId} does not exist`, { id: scheduleId })
    const { source, metadata } = await safeRead(definition.source_path)
    const parsed = parseScheduleDefinition(source, { sourcePath: definition.source_path, clock })
    if (!parsed || parsed.id !== scheduleId) fail('SCHEDULE_VERSION_CONFLICT', 'Schedule definition identity changed on disk', { id: scheduleId })
    parsed.updated_at = metadata.mtime.toISOString()
    return parsed
  }

  async function create(input) {
    await initialize()
    await ensureScanned()
    const scheduleId = input?.id === undefined ? randomUUID() : id(input.id)
    if (jobs.has(scheduleId)) fail('SCHEDULE_ID_CONFLICT', `Schedule ${scheduleId} already exists`, { id: scheduleId })
    const value = { ...input, id: scheduleId, enabled: input?.enabled ?? true }
    const source = serializeScheduleDefinition(value, { clock })
    const fileName = `${slug(value.title)}--${scheduleId.slice(0, 8)}.md`
    const path = join(root, fileName)
    await atomicWrite(path, source, { create: true })
    const metadata = await stat(path)
    const definition = parseScheduleDefinition(source, { sourcePath: path, clock })
    definition.updated_at = metadata.mtime.toISOString()
    jobs.set(scheduleId, definition)
    return { ...definition }
  }

  async function update(value, expectedEtag, patch) {
    const existing = await current(value)
    if (typeof expectedEtag !== 'string' || expectedEtag !== existing.etag) {
      fail('SCHEDULE_VERSION_CONFLICT', 'Schedule etag does not match', { id: existing.id })
    }
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) fail('SCHEDULE_INPUT_INVALID', 'Schedule patch must be an object')
    for (const key of Object.keys(patch)) {
      if (!PATCH_FIELDS.has(key)) fail('SCHEDULE_INPUT_INVALID', `unsupported Schedule patch field: ${key}`, { field: key })
    }
    const source = serializeScheduleDefinition({ ...existing, ...patch }, { clock })
    await atomicWrite(existing.source_path, source, { expectedEtag })
    const metadata = await stat(existing.source_path)
    const definition = parseScheduleDefinition(source, { sourcePath: existing.source_path, clock })
    definition.updated_at = metadata.mtime.toISOString()
    jobs.set(existing.id, definition)
    return { ...definition }
  }

  async function setEnabled(value, expectedEtag, enabled) {
    if (typeof enabled !== 'boolean') fail('SCHEDULE_INPUT_INVALID', 'enabled must be boolean', { field: 'enabled' })
    const existing = await current(value)
    if (typeof expectedEtag !== 'string' || expectedEtag !== existing.etag) {
      fail('SCHEDULE_VERSION_CONFLICT', 'Schedule etag does not match', { id: existing.id })
    }
    const source = serializeScheduleDefinition({ ...existing, enabled }, { clock })
    await atomicWrite(existing.source_path, source, { expectedEtag })
    const metadata = await stat(existing.source_path)
    const definition = parseScheduleDefinition(source, { sourcePath: existing.source_path, clock })
    definition.updated_at = metadata.mtime.toISOString()
    jobs.set(existing.id, definition)
    return { ...definition }
  }

  async function remove(value, expectedEtag) {
    const existing = await current(value)
    if (typeof expectedEtag !== 'string' || expectedEtag !== existing.etag) {
      fail('SCHEDULE_VERSION_CONFLICT', 'Schedule etag does not match', { id: existing.id })
    }
    const latest = await safeRead(existing.source_path)
    if (definitionEtag(latest.source) !== expectedEtag) fail('SCHEDULE_VERSION_CONFLICT', 'Schedule definition changed before delete', { id: existing.id })
    const trash = join(root, '.trash')
    await mkdir(trash, { recursive: true, mode: 0o700 })
    const stamp = clock().toISOString().replace(/[:.]/g, '-')
    const trashedPath = join(trash, `${basename(existing.source_path, '.md')}.${stamp}.md`)
    await rename(existing.source_path, trashedPath)
    await syncDirectory(dirname(existing.source_path))
    await syncDirectory(trash)
    jobs.delete(existing.id)
    return { id: existing.id, source_path: existing.source_path, trashed_path: trashedPath }
  }

  return {
    get rootDirectory() { return root },
    scan,
    async list() { await ensureScanned(); return [...jobs.values()].map((job) => ({ ...job })) },
    async invalid() { await ensureScanned(); return invalid.map((item) => ({ ...item })) },
    get: current,
    create,
    update,
    setEnabled,
    remove,
  }
}
