import { constants } from 'node:fs'
import { access, chmod, lstat, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'

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
  relocateDefinitionsDirectory = null,
  readFileImpl = readFile,
  writeFileImpl = writeFile,
  renameImpl = rename,
  chmodImpl = chmod,
  rmImpl = rm,
  lstatImpl = lstat,
  realpathImpl = realpath,
  accessImpl = access,
} = {}) {
  if (typeof configPath !== 'string' || configPath.trim() === '') {
    throw new TypeError('configPath is required')
  }
  if (!terminalLauncher?.options) throw new TypeError('terminalLauncher.options is required')
  let updateQueue = Promise.resolve()

  function configuredDefinitionsDirectory(config) {
    const value = config.schedule_definitions_dir ?? 'schedules'
    return isAbsolute(value) ? resolve(value) : resolve(dirname(configPath), value)
  }

  async function present(config, { relocation = null } = {}) {
    const terminalOptions = await terminalLauncher.options()
    const configured = typeof config.resume_terminal === 'string'
      ? config.resume_terminal
      : DEFAULT_RESUME_TERMINAL
    const selected = terminalOptions.some(({ id }) => id === configured)
      ? configured
      : DEFAULT_RESUME_TERMINAL
    return {
      settings: {
        resume_terminal: selected,
        schedule_definitions_dir: configuredDefinitionsDirectory(config),
      },
      terminal_options: terminalOptions,
      restart_required: false,
      ...(relocation ? { relocation } : {}),
    }
  }

  async function get() {
    return present(await readConfig(configPath, readFileImpl))
  }

  async function persist(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw settingsError('SETTINGS_INVALID', 'Settings payload must be an object.')
    }
    const allowed = new Set(['resume_terminal', 'schedule_definitions_dir'])
    for (const key of Object.keys(input)) {
      if (!allowed.has(key)) throw settingsError('SETTINGS_INVALID', `Unsupported settings field: ${key}.`)
    }
    if (Object.keys(input).length === 0) throw settingsError('SETTINGS_INVALID', 'Settings payload must not be empty.')
    const config = await readConfig(configPath, readFileImpl)
    const terminalOptions = await terminalLauncher.options()
    let terminal = config.resume_terminal ?? DEFAULT_RESUME_TERMINAL
    if (Object.hasOwn(input, 'resume_terminal')) {
      terminal = input.resume_terminal
      if (typeof terminal !== 'string' || terminal.trim() === '') {
        throw settingsError('TERMINAL_INVALID', 'resume_terminal must be a supported terminal ID.')
      }
      const option = terminalOptions.find(({ id }) => id === terminal)
      if (!option) throw settingsError('TERMINAL_INVALID', 'Selected terminal is not supported.', { terminal })
      if (!option.available) {
        throw settingsError('TERMINAL_UNAVAILABLE', `${option.label} is not installed or available.`, { terminal })
      }
    }
    let definitionsDir = configuredDefinitionsDirectory(config)
    if (Object.hasOwn(input, 'schedule_definitions_dir')) {
      const candidate = input.schedule_definitions_dir
      if (typeof candidate !== 'string' || candidate.trim() === '' || candidate.includes('\0') || /^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) {
        throw settingsError('SCHEDULE_DEFINITIONS_DIR_INVALID', 'Definitions directory must be a safe local path.')
      }
      definitionsDir = isAbsolute(candidate) ? resolve(candidate) : resolve(dirname(configPath), candidate)
      if (dirname(definitionsDir) === definitionsDir) throw settingsError('SCHEDULE_DEFINITIONS_DIR_INVALID', 'Definitions directory must not be a filesystem root.')
      let metadata
      try {
        metadata = await lstatImpl(definitionsDir)
        if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new TypeError('directory required')
        definitionsDir = await realpathImpl(definitionsDir)
        await accessImpl(definitionsDir, constants.R_OK | constants.W_OK)
      } catch (error) {
        throw settingsError('SCHEDULE_DEFINITIONS_DIR_UNAVAILABLE', 'Definitions directory must exist and be readable and writable.', { cause: error.message })
      }
    }

    const changedTerminal = config.resume_terminal !== terminal
    const changedDefinitions = configuredDefinitionsDirectory(config) !== definitionsDir
    const nextConfig = {
      ...config,
      resume_terminal: terminal,
      ...(changedDefinitions ? { schedule_definitions_dir: definitionsDir } : {}),
    }
    async function persistConfig() {
      const temporaryPath = `${configPath}.${process.pid}.tmp`
      try {
        await writeFileImpl(temporaryPath, `${JSON.stringify(nextConfig, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
        await chmodImpl(temporaryPath, 0o600)
        await renameImpl(temporaryPath, configPath)
      } catch (error) {
        await rmImpl(temporaryPath, { force: true }).catch(() => undefined)
        throw settingsError('SETTINGS_WRITE_FAILED', 'Unable to save Tasks Recorder settings.', {
          cause: error.message,
        })
      }
    }
    let relocation = null
    if (changedDefinitions) {
      if (typeof relocateDefinitionsDirectory !== 'function') {
        throw settingsError('SCHEDULE_RELOCATION_UNAVAILABLE', 'The running Scheduler cannot relocate its definitions directory.')
      }
      relocation = await relocateDefinitionsDirectory({ directory: definitionsDir, persist: persistConfig })
    } else if (changedTerminal) {
      await persistConfig()
    }
    return present(nextConfig, { relocation })
  }

  function update(input) {
    const operation = updateQueue.then(() => persist(input))
    updateQueue = operation.catch(() => undefined)
    return operation
  }

  return { get, update }
}
