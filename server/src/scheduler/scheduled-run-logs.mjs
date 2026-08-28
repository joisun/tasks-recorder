import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, readdir, realpath, unlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const MAX_TAIL_BYTES = 64 * 1024

function fail(code, message) {
  const error = new Error(message)
  error.code = code
  throw error
}

function id(value) {
  if (typeof value !== 'string' || !UUID.test(value)) fail('SCHEDULE_LOG_QUERY_INVALID', 'run_id must be a UUID')
  return value.toLowerCase()
}

function sameDirectory(metadata, identity) {
  return !metadata.isSymbolicLink()
    && metadata.isDirectory()
    && metadata.uid === process.getuid()
    && (metadata.mode & 0o777) === 0o700
    && metadata.dev === identity.dev
    && metadata.ino === identity.ino
}

function sameFile(metadata, identity) {
  return !metadata.isSymbolicLink()
    && metadata.isFile()
    && metadata.uid === process.getuid()
    && (metadata.mode & 0o777) === 0o600
    && metadata.nlink === 1
    && metadata.dev === identity.dev
    && metadata.ino === identity.ino
}

async function openPrivateDirectory(path, code) {
  let before
  try {
    before = await lstat(path)
  } catch (error) {
    if (error?.code === 'ENOENT') fail('SCHEDULE_LOG_NOT_FOUND', 'Scheduled Run log is not available')
    fail(code, 'Scheduled Run log directory is unsafe')
  }
  const identity = { dev: before.dev, ino: before.ino }
  if (!sameDirectory(before, identity)) fail(code, 'Scheduled Run log directory is unsafe')
  let descriptor
  try {
    descriptor = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    const opened = await descriptor.stat()
    if (!sameDirectory(opened, identity)) fail(code, 'Scheduled Run log directory is unsafe')
    return Object.freeze({ path, identity })
  } catch (error) {
    if (error?.code === 'SCHEDULE_LOG_NOT_FOUND' || error?.code === code) throw error
    fail(code, 'Scheduled Run log directory is unsafe')
  } finally {
    await descriptor?.close().catch(() => {})
  }
}

async function openRoot(root) {
  if (typeof root !== 'string' || root.length < 1 || root.includes('\0')) fail('SCHEDULE_LOG_UNSAFE', 'Scheduled Run log root is unsafe')
  const requested = resolve(root)
  const safe = await openPrivateDirectory(requested, 'SCHEDULE_LOG_UNSAFE')
  let canonical
  try {
    canonical = await realpath(requested)
  } catch {
    fail('SCHEDULE_LOG_UNSAFE', 'Scheduled Run log root is unsafe')
  }
  const canonicalRoot = await openPrivateDirectory(canonical, 'SCHEDULE_LOG_UNSAFE')
  if (canonicalRoot.identity.dev !== safe.identity.dev || canonicalRoot.identity.ino !== safe.identity.ino) {
    fail('SCHEDULE_LOG_UNSAFE', 'Scheduled Run log root is unsafe')
  }
  return canonicalRoot
}

async function assertDirectory(directory, expected) {
  const current = await lstat(directory.path).catch(() => null)
  if (!current || !sameDirectory(current, directory.identity)) fail('SCHEDULE_LOG_UNSAFE', 'Scheduled Run log directory changed')
  if (expected) {
    const currentExpected = await lstat(expected.path).catch(() => null)
    if (!currentExpected || !sameDirectory(currentExpected, expected.identity)) fail('SCHEDULE_LOG_UNSAFE', 'Scheduled Run log directory changed')
  }
}

async function readTail(descriptor, bytes, tail) {
  const length = Math.min(bytes, tail)
  const output = Buffer.alloc(length)
  let offset = 0
  while (offset < length) {
    const { bytesRead } = await descriptor.read(output, offset, length - offset, bytes - length + offset)
    if (bytesRead === 0) break
    offset += bytesRead
  }
  return output.subarray(0, offset).toString('utf8')
}

