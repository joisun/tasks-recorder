import { watch } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { compileDashboard } from './compiler.mjs'
import { createDashboardDevGateway } from './dev-gateway.mjs'

const defaultProjectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))

export function createDashboardBuildLoop({
  compile,
  onSuccess,
  onError,
  debounceMs = 75,
} = {}) {
  if (typeof compile !== 'function') throw new TypeError('compile must be a function')
  if (typeof onSuccess !== 'function') throw new TypeError('onSuccess must be a function')
  if (typeof onError !== 'function') throw new TypeError('onError must be a function')
  if (!Number.isSafeInteger(debounceMs) || debounceMs < 0) {
    throw new TypeError('debounceMs must be a non-negative safe integer')
  }

  let timer = null
  let running = null
  let pending = false
  let closed = false
  const idleWaiters = new Set()

  function idle() {
    return timer === null && running === null && !pending
  }

  function resolveIdleWaiters() {
    if (!idle()) return
    for (const resolveWaiter of idleWaiters) resolveWaiter()
    idleWaiters.clear()
  }

  function schedule() {
    if (closed) return
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      startBuild(false)
    }, debounceMs)
  }

  function finishBuild(current) {
    if (running !== current) return
    running = null
    if (pending && !closed) {
      pending = false
      schedule()
    } else {
      resolveIdleWaiters()
    }
  }

  function startBuild(propagateError) {
    if (closed) return Promise.reject(new Error('Dashboard build loop is closed'))
    const startedAt = performance.now()
    const current = (async () => {
      try {
        const html = await compile()
        await onSuccess(html, { durationMs: Math.round(performance.now() - startedAt) })
        return html
      } catch (error) {
        if (propagateError) throw error
        await onError(error)
        return undefined
      }
    })()
    running = current
    current.then(
      () => finishBuild(current),
      () => finishBuild(current),
    )
    return current
  }

  return {
    buildInitial() {
      if (timer !== null || running !== null) {
        throw new Error('Dashboard initial build has already started')
      }
      return startBuild(true)
    },
    notifyChange() {
      if (closed) return
      if (running !== null) pending = true
      else schedule()
    },
    whenIdle() {
      if (idle()) return Promise.resolve()
      return new Promise((resolveWaiter) => idleWaiters.add(resolveWaiter))
    },
    async close() {
      if (closed) return
      closed = true
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      pending = false
      await running?.catch(() => {})
      resolveIdleWaiters()
    },
  }
}

export function watchDashboardSources({ sourceRoot, onChange, watchImpl = watch }) {
  return watchImpl(sourceRoot, { recursive: true }, (_eventType, filename) => {
    if (filename) onChange(filename)
  })
}

function boundedBuildError(error, projectRoot) {
  return String(error?.message ?? error)
    .replaceAll(`${projectRoot}/`, '')
    .split('\n')
    .slice(0, 20)
    .join('\n')
}

export async function startDashboardDevRuntime({
  config,
  projectRoot = defaultProjectRoot,
  compile = () => compileDashboard({ sourceRoot: join(projectRoot, 'ui', 'src') }),
  watchSources = watchDashboardSources,
  stderr = process.stderr,
  debounceMs = 75,
} = {}) {
  const normalizedProjectRoot = resolve(projectRoot)
  let html
  let gateway
  const buildLoop = createDashboardBuildLoop({
    compile,
    debounceMs,
    onSuccess(nextHtml, { durationMs }) {
      html = nextHtml
      if (gateway) {
        stderr.write(`Dashboard rebuilt in ${durationMs}ms\n`)
        gateway.broadcastReload()
      }
    },
    onError(error) {
      stderr.write(
        `Dashboard rebuild failed: ${boundedBuildError(error, normalizedProjectRoot)}\n`,
      )
    },
  })
  try {
    await buildLoop.buildInitial()
  } catch (error) {
    await buildLoop.close()
    throw new Error(boundedBuildError(error, normalizedProjectRoot), { cause: error })
  }

  let watcher
  try {
    gateway = createDashboardDevGateway({ ...config, getHtml: () => html })
    const address = await gateway.listen()
    watcher = watchSources({
      sourceRoot: join(normalizedProjectRoot, 'ui', 'src'),
      onChange: () => buildLoop.notifyChange(),
    })
    let closed = false
    return {
      address,
      whenIdle: () => buildLoop.whenIdle(),
      async close() {
        if (closed) return
        closed = true
        try {
          await watcher.close()
        } finally {
          await buildLoop.close()
          await gateway.close()
        }
      },
    }
  } catch (error) {
    await buildLoop.close()
    await gateway?.close().catch(() => {})
    throw error
  }
}
