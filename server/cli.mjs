#!/usr/bin/env node

import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

import { resolveAppConfig } from '../mcp/src/config.mjs'
import {
  applyV2ToV3,
  inspectV2MigrationPath,
  migrationCliReport,
} from '../mcp/src/schema-migration.mjs'
import { createTaskClient } from '../mcp/src/task-client.mjs'
import { runControlCommand } from './control.mjs'
import { parseCodexImport } from './src/codex/importer.mjs'

const CONTROL_COMMANDS = new Set(['install', 'start', 'stop', 'status', 'uninstall'])

function optionValue(argv, index, option) {
  const value = argv[index + 1]
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${option} requires a value`)
  }
  return value
}

function usageError() {
  return new Error(
    'usage: tasks-recorder [install|start|stop|status|uninstall] | '
    + 'migrate (--dry-run | --apply --backup <path>) [--database <path>] | '
    + 'import codex --session <id> [--dry-run] [--codex-home <path>]',
  )
}

function parseMigration(argv) {
  let mode
  let databasePath
  let backupPath
  for (let index = 1; index < argv.length; index += 1) {
    const option = argv[index]
    if (option === '--dry-run' || option === '--apply') {
      const nextMode = option.slice(2)
      if (mode !== undefined) throw new Error('exactly one of --dry-run or --apply is required')
      mode = nextMode
      continue
    }
    if (option === '--database') {
      if (databasePath !== undefined) throw new Error('--database may only be provided once')
      databasePath = optionValue(argv, index, option)
      index += 1
      continue
    }
    if (option === '--backup') {
      if (backupPath !== undefined) throw new Error('--backup may only be provided once')
      backupPath = optionValue(argv, index, option)
      index += 1
      continue
    }
    throw new Error(`unknown option: ${option}`)
  }
  if (mode === undefined) throw new Error('exactly one of --dry-run or --apply is required')
  if (mode === 'dry-run' && backupPath !== undefined) {
    throw new Error('--backup is only valid with --apply')
  }
  if (mode === 'apply' && backupPath === undefined) {
    throw new Error('--backup is required with --apply')
  }
  return {
    type: 'migrate',
    mode,
    ...(databasePath === undefined ? {} : { database_path: databasePath }),
    ...(backupPath === undefined ? {} : { backup_path: backupPath }),
  }
}

async function defaultServiceProbe(baseUrl) {
  try {
    const response = await fetch(`${baseUrl}/health/live`, { signal: AbortSignal.timeout(500) })
    return response.ok
  } catch {
    return false
  }
}

async function defaultMigrationRunner({ mode, databasePath, backupPath }) {
  const report = mode === 'dry-run'
    ? inspectV2MigrationPath(databasePath)
    : await applyV2ToV3({ databasePath, backupPath })
  return migrationCliReport(report, { dryRun: mode === 'dry-run' })
}

export function parseCliArguments(argv) {
  if (!Array.isArray(argv)) throw new TypeError('argv must be an array')
  if (argv.length === 0) return { type: 'control', command: 'status' }
  if (CONTROL_COMMANDS.has(argv[0])) {
    if (argv.length !== 1) throw new Error(`${argv[0]} does not accept additional arguments`)
    return { type: 'control', command: argv[0] }
  }
  if (argv[0] === 'migrate') return parseMigration(argv)
  if (argv[0] !== 'import' || argv[1] !== 'codex') {
    throw usageError()
  }

  let sessionId
  let codexHome
  let dryRun = false
  for (let index = 2; index < argv.length; index += 1) {
    const option = argv[index]
    if (option === '--session') {
      if (sessionId !== undefined) throw new Error('--session may only be provided once')
      sessionId = optionValue(argv, index, option)
      index += 1
      continue
    }
    if (option === '--codex-home') {
      if (codexHome !== undefined) throw new Error('--codex-home may only be provided once')
      codexHome = optionValue(argv, index, option)
      index += 1
      continue
    }
    if (option === '--dry-run') {
      if (dryRun) throw new Error('--dry-run may only be provided once')
      dryRun = true
      continue
    }
    throw new Error(`unknown option: ${option}`)
  }
  if (sessionId === undefined) throw new Error('--session is required')
  return {
    type: 'import-codex',
    session_id: sessionId,
    dry_run: dryRun,
    ...(codexHome === undefined ? {} : { codex_home: codexHome }),
  }
}

export async function runCli(argv, {
  projectRoot = fileURLToPath(new URL('..', import.meta.url)),
  env = process.env,
  homeDirectory = homedir(),
  controlRunner = (command) => runControlCommand(command, {
    projectRoot, env, homeDirectory,
  }),
  parseImport = parseCodexImport,
  configResolver = resolveAppConfig,
  clientFactory = createTaskClient,
  serviceProbe = defaultServiceProbe,
  migrationRunner = defaultMigrationRunner,
} = {}) {
  const command = parseCliArguments(argv)
  if (command.type === 'control') return controlRunner(command.command)

  if (command.type === 'migrate') {
    const config = await configResolver({ projectRoot, env, homeDirectory })
    const databasePath = command.database_path ?? config.databasePath
    if (command.mode === 'apply' && await serviceProbe(config.serverBaseUrl)) {
      const error = new Error('stop tasks-recorder taskd before applying a database migration')
      error.code = 'TASKD_MUST_BE_STOPPED'
      throw error
    }
    return migrationRunner({
      mode: command.mode,
      databasePath,
      ...(command.backup_path === undefined ? {} : { backupPath: command.backup_path }),
    })
  }

  const parsed = await parseImport({
    sessionId: command.session_id,
    codexHome: command.codex_home,
  })
  const config = await configResolver({ projectRoot, env, homeDirectory })
  const client = clientFactory({ baseUrl: config.serverBaseUrl })
  return client.importExecutions({ ...parsed, dry_run: command.dry_run })
}

export async function runCliMain(argv = process.argv.slice(2), {
  stdout = process.stdout,
  stderr = process.stderr,
  ...dependencies
} = {}) {
  try {
    const result = await runCli(argv, dependencies)
    stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    return 0
  } catch (error) {
    stderr.write(`${error.message}\n`)
    return 1
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runCliMain()
}