export function createScheduledRunLogs({ store, root, maxTailBytes = MAX_TAIL_BYTES } = {}) {
  const getRun = typeof store?.get === 'function'
    ? (runId) => store.get(runId)
    : (typeof store?.runs?.get === 'function'
      ? (runId) => store.runs.get(runId)
      : null)
  if (!getRun) throw new TypeError('store.get or store.runs.get is required')
  if (!Number.isSafeInteger(maxTailBytes) || maxTailBytes < 1 || maxTailBytes > MAX_TAIL_BYTES) {
    throw new TypeError(`maxTailBytes must be a positive safe integer up to ${MAX_TAIL_BYTES}`)
  }

  async function read({ runId, stream, tail } = {}) {
    const normalizedRunId = id(runId)
    if (!['stdout', 'stderr'].includes(stream) || !Number.isSafeInteger(tail) || tail < 1 || tail > maxTailBytes) {
      fail('SCHEDULE_LOG_QUERY_INVALID', `stream and tail (1-${maxTailBytes}) are required`)
    }
    const run = getRun(normalizedRunId)
    const scheduleId = run?.schedule_id ?? run?.job_id
    if (run?.id !== normalizedRunId || !UUID.test(scheduleId)) fail('SCHEDULE_LOG_UNSAFE', 'Scheduled Run log path is unsafe')
    const jobId = scheduleId.toLowerCase()
    const suffix = stream === 'stdout' ? 'stdout.jsonl' : 'stderr.log'
    const expectedRelativePath = join(jobId, `${normalizedRunId}.${suffix}`)
    const registeredPath = stream === 'stdout' ? run.stdout_log_path : run.stderr_log_path
    if (registeredPath === null || registeredPath === undefined) fail('SCHEDULE_LOG_NOT_FOUND', 'Scheduled Run log is not available')
    if (typeof registeredPath !== 'string' || registeredPath !== expectedRelativePath) {
      fail('SCHEDULE_LOG_UNSAFE', 'Scheduled Run log path is unsafe')
    }

    const privateRoot = await openRoot(root)
    const jobDirectory = await openPrivateDirectory(join(privateRoot.path, jobId), 'SCHEDULE_LOG_UNSAFE')
    if (dirname(jobDirectory.path) !== privateRoot.path) fail('SCHEDULE_LOG_UNSAFE', 'Scheduled Run log path is unsafe')
    const path = join(privateRoot.path, registeredPath)
    if (dirname(path) !== jobDirectory.path) fail('SCHEDULE_LOG_UNSAFE', 'Scheduled Run log path is unsafe')

    let before
    try {
      before = await lstat(path)
    } catch (error) {
      if (error?.code === 'ENOENT') fail('SCHEDULE_LOG_NOT_FOUND', 'Scheduled Run log is not available')
      fail('SCHEDULE_LOG_UNSAFE', 'Scheduled Run log is unsafe')
    }
    const identity = { dev: before.dev, ino: before.ino }
    if (!sameFile(before, identity)) fail('SCHEDULE_LOG_UNSAFE', 'Scheduled Run log is unsafe')
    let descriptor
    try {
      descriptor = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
      const opened = await descriptor.stat()
      if (!sameFile(opened, identity)) fail('SCHEDULE_LOG_UNSAFE', 'Scheduled Run log changed')
      const content = await readTail(descriptor, opened.size, tail)
      await assertDirectory(privateRoot, jobDirectory)
      const after = await lstat(path)
      if (!sameFile(after, identity)) fail('SCHEDULE_LOG_UNSAFE', 'Scheduled Run log changed')
      return {
        run_id: normalizedRunId,
        stream,
        content,
        truncated: opened.size > tail,
      }
    } catch (error) {
      if (error?.code?.startsWith('SCHEDULE_LOG_')) throw error
      fail('SCHEDULE_LOG_UNSAFE', 'Scheduled Run log is unsafe')
    } finally {
      await descriptor?.close().catch(() => {})
    }
  }

  return { read }
}

