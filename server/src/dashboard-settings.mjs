import { chmod, readFile, rename, rm, writeFile } from 'node:fs/promises'

import { TaskRecorderError } from '../../mcp/src/errors.mjs'
import { DEFAULT_RESUME_TERMINAL } from './terminal-launcher.mjs'

function settingsError(code, message, details) {
  return new TaskRecorderError(code, message, details)
}

async function readConfig(configPath, readFileImpl) {
  try {
    const config = JSON.parse(await readFileImpl(configPath, 'utf8'))
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new TypeError('object required')
    return config
  } catch (error) {
    throw settingsError('CONFIG_INVALID', `Unable to read Tasks Recorder settings at ${configPath}.`, {
      cause: error.message,
    })
  }
}

export function createDashboardSettings({
  configPath,
  terminalLauncher,
  readFileImpl = readFile,
  writeFileImpl = writeFile,
  renameImpl = rename,
  chmodImpl = chmod,
  rmImpl = rm,
} = {}) {
  if (typeof configPath !== 'string' || configPath.trim() === '') {
    throw new TypeError('configPath is required')
  }
  if (!terminalLauncher?.options) throw new TypeError('terminalLauncher.options is required')
  let updateQueue = Promise.resolve()

  async function present(config) {
    const terminalOptions = await terminalLauncher.options()
    const configured = typeof config.resume_terminal === 'string'
      ? config.resume_terminal
      : DEFAULT_RESUME_TERMINAL
    const selected = terminalOptions.some(({ id }) => id === configured)
      ? configured
      : DEFAULT_RESUME_TERMINAL
    return {
      settings: { resume_terminal: selected },
      terminal_options: terminalOptions,
    }
  }

  async function get() {
    return present(await readConfig(configPath, readFileImpl))
  }

  async function persist(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw settingsError('SETTINGS_INVALID', 'Settings payload must be an object.')
    }
    const terminal = input.resume_terminal
    if (typeof terminal !== 'string' || terminal.trim() === '') {
      throw settingsError('TERMINAL_INVALID', 'resume_terminal must be a supported terminal ID.')
    }
    const terminalOptions = await terminalLauncher.options()
    const option = terminalOptions.find(({ id }) => id === terminal)
    if (!option) throw settingsError('TERMINAL_INVALID', 'Selected terminal is not supported.', { terminal })
    if (!option.available) {
      throw settingsError('TERMINAL_UNAVAILABLE', `${option.label} is not installed or available.`, {
        terminal,
      })
    }

    const config = await readConfig(configPath, readFileImpl)
    if (config.resume_terminal !== terminal) {
      const temporaryPath = `${configPath}.${process.pid}.tmp`
      try {
        await writeFileImpl(temporaryPath, `${JSON.stringify({
          ...config,
          resume_terminal: terminal,
        }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
        await renameImpl(temporaryPath, configPath)
        await chmodImpl(configPath, 0o600)
      } catch (error) {
        await rmImpl(temporaryPath, { force: true }).catch(() => undefined)
        throw settingsError('SETTINGS_WRITE_FAILED', 'Unable to save Tasks Recorder settings.', {
          cause: error.message,
        })
      }
    }
    return present({ ...config, resume_terminal: terminal })
  }

  function update(input) {
    const operation = updateQueue.then(() => persist(input))
    updateQueue = operation.catch(() => undefined)
    return operation
  }

  return { get, update }
}
