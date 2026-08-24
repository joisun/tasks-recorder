import { execFile as nodeExecFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { access, mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'

import { TaskRecorderError } from '../../mcp/src/errors.mjs'

const execFileAsync = promisify(nodeExecFile)

export const DEFAULT_RESUME_TERMINAL = 'terminal'

const TERMINALS = Object.freeze([
  {
    id: 'terminal',
    label: 'Terminal.app',
    description: 'macOS 系统终端，兼容性最佳',
  },
  {
    id: 'otty',
    label: 'Otty',
    description: '在新的 Otty window 中继续会话',
  },
  {
    id: 'ghostty',
    label: 'Ghostty',
    description: '在新的 Ghostty window 中继续会话',
  },
])

const APP_PATHS = Object.freeze({
  terminal: '/System/Applications/Utilities/Terminal.app',
  ghostty: '/Applications/Ghostty.app',
})

function taskError(code, message, details) {
  return new TaskRecorderError(code, message, details)
}

export function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`
}

function executableCandidates(name, { env, homeDirectory }) {
  const fromPath = String(env.PATH ?? '')
    .split(delimiter)
    .filter(Boolean)
    .map((directory) => join(directory, name))
  return [...new Set([
    ...fromPath,
    `/usr/local/bin/${name}`,
    `/opt/homebrew/bin/${name}`,
    join(homeDirectory, '.local', 'bin', name),
  ])]
}

async function firstExecutable(candidates, accessImpl) {
  for (const candidate of candidates) {
    try {
      await accessImpl(candidate, constants.X_OK)
      return candidate
    } catch {
      // Continue through the bounded allowlist.
    }
  }
  return null
}

function validateSessionId(sessionId) {
  if (
    typeof sessionId !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(sessionId)
  ) {
    throw taskError('SESSION_ID_INVALID', 'Session ID is not safe to resume.')
  }
  return sessionId
}

function normalizeWindowTitle(title) {
  if (typeof title !== 'string') return 'Codex Resume'
  const normalized = title.replace(/\s+/g, ' ').trim()
  return normalized === '' ? 'Codex Resume' : normalized.slice(0, 160)
}

function launcherScript({ scriptPath, codexPath, sessionId, workspace }) {
  return `#!/bin/zsh
rm -f -- ${shellQuote(scriptPath)}
cd -- ${shellQuote(workspace)}
exec ${shellQuote(codexPath)} resume ${shellQuote(sessionId)}
`
}

function resumeShellCommand({ codexPath, sessionId }) {
  return `${shellQuote(codexPath)} resume ${shellQuote(sessionId)}`
}

function parseOttyInventory(result, entity) {
  let payload
  try {
    payload = JSON.parse(String(result?.stdout ?? ''))
  } catch {
    throw new Error(`Otty returned invalid ${entity} inventory JSON`)
  }
  if (payload?.ok !== true || !Array.isArray(payload.data)) {
    throw new Error(`Otty returned an invalid ${entity} inventory`)
  }
  return payload.data.filter((item) => typeof item?.id === 'string' && item.id !== '')
}

function parseOttyWindows(result) {
  return parseOttyInventory(result, 'window')
}

function parseOttyPanes(result) {
  return parseOttyInventory(result, 'pane')
}

export function createTerminalLauncher({
  platform = process.platform,
  env = process.env,
  homeDirectory = homedir(),
  runtimeDirectory = join(homeDirectory, '.config', 'tasks-recorder', 'runtime'),
  accessImpl = access,
  statImpl = stat,
  mkdirImpl = mkdir,
  writeFileImpl = writeFile,
  rmImpl = rm,
  execFileImpl = execFileAsync,
  delayImpl = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  randomId = randomUUID,
  appPaths = APP_PATHS,
} = {}) {
  let ottyLaunchQueue = Promise.resolve()

  async function resolveExecutable(name) {
    return firstExecutable(executableCandidates(name, { env, homeDirectory }), accessImpl)
  }

  async function resolveAdapter(id) {
    if (id === 'otty') {
      const executable = await resolveExecutable('otty')
      return executable ? { executable } : null
    }
    const appPath = appPaths[id]
    if (!appPath) return null
    try {
      await accessImpl(appPath, constants.F_OK)
      return { appPath }
    } catch {
      return null
    }
  }

  async function options() {
    const resolved = await Promise.all(TERMINALS.map(async (terminal) => ({
      ...terminal,
      available: platform === 'darwin' && Boolean(await resolveAdapter(terminal.id)),
    })))
    return resolved
  }

  async function listOttyWindows(executable) {
    return parseOttyWindows(await execFileImpl(
      executable,
      ['window', 'list', '--json'],
      { timeout: 5_000 },
    ))
  }

  async function launchOtty({ executable, codexPath, sessionId, workspace, title }) {
    let existingWindows = []
    try {
      existingWindows = await listOttyWindows(executable)
    } catch {
      // `otty open` also starts Otty, so a missing control socket is valid on cold launch.
    }
    const existingIds = new Set(existingWindows.map(({ id }) => id))
    await execFileImpl(executable, [
      'open', workspace,
      '--title', title,
      '--json',
    ], { timeout: 5_000 })

    let resumedWindow = null
    for (let attempt = 0; attempt < 20; attempt += 1) {
      let candidates = []
      try {
        candidates = (await listOttyWindows(executable))
          .filter(({ id }) => !existingIds.has(id))
      } catch {
        // Otty's control socket can take a moment to become available on cold launch.
      }
      if (candidates.length === 1) {
        resumedWindow = candidates[0]
        break
      }
      if (candidates.length > 1) {
        throw new Error('More than one Otty window appeared during resume')
      }
      if (attempt < 19) await delayImpl(25)
    }
    if (!resumedWindow) throw new Error('Unable to resolve the resumed Otty window')

    const panes = parseOttyPanes(await execFileImpl(executable, [
      'pane', 'list', '--window', resumedWindow.id, '--json',
    ], { timeout: 5_000 }))
    if (panes.length !== 1) throw new Error('The resumed Otty window does not have one target pane')
    await execFileImpl(executable, [
      'pane', 'send-keys', '--pane', panes[0].id,
      resumeShellCommand({ codexPath, sessionId }),
      'key:Enter', '--json',
    ], { timeout: 5_000 })
    await execFileImpl(executable, [
      'window', 'rename', '--window', resumedWindow.id, title, '--json',
    ], { timeout: 5_000 })
    await execFileImpl(executable, [
      'window', 'focus', resumedWindow.id, '--json',
    ], { timeout: 5_000 })
    return { focused: true, window_title: title }
  }

  function enqueueOttyLaunch(operation) {
    const launch = ottyLaunchQueue.then(operation, operation)
    ottyLaunchQueue = launch.catch(() => undefined)
    return launch
  }

  async function launch({ terminal = DEFAULT_RESUME_TERMINAL, sessionId, workspace, title }) {
    if (platform !== 'darwin') {
      throw taskError('PLATFORM_UNSUPPORTED', 'Session resume currently requires macOS.')
    }
    const terminalDefinition = TERMINALS.find(({ id }) => id === terminal)
    if (!terminalDefinition) {
      throw taskError('TERMINAL_INVALID', 'Selected terminal is not supported.', { terminal })
    }
    const adapter = await resolveAdapter(terminal)
    if (!adapter) {
      throw taskError('TERMINAL_UNAVAILABLE', `${terminalDefinition.label} is not installed or available.`, {
        terminal,
      })
    }
    const normalizedSessionId = validateSessionId(sessionId)
    if (typeof workspace !== 'string' || !isAbsolute(workspace)) {
      throw taskError('WORKSPACE_INVALID', 'Session Workspace must be an absolute path.')
    }
    try {
      const workspaceStat = await statImpl(workspace)
      if (!workspaceStat.isDirectory()) throw new Error('not a directory')
    } catch {
      throw taskError('WORKSPACE_NOT_FOUND', 'Session Workspace no longer exists.', { workspace })
    }
    const codexPath = await resolveExecutable('codex')
    if (!codexPath) {
      throw taskError('CODEX_UNAVAILABLE', 'Codex CLI was not found in a supported executable path.')
    }

    let scriptPath = null
    let launchMetadata = {}
    try {
      if (terminal === 'otty') {
        launchMetadata = await enqueueOttyLaunch(() => launchOtty({
          executable: adapter.executable,
          codexPath,
          sessionId: normalizedSessionId,
          workspace,
          title: normalizeWindowTitle(title),
        }))
      } else {
        await mkdirImpl(runtimeDirectory, { recursive: true, mode: 0o700 })
        scriptPath = join(runtimeDirectory, `resume-${randomId()}.command`)
        await writeFileImpl(scriptPath, launcherScript({
          scriptPath,
          codexPath,
          sessionId: normalizedSessionId,
          workspace,
        }), { encoding: 'utf8', mode: 0o700 })
        if (terminal === 'ghostty') {
          await execFileImpl('/usr/bin/open', [
            '-na', adapter.appPath,
            '--args', `--working-directory=${workspace}`, '-e', scriptPath,
          ], { timeout: 5_000 })
        } else {
          await execFileImpl('/usr/bin/open', ['-na', adapter.appPath, scriptPath], { timeout: 5_000 })
        }
      }
    } catch (error) {
      if (scriptPath) await rmImpl(scriptPath, { force: true }).catch(() => undefined)
      throw taskError('TERMINAL_LAUNCH_FAILED', `Unable to launch ${terminalDefinition.label}.`, {
        terminal,
        cause: error?.code ?? error?.message ?? 'launch failed',
      })
    }

    return {
      terminal: terminalDefinition.id,
      terminal_label: terminalDefinition.label,
      session_id: normalizedSessionId,
      workspace,
      ...launchMetadata,
    }
  }

  return { launch, options }
}