export function createRunLogStore({
  root,
  maxFileBytes = 1024 * 1024,
  maxFiles = 64,
  maxAgeMs = 7 * 24 * 60 * 60 * 1_000,
} = {}) {
  if (typeof root !== 'string' || root.length < 1 || root.includes('\0')) {
    throw new TypeError('root is required')
  }
  if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes < 1
    || maxFileBytes > 16 * 1024 * 1024) {
    throw new TypeError('maxFileBytes is invalid')
  }
  if (!Number.isSafeInteger(maxFiles) || maxFiles < 2 || maxFiles > 10_000
    || !Number.isSafeInteger(maxAgeMs) || maxAgeMs < 1) {
    throw new TypeError('log retention options are invalid')
  }
  const requestedRoot = resolve(root)

  async function openRun({ scheduleId, runId } = {}) {
    const normalizedScheduleId = id(scheduleId)
    const normalizedRunId = id(runId)
    const privateRoot = await ensurePrivateDirectory(requestedRoot)
    const runDirectory = await ensurePrivateDirectory(
      join(privateRoot.path, normalizedScheduleId),
    )
    if (dirname(runDirectory.path) !== privateRoot.path) {
      fail('SCHEDULE_LOG_UNSAFE', 'Scheduled Run log directory is unsafe')
    }
    await pruneRunLogs(runDirectory.path, { maxFiles, maxAgeMs })

    const stdoutName = `${normalizedRunId}.stdout.jsonl`
    const stderrName = `${normalizedRunId}.stderr.log`
    const stdoutPath = join(runDirectory.path, stdoutName)
    const stderrPath = join(runDirectory.path, stderrName)
    const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
      | constants.O_NOFOLLOW
    const stdout = await open(stdoutPath, flags, 0o600)
    let stderr
    try {
      stderr = await open(stderrPath, flags, 0o600)
      await Promise.all([verifyWritableLog(stdout), verifyWritableLog(stderr)])
    } catch (error) {
      await stdout.close().catch(() => {})
      await stderr?.close().catch(() => {})
      await unlink(stdoutPath).catch(() => {})
      await unlink(stderrPath).catch(() => {})
      throw error
    }

    let stdoutReserved = 0
    let stderrReserved = 0
    let chain = Promise.resolve()
    let closed = false

    function append(descriptor, stream, chunk) {
      if (closed) return Promise.reject(fail('SCHEDULE_LOG_WRITE_FAILED', 'Run logs are closed'))
      const source = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      const reserved = stream === 'stdout' ? stdoutReserved : stderrReserved
      const accepted = Math.max(0, Math.min(source.byteLength, maxFileBytes - reserved))
      if (accepted === 0) return Promise.resolve({ dropped: true })
      const slice = source.subarray(0, accepted)
      if (stream === 'stdout') stdoutReserved += accepted
      else stderrReserved += accepted
      chain = chain.then(() => descriptor.write(slice))
      return chain.then(() => ({ dropped: accepted !== source.byteLength }))
    }

    return Object.freeze({
      stdout_log_path: join(normalizedScheduleId, stdoutName),
      stderr_log_path: join(normalizedScheduleId, stderrName),
      writeStdout: (chunk) => append(stdout, 'stdout', chunk),
      writeStderr: (chunk) => append(stderr, 'stderr', chunk),
      async close() {
        if (closed) return
        closed = true
        let failure = null
        try {
          await chain
          await Promise.all([stdout.sync(), stderr.sync()])
        } catch (error) {
          failure = error
        }
        for (const descriptor of [stdout, stderr]) {
          try { await descriptor.close() } catch (error) { failure ??= error }
        }
        if (failure) fail('SCHEDULE_LOG_WRITE_FAILED', 'Could not persist Run logs')
      },
    })
  }

  return Object.freeze({ root: requestedRoot, open: openRun })
}

async function ensurePrivateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 })
  await chmod(path, 0o700)
  return openPrivateDirectory(path, 'SCHEDULE_LOG_UNSAFE')
}

async function verifyWritableLog(descriptor) {
  await descriptor.chmod(0o600)
  const metadata = await descriptor.stat()
  if (!metadata.isFile() || metadata.uid !== process.getuid()
    || (metadata.mode & 0o777) !== 0o600 || metadata.nlink !== 1) {
    fail('SCHEDULE_LOG_UNSAFE', 'Scheduled Run log is unsafe')
  }
}

async function pruneRunLogs(directory, { maxFiles, maxAgeMs }) {
  const entries = []
  const now = Date.now()
  for (const name of await readdir(directory)) {
    if (!/^[0-9a-f-]{36}\.(?:stdout\.jsonl|stderr\.log)$/i.test(name)) continue
    const path = join(directory, name)
    const metadata = await lstat(path).catch(() => null)
    if (!metadata) continue
    const identity = { dev: metadata.dev, ino: metadata.ino }
    if (!sameFile(metadata, identity)) continue
    if (now - metadata.mtimeMs > maxAgeMs) {
      await unlink(path).catch(() => {})
      continue
    }
    entries.push({ path, mtimeMs: metadata.mtimeMs })
  }
  entries.sort((left, right) => left.mtimeMs - right.mtimeMs
    || left.path.localeCompare(right.path))
  while (entries.length + 2 > maxFiles) {
    await unlink(entries.shift().path).catch(() => {})
  }
}
