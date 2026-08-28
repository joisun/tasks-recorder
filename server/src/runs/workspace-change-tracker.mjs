import { lstat, opendir } from 'node:fs/promises'
import { join, posix } from 'node:path'

const IGNORED_DIRECTORIES = new Set(['.git', 'node_modules'])
const MAX_FILES = 100_000
const MAX_FILE_CHANGES = 128
const MAX_PATH_BYTES = 2_048
const FILE_CHANGE_KINDS = new Set(['add', 'update', 'delete'])

export async function captureWorkspaceSnapshot(workspace) {
  const files = new Map()
  await visit(workspace, '')
  return files

  async function visit(directory, relativeDirectory) {
    const entries = await opendir(directory)
    for await (const entry of entries) {
      if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue
      const relativePath = relativeDirectory
        ? posix.join(relativeDirectory, entry.name)
        : entry.name
      const absolutePath = join(directory, entry.name)
      if (entry.isDirectory()) {
        await visit(absolutePath, relativePath)
        continue
      }
      if (!entry.isFile() && !entry.isSymbolicLink()) continue
      if (files.size >= MAX_FILES) {
        throw Object.assign(new Error('Workspace snapshot is too large'), {
          code: 'WORKSPACE_SNAPSHOT_TOO_LARGE',
        })
      }
      let metadata
      try {
        metadata = await lstat(absolutePath)
      } catch (error) {
        if (error?.code === 'ENOENT') continue
        throw error
      }
      files.set(relativePath, Object.freeze({
        size: metadata.size,
        mtime_ms: metadata.mtimeMs,
        ctime_ms: metadata.ctimeMs,
        mode: metadata.mode,
      }))
    }
  }
}

export function diffWorkspaceSnapshots(before, after) {
  if (!(before instanceof Map) || !(after instanceof Map)) return []
  const changes = []
  for (const [path, metadata] of after) {
    const previous = before.get(path)
    if (!previous) {
      changes.push({ path, kind: 'add' })
    } else if (!sameMetadata(previous, metadata)) {
      changes.push({ path, kind: 'update' })
    }
  }
  for (const path of before.keys()) {
    if (!after.has(path)) changes.push({ path, kind: 'delete' })
  }
  return changes.sort((left, right) => left.path.localeCompare(right.path))
}

export function mergeFileChanges(runtimeChanges, observedChanges) {
  const merged = new Map()
  for (const change of Array.isArray(runtimeChanges) ? runtimeChanges : []) {
    if (validFileChange(change)) merged.set(change.path, change)
  }
  for (const change of Array.isArray(observedChanges) ? observedChanges : []) {
    if (validFileChange(change)) merged.set(change.path, change)
  }
  return [...merged.values()]
    .sort((left, right) => left.path.localeCompare(right.path))
    .slice(0, MAX_FILE_CHANGES)
}

function sameMetadata(left, right) {
  return left.size === right.size
    && left.mtime_ms === right.mtime_ms
    && left.ctime_ms === right.ctime_ms
    && left.mode === right.mode
}

function validFileChange(change) {
  return typeof change?.path === 'string'
    && change.path.length > 0
    && !change.path.includes('\0')
    && Buffer.byteLength(change.path) <= MAX_PATH_BYTES
    && FILE_CHANGE_KINDS.has(change.kind)
}
