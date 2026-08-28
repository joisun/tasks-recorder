import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import {
  access, chmod, lstat, mkdir, open, realpath, rename, rm, rmdir,
} from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import { definitionEtag } from './schedule-definition-codec.mjs'
import { createScheduleDefinitionRepository } from './schedule-definition-repository.mjs'
import { SchedulerError } from './scheduler-errors.mjs'

function fail(code, message, details) {
  throw new SchedulerError(code, message, details)
}

function isWithin(root, path) {
  const value = relative(root, path)
  return value === '' || (!value.startsWith('..') && !isAbsolute(value))
}

function rootsOverlap(left, right) {
  return isWithin(left, right) || isWithin(right, left)
}

async function syncDirectory(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try { await handle.sync() } finally { await handle.close() }
}

async function safeDefinitionSource(definition) {
  const before = await lstat(definition.source_path)
  if (before.isSymbolicLink() || !before.isFile()) {
    fail('SCHEDULE_RELOCATION_SOURCE_CHANGED', 'A source Schedule definition is no longer a regular file.', {
      source_path: definition.source_path,
    })
  }
  const handle = await open(definition.source_path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      fail('SCHEDULE_RELOCATION_SOURCE_CHANGED', 'A source Schedule definition changed while being opened.', {
        source_path: definition.source_path,
      })
    }
    const source = await handle.readFile('utf8')
    if (definitionEtag(source) !== definition.etag) {
      fail('SCHEDULE_RELOCATION_SOURCE_CHANGED', 'A source Schedule definition changed during relocation.', {
        source_path: definition.source_path,
      })
    }
    return source
  } finally {
    await handle.close()
  }
}

async function prepareTargetRoot(path) {
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) {
    fail('SCHEDULE_RELOCATION_TARGET_INVALID', 'The target definitions directory must be an absolute local path.')
  }
  const requested = resolve(path)
  let metadata
  try {
    metadata = await lstat(requested)
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new TypeError('directory required')
    await access(requested, constants.R_OK | constants.W_OK)
  } catch (error) {
    fail('SCHEDULE_RELOCATION_TARGET_UNAVAILABLE', 'The target definitions directory must exist and be readable and writable.', {
      cause: error.message,
    })
  }
  return realpath(requested)
}

async function ensureSafeDirectory(root, directory, createdDirectories) {
  const value = relative(root, directory)
  if (value.startsWith('..') || isAbsolute(value)) {
    fail('SCHEDULE_RELOCATION_PATH_UNSAFE', 'A Schedule definition path escapes the target directory.')
  }
  let current = root
  for (const segment of value.split(sep).filter(Boolean)) {
    current = join(current, segment)
    try {
      const metadata = await lstat(current)
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        fail('SCHEDULE_RELOCATION_PATH_UNSAFE', 'A target directory segment is not a real directory.', { path: current })
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      await mkdir(current, { mode: 0o700 })
      createdDirectories.push(current)
    }
  }
}

