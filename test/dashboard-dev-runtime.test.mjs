import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createDashboardBuildLoop,
  startDashboardDevRuntime,
} from '../ui/dev-runtime.mjs'

const sseReaderStates = new WeakMap()

async function readSseEvent(reader) {
  let state = sseReaderStates.get(reader)
  if (!state) {
    state = { source: '', decoder: new TextDecoder() }
    sseReaderStates.set(reader, state)
  }
  while (!state.source.includes('\n\n')) {
    const { value, done } = await reader.read()
    if (done) throw new Error('SSE stream ended before an event arrived')
    state.source += state.decoder.decode(value, { stream: true })
  }
  const boundary = state.source.indexOf('\n\n') + 2
  const event = state.source.slice(0, boundary)
  state.source = state.source.slice(boundary)
  return event
}

test('build loop preserves last-good output across a failure and recovers once', async () => {
  const outcomes = [
    '<!doctype html><body>one</body>',
    new Error('/workspace/ui/src/dashboard.mjs: broken syntax'),
    '<!doctype html><body>two</body>',
  ]
  const published = []
  const errors = []
  const loop = createDashboardBuildLoop({
    compile: async () => {
      const outcome = outcomes.shift()
      if (outcome instanceof Error) throw outcome
      return outcome
    },
    onSuccess: (html) => published.push(html),
    onError: (error) => errors.push(error.message),
    debounceMs: 0,
  })

  assert.equal(await loop.buildInitial(), '<!doctype html><body>one</body>')
  loop.notifyChange()
  await loop.whenIdle()
  assert.deepEqual(published, ['<!doctype html><body>one</body>'])
  assert.equal(errors.length, 1)

  loop.notifyChange()
  await loop.whenIdle()
  assert.deepEqual(published, [
    '<!doctype html><body>one</body>',
    '<!doctype html><body>two</body>',
  ])
  await loop.close()
})

test('initial build failure propagates before runtime can listen', async () => {
  await assert.rejects(startDashboardDevRuntime({
    config: {
      host: '127.0.0.1',
      port: 0,
      upstream: new URL('http://127.0.0.1:43127'),
    },
    compile: async () => { throw new Error('initial compile failed') },
    watchSources: () => { throw new Error('watch must not start') },
  }), /initial compile failed/)
})

test('runtime serves the initial build then reloads after a watched successful build', async () => {
  const builds = [
    '<!doctype html><body>initial</body>',
    '<!doctype html><body>changed</body>',
  ]
  let sourceChanged
  let watcherClosed = false
  const runtime = await startDashboardDevRuntime({
    config: {
      host: '127.0.0.1',
      port: 0,
      upstream: new URL('http://127.0.0.1:43127'),
    },
    compile: async () => builds.shift(),
    watchSources: ({ onChange }) => {
      sourceChanged = onChange
      return { close() { watcherClosed = true } }
    },
    stderr: { write() {} },
    debounceMs: 0,
  })
  let reader
  try {
    assert.match(await fetch(runtime.address.url).then((response) => response.text()), /initial/)
    const reload = await fetch(`${runtime.address.url}/__tasks_recorder_dev/reload`)
    reader = reload.body.getReader()
    assert.match(await readSseEvent(reader), /event: ready/)

    sourceChanged('dashboard.css')
    await runtime.whenIdle()
    assert.match(await fetch(runtime.address.url).then((response) => response.text()), /changed/)
    assert.match(await readSseEvent(reader), /event: reload/)
  } finally {
    await reader?.cancel().catch(() => {})
    await runtime.close()
  }
  assert.equal(watcherClosed, true)
})

test('runtime keeps last-good HTML after failure and reloads after recovery', async () => {
  const builds = [
    '<!doctype html><body>stable</body>',
    new Error('/private/worktree/ui/src/dashboard.css: invalid CSS'),
    '<!doctype html><body>recovered</body>',
  ]
  const logs = []
  let sourceChanged
  const runtime = await startDashboardDevRuntime({
    config: {
      host: '127.0.0.1',
      port: 0,
      upstream: new URL('http://127.0.0.1:43127'),
    },
    compile: async () => {
      const result = builds.shift()
      if (result instanceof Error) throw result
      return result
    },
    watchSources: ({ onChange }) => {
      sourceChanged = onChange
      return { close() {} }
    },
    projectRoot: '/private/worktree',
    stderr: { write: (chunk) => logs.push(chunk) },
    debounceMs: 0,
  })
  let reader
  try {
    const reload = await fetch(`${runtime.address.url}/__tasks_recorder_dev/reload`)
    reader = reload.body.getReader()
    assert.match(await readSseEvent(reader), /event: ready/)
    const pendingReload = readSseEvent(reader)

    sourceChanged('dashboard.css')
    await runtime.whenIdle()
    assert.match(await fetch(runtime.address.url).then((response) => response.text()), /stable/)
    assert.equal(await Promise.race([
      pendingReload.then(() => 'event'),
      new Promise((resolve) => setTimeout(() => resolve('timeout'), 50)),
    ]), 'timeout')
    assert.match(logs.join(''), /ui\/src\/dashboard\.css/)
    assert.doesNotMatch(logs.join(''), /private\/worktree/)

    sourceChanged('dashboard.css')
    await runtime.whenIdle()
    assert.match(await fetch(runtime.address.url).then((response) => response.text()), /recovered/)
    assert.match(await pendingReload, /event: reload/)
  } finally {
    await reader?.cancel().catch(() => {})
    await runtime.close()
  }
})
