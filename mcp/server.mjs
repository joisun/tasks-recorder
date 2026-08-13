#!/usr/bin/env node

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { fileURLToPath } from 'node:url'

import { resolveAppConfig } from './src/config.mjs'
import { createTaskClient } from './src/task-client.mjs'
import { createTasksRecorderServer } from './src/tools.mjs'

const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const config = await resolveAppConfig({ projectRoot })
const service = createTaskClient({
  baseUrl: config.serverBaseUrl,
})
const server = createTasksRecorderServer({ service })

try {
  await server.connect(new StdioServerTransport())
} catch (error) {
  process.stderr.write(`tasks-recorder failed to start: ${error.stack ?? error}\n`)
  process.exitCode = 1
}
