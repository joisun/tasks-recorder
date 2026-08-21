import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

import { TaskRecorderError } from './errors.mjs'

function positiveInteger(value, field, fallback) {
  const candidate = value ?? fallback
  const normalized = typeof candidate === 'string' && candidate.trim() !== ''
    ? Number(candidate)
    : candidate
  if (!Number.isSafeInteger(normalized) || normalized < 1) {
    throw new TaskRecorderError('CONFIG_INVALID', `${field} must be a positive safe integer.`)
  }
  return normalized
}

export async function resolveAppConfig({
  projectRoot,
  env = process.env,
  homeDirectory = homedir(),
}) {
  const normalizedProjectRoot = resolve(projectRoot)
  const dataDirectory = join(resolve(homeDirectory), '.config', 'tasks-recorder')
  const configPath = join(dataDirectory, 'config.json')
  let fileConfig

  try {
    const source = await readFile(configPath, 'utf8')
    fileConfig = JSON.parse(source)
  } catch (error) {
    throw new TaskRecorderError(
      'CONFIG_INVALID',
      `Unable to read a valid tasks-recorder config at ${configPath}.`,
      { cause: error.message },
    )
  }

  const configuredOutput = env.AGENT_TASKS_OUTPUT_DIR || fileConfig.output_dir
  if (typeof configuredOutput !== 'string' || configuredOutput.trim() === '') {
    throw new TaskRecorderError(
      'CONFIG_INVALID',
      'output_dir must be a non-empty string.',
    )
  }

  const outputDir = isAbsolute(configuredOutput)
    ? resolve(configuredOutput)
    : resolve(dataDirectory, configuredOutput)
  const configuredDatabase = env.AGENT_TASKS_DATABASE_PATH
  if (configuredDatabase !== undefined && (
    typeof configuredDatabase !== 'string' || configuredDatabase.trim() === ''
  )) {
    throw new TaskRecorderError('CONFIG_INVALID', 'AGENT_TASKS_DATABASE_PATH must be a non-empty string.')
  }
  const databasePath = configuredDatabase
    ? (isAbsolute(configuredDatabase) ? resolve(configuredDatabase) : resolve(dataDirectory, configuredDatabase))
    : join(dataDirectory, 'tasks.sqlite')
  const configuredSpool = env.AGENT_TASKS_SPOOL_DIR ?? fileConfig.spool_dir ?? 'spool'
  if (typeof configuredSpool !== 'string' || configuredSpool.trim() === '') {
    throw new TaskRecorderError('CONFIG_INVALID', 'spool_dir must be a non-empty string.')
  }
  const spoolDirectory = isAbsolute(configuredSpool)
    ? resolve(configuredSpool)
    : resolve(dataDirectory, configuredSpool)
  const spoolMaxBytes = positiveInteger(
    env.AGENT_TASKS_SPOOL_MAX_BYTES ?? fileConfig.spool_max_bytes,
    'spool_max_bytes',
    4 * 1024 * 1024,
  )
  const spoolMaxFiles = positiveInteger(
    env.AGENT_TASKS_SPOOL_MAX_FILES ?? fileConfig.spool_max_files,
    'spool_max_files',
    512,
  )
  const spoolMaxAgeMs = positiveInteger(
    env.AGENT_TASKS_SPOOL_MAX_AGE_MS ?? fileConfig.spool_max_age_ms,
    'spool_max_age_ms',
    7 * 24 * 60 * 60 * 1000,
  )
  const configuredLogs = env.AGENT_TASKS_LOGS_DIR ?? fileConfig.logs_dir ?? 'logs'
  if (typeof configuredLogs !== 'string' || configuredLogs.trim() === '') {
    throw new TaskRecorderError('CONFIG_INVALID', 'logs_dir must be a non-empty string.')
  }
  const logsDirectory = isAbsolute(configuredLogs)
    ? resolve(configuredLogs)
    : resolve(dataDirectory, configuredLogs)
  const logMaxFileBytes = positiveInteger(
    env.AGENT_TASKS_LOG_MAX_FILE_BYTES ?? fileConfig.log_max_file_bytes,
    'log_max_file_bytes',
    1024 * 1024,
  )
  const logMaxFiles = positiveInteger(
    env.AGENT_TASKS_LOG_MAX_FILES ?? fileConfig.log_max_files,
    'log_max_files',
    5,
  )
  const logMaxAgeMs = positiveInteger(
    env.AGENT_TASKS_LOG_MAX_AGE_MS ?? fileConfig.log_max_age_ms,
    'log_max_age_ms',
    14 * 24 * 60 * 60 * 1000,
  )

  const configuredHost = fileConfig.server_host ?? '127.0.0.1'
  const configuredPort = fileConfig.server_port ?? 43127
  if (configuredHost !== '127.0.0.1') {
    throw new TaskRecorderError('CONFIG_INVALID', 'server_host must be 127.0.0.1')
  }
  if (!Number.isInteger(configuredPort) || configuredPort < 1 || configuredPort > 65535) {
    throw new TaskRecorderError('CONFIG_INVALID', 'server_port must be an integer between 1 and 65535')
  }

  let serverUrl
  try {
    serverUrl = new URL(env.AGENT_TASKS_SERVER_URL ?? `http://${configuredHost}:${configuredPort}`)
  } catch (error) {
    throw new TaskRecorderError('CONFIG_INVALID', 'taskd URL is invalid', { cause: error.message })
  }
  if (
    serverUrl.protocol !== 'http:'
    || serverUrl.hostname !== '127.0.0.1'
    || serverUrl.username !== ''
    || serverUrl.password !== ''
    || !['', '/'].includes(serverUrl.pathname)
    || serverUrl.search !== ''
    || serverUrl.hash !== ''
  ) {
    throw new TaskRecorderError('CONFIG_INVALID', 'taskd URL must be an http://127.0.0.1 origin')
  }
  const serverPort = Number(serverUrl.port || 80)
  return {
    projectRoot: normalizedProjectRoot,
    dataDirectory,
    configPath,
    databasePath,
    outputDir,
    spoolDirectory,
    spoolMaxBytes,
    spoolMaxFiles,
    spoolMaxAgeMs,
    logsDirectory,
    logMaxFileBytes,
    logMaxFiles,
    logMaxAgeMs,
    serverHost: serverUrl.hostname,
    serverPort,
    serverBaseUrl: serverUrl.origin,
  }
}
