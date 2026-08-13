import { execFile as execFileCallback } from 'node:child_process'
import { realpath as fsRealpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, resolve } from 'node:path'
import { promisify } from 'node:util'

const execFilePromise = promisify(execFileCallback)

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
  const empty = { gitRoot: null, worktree: null, branch: null }
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

    return { gitRoot, worktree, branch }
  } catch {
    return empty
  }
}
