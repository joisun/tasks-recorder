#!/usr/bin/env node

import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

import { resolveAppConfig } from '../mcp/src/config.mjs'
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

export function parseCliArguments(argv) {
  if (!Array.isArray(argv)) throw new TypeError('argv must be an array')
  if (argv.length === 0) return { type: 'control', command: 'status' }
  if (CONTROL_COMMANDS.has(argv[0])) {
    if (argv.length !== 1) throw new Error(`${argv[0]} does not accept additional arguments`)
    return { type: 'control', command: argv[0] }
  }
  if (argv[0] !== 'import' || argv[1] !== 'codex') {
    throw new Error(
      'usage: tasks-recorder [install|start|stop|status|uninstall] | '
      + 'import codex --session <id> [--dry-run] [--codex-home <path>]',
    )
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
} = {}) {
  const command = parseCliArguments(argv)
  if (command.type === 'control') return controlRunner(command.command)

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
