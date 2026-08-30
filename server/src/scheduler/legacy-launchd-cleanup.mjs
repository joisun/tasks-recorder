import { constants } from 'node:fs'
import { lstat, open, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'

const LABEL_PREFIX = 'com.joi.tasks-recorder.schedule.'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const MAX_PLIST_BYTES = 64 * 1024

export async function cleanupLegacyScheduleLaunchAgents({
  homeDirectory,
  uid,
  currentUid = process.getuid(),
  commandRunner,
} = {}) {
  if (typeof homeDirectory !== 'string' || homeDirectory.length === 0
    || !Number.isSafeInteger(uid) || uid < 0
    || !Number.isSafeInteger(currentUid) || currentUid < 0
    || typeof commandRunner !== 'function') {
    throw new TypeError('legacy LaunchAgent cleanup dependencies are invalid')
  }
  const directory = join(homeDirectory, 'Library', 'LaunchAgents')
  let names
  try {
    names = await readdir(directory)
  } catch (error) {
    if (error?.code === 'ENOENT') return { removed: [], skipped: [] }
    throw error
  }

  const removed = []
  const skipped = []
  for (const name of names.sort()) {
    if (!name.startsWith(LABEL_PREFIX) || !name.endsWith('.plist')) continue
    const label = name.slice(0, -'.plist'.length)
    const jobId = label.slice(LABEL_PREFIX.length).toLowerCase()
    if (!UUID.test(jobId)) {
      skipped.push({ label, error_code: 'LEGACY_LAUNCHD_ID_INVALID' })
      continue
    }
    const path = join(directory, name)
    try {
      const source = await readPrivatePlist(path, currentUid)
      if (!isLegacySchedulePlist(source, { label, jobId })) {
        throw cleanupError('LEGACY_LAUNCHD_PLIST_NOT_OWNED')
      }
      const target = `gui/${uid}/${label}`
      const loaded = await commandRunner('launchctl', ['print', target], { allowFailure: true })
      if (loaded?.code === 0) {
        const result = await commandRunner(
          'launchctl',
          ['bootout', `gui/${uid}`, path],
          { allowFailure: true },
        )
        if (result?.code !== 0) throw cleanupError('LEGACY_LAUNCHD_BOOTOUT_FAILED')
      } else if (!notLoaded(loaded)) {
        throw cleanupError('LEGACY_LAUNCHD_STATUS_FAILED')
      }
      await rm(path, { force: false })
      removed.push({ job_id: jobId, label })
    } catch (error) {
      skipped.push({
        label,
        error_code: safeErrorCode(error),
      })
    }
  }
  return { removed, skipped }
}

async function readPrivatePlist(path, currentUid) {
  const before = await lstat(path).catch(() => null)
  if (!before || before.isSymbolicLink() || !before.isFile()
    || before.uid !== currentUid || (before.mode & 0o777) !== 0o600
    || before.nlink !== 1 || before.size > MAX_PLIST_BYTES) {
    throw cleanupError('LEGACY_LAUNCHD_PLIST_UNSAFE')
  }
  let descriptor
  try {
    descriptor = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const opened = await descriptor.stat()
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino
      || opened.uid !== currentUid || (opened.mode & 0o777) !== 0o600
      || opened.nlink !== 1 || opened.size > MAX_PLIST_BYTES) {
      throw cleanupError('LEGACY_LAUNCHD_PLIST_UNSAFE')
    }
    return await descriptor.readFile('utf8')
  } catch (error) {
    if (error?.code?.startsWith('LEGACY_LAUNCHD_')) throw error
    throw cleanupError('LEGACY_LAUNCHD_PLIST_UNSAFE')
  } finally {
    await descriptor?.close().catch(() => {})
  }
}

function isLegacySchedulePlist(source, { label, jobId }) {
  if (typeof source !== 'string' || Buffer.byteLength(source) > MAX_PLIST_BYTES) return false
  return plistPair(source, 'Label', label)
    && /<key>\s*ProgramArguments\s*<\/key>/.test(source)
    && /<string>[^<]*\/server\/scheduled-runner\.mjs<\/string>/.test(source)
    && new RegExp(`<string>\\s*${escapeRegExp(jobId)}\\s*<\\/string>`).test(source)
}

function plistPair(source, key, value) {
  return new RegExp(
    `<key>\\s*${escapeRegExp(key)}\\s*<\\/key>\\s*<string>\\s*${escapeRegExp(value)}\\s*<\\/string>`,
  ).test(source)
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function notLoaded(result) {
  return /could not find service|no such process|service\s+.*\s+not found/i.test(
    `${result?.stdout ?? ''}\n${result?.stderr ?? ''}`,
  )
}

function cleanupError(code) {
  return Object.assign(new Error(code), { code })
}

function safeErrorCode(error) {
  return typeof error?.code === 'string' && /^LEGACY_LAUNCHD_[A-Z0-9_]+$/.test(error.code)
    ? error.code
    : 'LEGACY_LAUNCHD_CLEANUP_FAILED'
}
