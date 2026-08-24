#!/usr/bin/env node

import { resolveDashboardDevConfig } from './dev-gateway.mjs'
import { startDashboardDevRuntime } from './dev-runtime.mjs'

try {
  const config = resolveDashboardDevConfig()
  const runtime = await startDashboardDevRuntime({ config })
  process.stderr.write(`Tasks Recorder source Dashboard: ${runtime.address.url}\n`)
  process.stderr.write(`Live taskd upstream: ${config.upstream.origin}\n`)
  process.stderr.write(
    'Warning: Dashboard mutations update your real local Tasks Recorder data.\n',
  )
  let stopping = false
  async function stop() {
    if (stopping) return
    stopping = true
    await runtime.close()
  }
  process.once('SIGINT', () => { stop().finally(() => process.exit(0)) })
  process.once('SIGTERM', () => { stop().finally(() => process.exit(0)) })
} catch (error) {
  process.stderr.write(`Tasks Recorder Dashboard dev server failed: ${error.message}\n`)
  process.exitCode = 1
}
