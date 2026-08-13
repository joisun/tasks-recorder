#!/usr/bin/env node

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveAppConfig } from '../mcp/src/config.mjs'
import { startTaskd } from './src/taskd-runtime.mjs'

const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const dashboardPath = join(projectRoot, 'ui', 'dist', 'index.html')

try {
  const config = await resolveAppConfig({ projectRoot })
  const dashboardHtml = await readFile(dashboardPath, 'utf8')
  const runtime = await startTaskd({ config, dashboardPath, dashboardHtml })
  let stopping = false
  async function stop() {
    if (stopping) return
    stopping = true
    await runtime.close()
  }
  process.once('SIGTERM', () => { stop().catch(() => {}).finally(() => process.exit(0)) })
  process.once('SIGINT', () => { stop().catch(() => {}).finally(() => process.exit(0)) })
  process.stderr.write(`tasks-recorder taskd listening at ${runtime.address.url}\n`)
} catch (error) {
  process.stderr.write(`tasks-recorder taskd failed to start: ${error.stack ?? error}\n`)
  process.exitCode = 1
}