async function writeStagedFile(path, source) {
  const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
  try {
    await handle.writeFile(source, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function removeOwnedPublication(item) {
  try {
    const handle = await open(item.path, constants.O_RDONLY | constants.O_NOFOLLOW)
    let source
    try { source = await handle.readFile('utf8') } finally { await handle.close() }
    if (definitionEtag(source) !== item.etag) return false
    await rm(item.path)
    await syncDirectory(dirname(item.path))
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return true
    return false
  }
}

function invalidDetails(root, invalid) {
  return invalid.map(({ source_path: path, error_code: code }) => ({
    path: relative(root, path),
    error_code: code,
  }))
}

function relocationTimestamp(clock) {
  const value = clock()
  const date = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(date.getTime())) fail('CLOCK_INVALID', 'clock must return a valid date')
  return date.toISOString().replace(/[:.]/g, '-')
}

const REPOSITORY_METHODS = ['scan', 'list', 'invalid', 'get', 'create', 'update', 'setEnabled', 'remove']

function assertRepository(repository) {
  if (!repository || typeof repository.rootDirectory !== 'string' || typeof repository.list !== 'function') {
    throw new TypeError('definition repository is required')
  }
}

export function createSwitchableScheduleDefinitionRepository(initialRepository) {
  assertRepository(initialRepository)
  let active = initialRepository
  const registry = {
    get rootDirectory() { return active.rootDirectory },
    current() { return active },
    replace(repository) {
      assertRepository(repository)
      const previous = active
      active = repository
      return previous
    },
  }
  for (const method of REPOSITORY_METHODS) {
    registry[method] = (...args) => {
      if (typeof active[method] !== 'function') throw new TypeError(`active definition repository.${method} is unavailable`)
      return active[method](...args)
    }
  }
  return registry
}

export function createDeferredDefinitionDiffHandler({ live } = {}) {
  if (typeof live !== 'function') throw new TypeError('live definition diff handler is required')
  let state = 'buffering'
  const pending = []
  async function handle(diff) {
    if (state !== 'live') {
      pending.push(diff)
      return
    }
    return live(diff)
  }
  async function activate(applyBuffered) {
    if (typeof applyBuffered !== 'function') throw new TypeError('buffered definition diff handler is required')
    if (state === 'live') return
    state = 'draining'
    while (pending.length > 0) await applyBuffered(pending.shift())
    state = 'live'
  }
  return { handle, activate }
}

export async function stageScheduleDefinitionRelocation({
  sourceRepository,
  targetDirectory,
  createRepository = createScheduleDefinitionRepository,
  clock = () => new Date(),
} = {}) {
  if (!sourceRepository?.scan || typeof sourceRepository.rootDirectory !== 'string') {
    throw new TypeError('sourceRepository is required')
  }
  const sourceScan = await sourceRepository.scan()
  const sourceRoot = await realpath(sourceRepository.rootDirectory)
  if (sourceScan.invalid.length > 0) {
    fail('SCHEDULE_RELOCATION_SOURCE_INVALID', 'Fix invalid source Schedule definitions before moving the library.', {
      invalid: invalidDetails(sourceRoot, sourceScan.invalid),
    })
  }
  const targetRoot = await prepareTargetRoot(targetDirectory)
  if (sourceRoot === targetRoot) {
    return {
      candidateRepository: sourceRepository,
      movedCount: 0,
      mergedCount: sourceScan.jobs.length,
      async verifySource() {},
      async commit() { return { cleanupWarning: null } },
      async rollback() { return { cleanupWarning: null } },
    }
  }
  if (rootsOverlap(sourceRoot, targetRoot)) {
    fail('SCHEDULE_RELOCATION_ROOTS_OVERLAP', 'Source and target definitions directories must not contain one another.')
  }

  const targetRepository = createRepository({ rootDirectory: targetRoot, clock })
  const targetScan = await targetRepository.scan()
  if (targetScan.invalid.length > 0) {
    fail('SCHEDULE_RELOCATION_TARGET_INVALID', 'Fix invalid target Schedule definitions before moving the library.', {
      invalid: invalidDetails(targetRoot, targetScan.invalid),
    })
  }
  const targetById = new Map(targetScan.jobs.map((job) => [job.id, job]))
  for (const definition of sourceScan.jobs) {
    const existing = targetById.get(definition.id)
    if (existing && existing.etag !== definition.etag) {
      fail('SCHEDULE_RELOCATION_ID_CONFLICT', `Schedule ${definition.id} differs between the source and target directories.`, {
        id: definition.id,
      })
    }
  }

  const stagingRoot = join(targetRoot, `.tasks-recorder-relocation-${randomUUID()}`)
  const createdDirectories = []
  const published = []
  const sources = []
  await mkdir(stagingRoot, { mode: 0o700 })
  try {
    for (const definition of sourceScan.jobs) {
      const source = await safeDefinitionSource(definition)
      const relativePath = relative(sourceRoot, definition.source_path)
      if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
        fail('SCHEDULE_RELOCATION_PATH_UNSAFE', 'A source Schedule definition escapes the source directory.')
      }
      sources.push({ definition, relativePath })
      if (targetById.has(definition.id)) continue
      const destination = join(targetRoot, relativePath)
      try {
        await lstat(destination)
        fail('SCHEDULE_RELOCATION_PATH_CONFLICT', 'A target path already exists and will not be overwritten.', {
          path: destination,
        })
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
      const staged = join(stagingRoot, relativePath)
      await ensureSafeDirectory(stagingRoot, dirname(staged), createdDirectories)
      await writeStagedFile(staged, source)
      await ensureSafeDirectory(targetRoot, dirname(destination), createdDirectories)
      try {
        await lstat(destination)
        fail('SCHEDULE_RELOCATION_PATH_CONFLICT', 'A target path appeared during relocation and will not be overwritten.', {
          path: destination,
        })
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
      await rename(staged, destination)
      await chmod(destination, 0o600)
      await syncDirectory(dirname(destination))
      published.push({ path: destination, etag: definition.etag })
    }

    const candidateScan = await targetRepository.scan()
    const expected = new Map(targetScan.jobs.map((job) => [job.id, job.etag]))
    for (const definition of sourceScan.jobs) expected.set(definition.id, definition.etag)
    const actual = new Map(candidateScan.jobs.map((job) => [job.id, job.etag]))
    const registryMatches = candidateScan.invalid.length === 0
      && actual.size === expected.size
      && [...expected].every(([id, etag]) => actual.get(id) === etag)
    if (!registryMatches) {
      fail('SCHEDULE_RELOCATION_VERIFICATION_FAILED', 'The target Schedule registry did not match the expected merged library.')
    }
    await rm(stagingRoot, { recursive: true, force: true })
  } catch (error) {
    for (const item of published.reverse()) await removeOwnedPublication(item)
    await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined)
    for (const directory of createdDirectories.reverse()) await rmdir(directory).catch(() => undefined)
    throw error
  }

  let finished = false
  async function verifySource() {
    for (const item of sources) await safeDefinitionSource(item.definition)
  }
  async function rollback() {
    if (finished) return { cleanupWarning: null }
    const warnings = []
    for (const item of [...published].reverse()) {
      if (!await removeOwnedPublication(item)) warnings.push(`${item.path}: published definition changed`)
    }
    for (const directory of createdDirectories.reverse()) await rmdir(directory).catch(() => undefined)
    finished = true
    return { cleanupWarning: warnings.length === 0 ? null : warnings.join('; ') }
  }
  async function commit() {
    if (finished) return { cleanupWarning: null }
    const archiveRoot = join(sourceRoot, '.trash', `migrated-${relocationTimestamp(clock)}`)
    const warnings = []
    for (const item of sources) {
      try {
        await safeDefinitionSource(item.definition)
        const destination = join(archiveRoot, item.relativePath)
        await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
        await rename(item.definition.source_path, destination)
        await syncDirectory(dirname(item.definition.source_path))
        await syncDirectory(dirname(destination))
      } catch (error) {
        warnings.push(`${item.definition.source_path}: ${error.message}`)
      }
    }
    finished = true
    return { cleanupWarning: warnings.length === 0 ? null : warnings.join('; ') }
  }

  return {
    candidateRepository: targetRepository,
    movedCount: sourceScan.jobs.length,
    mergedCount: targetScan.jobs.length,
    verifySource,
    commit,
    rollback,
  }
}
