import { execFile as execFileCallback } from 'node:child_process'
import { realpath as fsRealpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, resolve } from 'node:path'
import { promisify } from 'node:util'

const execFilePromise = promisify(execFileCallback)

export function normalizeGitRemote(value) {
  if (typeof value !== 'string' || value.trim() === '') return null
  const source = value.trim()
  const canonical = source.match(/^([a-zA-Z0-9.-]+(?::[0-9]+)?)\/(.+)$/)
  if (canonical) {
    const host = canonical[1].toLowerCase()
    const path = canonical[2].replace(/\/+$/, '').replace(/\.git$/i, '')
    return path ? `${host}/${path}` : null
  }
  const scp = source.match(/^(?:[^@/]+@)?([^:/]+):(.+)$/)
  if (scp && !source.includes('://')) {
    const host = scp[1].toLowerCase()
    const path = scp[2].replace(/\/+$/, '').replace(/\.git$/i, '')
    return path ? `${host}/${path}` : null
  }
  try {
    const remote = new URL(source)
    if (!['http:', 'https:', 'ssh:'].includes(remote.protocol)) return null
    remote.username = ''
    remote.password = ''
    remote.search = ''
    remote.hash = ''
    const path = remote.pathname.replace(/\/+$/, '').replace(/\.git$/i, '')
    if (!path || path === '/') return null
    const port = remote.port ? `:${remote.port}` : ''
    return `${remote.hostname.toLowerCase()}${port}${path}`
  } catch {
    return null
  }
}

async function defaultExecFile(command, args) {
  return execFilePromise(command, args, { encoding: 'utf8' })
}

function stdoutOf(result) {
  if (typeof result === 'string') return result
  return result?.stdout ?? ''
}

async function gitOutput(workfolder, args, execFile) {
  const result = await execFile('git', ['-C', workfolder, ...args])
  return stdoutOf(result).trim()
}

export async function discoverGitContext(
  workfolder,
  { execFile = defaultExecFile, realpath = fsRealpath } = {},
) {
  const empty = {
    gitRoot: null,
    gitCommonDir: null,
    gitRemote: null,
    worktree: null,
    branch: null,
  }
  if (typeof workfolder !== 'string' || workfolder.trim() === '') return empty

  try {
    const topLevelOutput = await gitOutput(workfolder, ['rev-parse', '--show-toplevel'], execFile)
    const commonDirectoryOutput = await gitOutput(
      workfolder,
      ['rev-parse', '--git-common-dir'],
      execFile,
    )
    if (!topLevelOutput || !commonDirectoryOutput) return empty

    const worktree = await realpath(topLevelOutput)
    const commonDirectoryPath = isAbsolute(commonDirectoryOutput)
      ? commonDirectoryOutput
      : resolve(workfolder, commonDirectoryOutput)
    const commonDirectory = await realpath(commonDirectoryPath)
    const gitRoot = basename(commonDirectory) === '.git'
      ? await realpath(dirname(commonDirectory))
      : worktree

    let branch = null
    try {
      const branchOutput = await gitOutput(workfolder, ['branch', '--show-current'], execFile)
      branch = branchOutput || null
    } catch {
      branch = null
    }

    let gitRemote = null
    try {
      const remoteOutput = await gitOutput(workfolder, ['remote', 'get-url', 'origin'], execFile)
      gitRemote = normalizeGitRemote(remoteOutput)
    } catch {
      gitRemote = null
    }

    return { gitRoot, gitCommonDir: commonDirectory, gitRemote, worktree, branch }
  } catch {
    return empty
  }
}
