# Dashboard Dev Gateway Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a source-development Dashboard at `127.0.0.1:43128` that rebuilds and reloads automatically while using the installed taskd at `127.0.0.1:43127` for authoritative REST/SSE data.

**Architecture:** Extract the existing single-file Dashboard compiler, then compose a loopback-only HTTP gateway with a streaming taskd proxy and a separate dev reload SSE channel. A source watcher owns last-good build state; taskd remains the only SQLite owner and the production/release bundle remains dev-code-free.

**Tech Stack:** Node.js 24 native HTTP/filesystem APIs, esbuild 0.28.2, ESM, `node:test`, Playwright MCP (`playwright-headless`).

**Spec:** [`docs/superpowers/specs/2026-08-24-dashboard-dev-gateway-design.md`](../specs/2026-08-24-dashboard-dev-gateway-design.md)

## Global Constraints

- Work only in `/Users/joi-com/Desktop/space/projects/tasks-recorder/.worktree/feature-dashboard-dev-gateway` on branch `feature/dashboard-dev-gateway`.
- Before every edit or verification, confirm `git rev-parse --show-toplevel` equals that exact worktree path.
- Use TDD for every production behavior: add a focused failing test, observe the expected failure, make the smallest implementation pass, then run affected regressions.
- Bind only to `127.0.0.1`; reject non-loopback upstreams, credentials, paths, query strings, fragments, invalid ports, and matching dev/upstream ports.
- Keep taskd at `43127` as the only SQLite owner. The gateway must not import stores, services, config files, or database modules.
- Preserve API methods, query strings, bodies, response status, business headers, and streaming SSE. Validate dev `Host`/`Origin`, then rewrite them specifically for the validated upstream.
- Do not add CORS, remote assets, telemetry, auth tokens, Vite, chokidar, or another dependency.
- A failed runtime build keeps last-good HTML. An initial build failure exits before opening a listener.
- Production `ui/dist/index.html`, release archives, installed runtime, MCP, hooks, adapters, schema, and task semantics must remain unchanged.
- Dev-page mutations intentionally use the canonical local database; startup output and README must state this plainly.
- Do not auto-open a browser and do not implement sandbox data or component-level HMR.
- Use Conventional Commit messages and stage only files owned by the current Task.

---

### Task 1: Extract a reusable production-equivalent Dashboard compiler

**Files:**
- Create: `ui/compiler.mjs`
- Modify: `ui/build.mjs`
- Create: `test/dashboard-compiler.test.mjs`
- Verify: `test/dashboard-build.test.mjs`

**Interfaces:**
- Produces: `compileDashboard({ sourceRoot?, buildImpl? }): Promise<string>` returning one complete self-contained HTML document.
- Produces: `writeDashboard({ outputPath?, compile? }): Promise<{ outputPath: string, bytes: number }>` using a same-directory temporary file and atomic rename.
- Preserves: `node ui/build.mjs` and `npm run build` continue writing `ui/dist/index.html` with byte-identical content for unchanged inputs.

- [x] **Step 1: Write the failing compiler contract test**

Create `test/dashboard-compiler.test.mjs`:

```js
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { compileDashboard, writeDashboard } from '../ui/compiler.mjs'

test('compiler returns the tracked production dashboard without dev code', async () => {
  const [compiled, tracked] = await Promise.all([
    compileDashboard(),
    readFile(new URL('../ui/dist/index.html', import.meta.url), 'utf8'),
  ])

  assert.equal(compiled, tracked)
  assert.doesNotMatch(compiled, /__tasks_recorder_dev|43128|dev reload/i)
})

test('writer atomically publishes only a successful compilation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tasks-recorder-compiler-'))
  const outputPath = join(directory, 'index.html')
  try {
    const result = await writeDashboard({
      outputPath,
      compile: async () => '<!doctype html><title>compiled</title>',
    })
    assert.equal(await readFile(outputPath, 'utf8'), '<!doctype html><title>compiled</title>')
    assert.equal(result.outputPath, outputPath)
    assert.equal(result.bytes, Buffer.byteLength('<!doctype html><title>compiled</title>'))

    await assert.rejects(
      writeDashboard({ outputPath, compile: async () => { throw new Error('broken source') } }),
      /broken source/,
    )
    assert.equal(await readFile(outputPath, 'utf8'), '<!doctype html><title>compiled</title>')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
```

- [x] **Step 2: Run the test and verify RED**

Run:

```bash
node --test test/dashboard-compiler.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `ui/compiler.mjs`. This proves the test requires the new compiler boundary.

- [x] **Step 3: Move the existing compiler into the reusable module**

Create `ui/compiler.mjs` with the current esbuild/template/CSS behavior. Keep the existing font and completeness guards unchanged:

```js
import { build } from 'esbuild'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const uiRoot = dirname(fileURLToPath(import.meta.url))
const defaultSourceRoot = join(uiRoot, 'src')
const defaultOutputPath = join(uiRoot, 'dist', 'index.html')

export async function compileDashboard({ sourceRoot = defaultSourceRoot, buildImpl = build } = {}) {
  const bundled = await buildImpl({
    entryPoints: [join(sourceRoot, 'dashboard.mjs')],
    bundle: true,
    format: 'esm',
    minify: true,
    write: false,
    legalComments: 'inline',
    target: ['es2022'],
    outdir: 'out',
    loader: { '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl' },
  })
  const [template, dashboardCss] = await Promise.all([
    readFile(join(sourceRoot, 'index.html'), 'utf8'),
    readFile(join(sourceRoot, 'dashboard.css'), 'utf8'),
  ])
  const javascript = bundled.outputFiles.find(({ path }) => extname(path) === '.js')?.text
  const svarCss = bundled.outputFiles.find(({ path }) => extname(path) === '.css')?.text
  if (!javascript || !svarCss) throw new Error('SVAR Dashboard bundle is incomplete')
  const localSvarCss = svarCss.replace(/@font-face\s*\{[^{}]*\}/g, '')
  if (/https?:\/\/[^)'\"]+\.(?:woff2?|ttf)/i.test(localSvarCss)) {
    throw new Error('SVAR Dashboard CSS contains a remote font')
  }
  return template
    .replace('/*__SVAR_CSS__*/', () => localSvarCss)
    .replace('/*__DASHBOARD_CSS__*/', () => dashboardCss)
    .replace('/*__DASHBOARD_JS__*/', () => javascript)
}

export async function writeDashboard({ outputPath = defaultOutputPath, compile = compileDashboard } = {}) {
  const html = await compile()
  await mkdir(dirname(outputPath), { recursive: true })
  const temporaryPath = `${outputPath}.${process.pid}.tmp`
  try {
    await writeFile(temporaryPath, html)
    await rename(temporaryPath, outputPath)
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => {})
    throw error
  }
  return { outputPath, bytes: Buffer.byteLength(html) }
}
```

Replace `ui/build.mjs` with the side-effect-only entry:

```js
#!/usr/bin/env node

import { writeDashboard } from './compiler.mjs'

await writeDashboard()
```

- [x] **Step 4: Rebuild and verify GREEN plus production parity**

Run:

```bash
npm run build
node --test test/dashboard-compiler.test.mjs test/dashboard-build.test.mjs
git diff -- ui/dist/index.html
```

Expected: both test files PASS and `git diff -- ui/dist/index.html` has no output. If esbuild produces a byte change, compare it before proceeding; do not accept unexplained bundle churn.

- [x] **Step 5: Run focused syntax and diff checks**

Run:

```bash
node --check ui/compiler.mjs
node --check ui/build.mjs
git diff --check
```

Expected: all exit `0`.

- [x] **Step 6: Commit the compiler boundary**

```bash
git add ui/compiler.mjs ui/build.mjs test/dashboard-compiler.test.mjs
git commit -m "refactor(ui): extract dashboard compiler"
```

### Task 2: Implement the loopback gateway, trust boundary, proxy, and reload channel

**Files:**
- Create: `ui/dev-gateway.mjs`
- Create: `test/dashboard-dev-gateway.test.mjs`

**Interfaces:**
- Produces: `resolveDashboardDevConfig({ env? }): { host: '127.0.0.1', port: number, upstream: URL }`.
- Produces: `injectDashboardReloadClient(html): string`, which adds exactly one dev-only EventSource client before `</body>`.
- Produces: `createDashboardDevGateway({ host, port, upstream, getHtml }): { listen(), broadcastReload(), close() }`.
- `listen(): Promise<{ host: string, port: number, url: string }>` resolves the actual address; internal `port: 0` is allowed for isolated tests, but env parsing accepts only `1..65535`.
- `broadcastReload()` sends one `event: reload` to every current dev reload client.

- [x] **Step 1: Write failing config and HTML-injection tests**

Create `test/dashboard-dev-gateway.test.mjs` with these first contracts:

```js
import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import test from 'node:test'

import {
  createDashboardDevGateway,
  injectDashboardReloadClient,
  resolveDashboardDevConfig,
} from '../ui/dev-gateway.mjs'

test('dev config defaults to a distinct loopback listener and taskd upstream', () => {
  const config = resolveDashboardDevConfig({ env: {} })
  assert.deepEqual(
    { host: config.host, port: config.port, upstream: config.upstream.href },
    { host: '127.0.0.1', port: 43128, upstream: 'http://127.0.0.1:43127/' },
  )
})

test('dev config accepts valid overrides and rejects unsafe endpoints', () => {
  const overridden = resolveDashboardDevConfig({
    env: {
      TASKS_RECORDER_DEV_PORT: '44128',
      TASKS_RECORDER_DEV_UPSTREAM: 'http://127.0.0.1:44127',
    },
  })
  assert.equal(overridden.port, 44128)
  assert.equal(overridden.upstream.href, 'http://127.0.0.1:44127/')

  for (const env of [
    { TASKS_RECORDER_DEV_PORT: '0' },
    { TASKS_RECORDER_DEV_PORT: '43127' },
    { TASKS_RECORDER_DEV_UPSTREAM: 'http://0.0.0.0:43127' },
    { TASKS_RECORDER_DEV_UPSTREAM: 'https://127.0.0.1:43127' },
    { TASKS_RECORDER_DEV_UPSTREAM: 'http://user:pass@127.0.0.1:43127' },
    { TASKS_RECORDER_DEV_UPSTREAM: 'http://127.0.0.1:43127/api' },
  ]) assert.throws(() => resolveDashboardDevConfig({ env }), /dev|port|upstream|loopback/i)
})

test('reload client is injected once and remains absent from source HTML', () => {
  const source = '<!doctype html><body><main>Dashboard</main></body>'
  const injected = injectDashboardReloadClient(source)
  assert.doesNotMatch(source, /__tasks_recorder_dev/)
  assert.equal((injected.match(/__tasks_recorder_dev\/reload/g) ?? []).length, 1)
  assert.match(injected, /new EventSource/)
  assert.match(injected, /addEventListener\(['\"]reload['\"]/)
  assert.match(injected, /location\.reload/)
})
```

- [x] **Step 2: Run the tests and verify RED**

Run:

```bash
node --test test/dashboard-dev-gateway.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `ui/dev-gateway.mjs`.

- [x] **Step 3: Implement validated config and dev-only injection**

In `ui/dev-gateway.mjs`, add exact validation before any listener is created:

```js
const LOOPBACK = '127.0.0.1'

function portValue(value, field) {
  const port = Number(value)
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${field} must be an integer from 1 to 65535`)
  }
  return port
}

export function resolveDashboardDevConfig({ env = process.env } = {}) {
  const port = portValue(env.TASKS_RECORDER_DEV_PORT ?? 43128, 'TASKS_RECORDER_DEV_PORT')
  const upstream = new URL(env.TASKS_RECORDER_DEV_UPSTREAM ?? 'http://127.0.0.1:43127')
  if (upstream.protocol !== 'http:' || upstream.hostname !== LOOPBACK) {
    throw new Error('TASKS_RECORDER_DEV_UPSTREAM must be an HTTP loopback URL')
  }
  if (upstream.username || upstream.password || !['', '/'].includes(upstream.pathname)
    || upstream.search || upstream.hash) {
    throw new Error('TASKS_RECORDER_DEV_UPSTREAM must not contain credentials, path, query, or hash')
  }
  const upstreamPort = portValue(upstream.port || 80, 'TASKS_RECORDER_DEV_UPSTREAM port')
  if (port === upstreamPort) throw new Error('dev port must differ from upstream port')
  return { host: LOOPBACK, port, upstream }
}

const reloadClient = `<script data-tasks-recorder-dev-reload>
(() => {
  const source = new EventSource('/__tasks_recorder_dev/reload')
  source.addEventListener('reload', () => globalThis.location.reload())
})()
</script>`

export function injectDashboardReloadClient(html) {
  if (html.includes('data-tasks-recorder-dev-reload')) return html
  if (!html.includes('</body>')) throw new Error('Dashboard HTML is missing </body>')
  return html.replace('</body>', `${reloadClient}\n</body>`)
}
```

- [x] **Step 4: Add real HTTP proxy, security, and streaming tests**

Extend the same test file with real ephemeral servers. Use these helpers:

```js
async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address()
  return `http://127.0.0.1:${port}`
}

async function close(server) {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
}

async function rawStatus(url, headers) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { headers }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => resolve({
        status: response.statusCode,
        body: Buffer.concat(chunks).toString('utf8'),
      }))
    })
    request.on('error', reject)
    request.end()
  })
}

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
```

Add one integration test that starts an upstream server, captures request headers/body, and asserts:

```js
test('gateway serves HTML and securely proxies methods, origins, bodies, and SSE', async () => {
  const seen = []
  const upstreamServer = createServer((request, response) => {
    if (request.url === '/api/v1/events') {
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
      response.write('event: ready\ndata: {"revision":0}\n\n')
      return
    }
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      seen.push({
        method: request.method,
        url: request.url,
        host: request.headers.host,
        origin: request.headers.origin,
        body: Buffer.concat(chunks).toString('utf8'),
      })
      response.writeHead(207, { 'Content-Type': 'application/json', 'X-Upstream': 'taskd' })
      response.end('{"ok":true}')
    })
  })
  const upstreamUrl = await listen(upstreamServer)
  const upstream = new URL(upstreamUrl)
  const gateway = createDashboardDevGateway({
    host: '127.0.0.1', port: 0, upstream,
    getHtml: () => '<!doctype html><body>source</body>',
  })
  const address = await gateway.listen()
  let eventReader
  try {
    const htmlResponse = await fetch(address.url)
    assert.equal(htmlResponse.headers.get('content-type'), 'text/html; charset=utf-8')
    assert.equal(htmlResponse.headers.get('cache-control'), 'no-cache')
    assert.match(htmlResponse.headers.get('content-security-policy'), /connect-src 'self'/)
    const html = await htmlResponse.text()
    assert.match(html, /source/)
    assert.match(html, /__tasks_recorder_dev\/reload/)

    const mutation = await fetch(`${address.url}/api/v1/tasks/example`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Origin: address.url },
      body: '{"status":"done"}',
    })
    assert.equal(mutation.status, 207)
    assert.equal(mutation.headers.get('x-upstream'), 'taskd')
    assert.deepEqual(seen[0], {
      method: 'PATCH', url: '/api/v1/tasks/example',
      host: upstream.host, origin: upstream.origin, body: '{"status":"done"}',
    })

    assert.equal((await rawStatus(`${address.url}/health/live`, { Host: 'attacker.example' })).status, 403)
    assert.equal((await rawStatus(`${address.url}/health/live`, {
      Host: new URL(address.url).host, Origin: 'https://attacker.example',
    })).status, 403)

    const events = await fetch(`${address.url}/api/v1/events`)
    eventReader = events.body.getReader()
    assert.match(await readSseEvent(eventReader), /event: ready/)

    assert.equal((await fetch(`${address.url}/missing`)).status, 404)
  } finally {
    await eventReader?.cancel().catch(() => {})
    await gateway.close()
    await close(upstreamServer)
  }
})
```

Add the unavailable-upstream and reload-stream cases as separate tests:

```js
test('gateway returns bounded 502 and keeps serving HTML when upstream is unavailable', async () => {
  const closedServer = createServer()
  const closedUrl = await listen(closedServer)
  await close(closedServer)
  const gateway = createDashboardDevGateway({
    host: '127.0.0.1', port: 0, upstream: new URL(closedUrl),
    getHtml: () => '<!doctype html><body>last good</body>',
  })
  const address = await gateway.listen()
  try {
    const unavailable = await fetch(`${address.url}/api/v1/snapshot`)
    assert.equal(unavailable.status, 502)
    assert.deepEqual(await unavailable.json(), {
      ok: false,
      error: {
        code: 'DEV_UPSTREAM_UNAVAILABLE',
        message: 'Tasks Recorder upstream is unavailable',
      },
    })
    assert.match(await fetch(address.url).then((response) => response.text()), /last good/)
  } finally {
    await gateway.close()
  }
})

test('gateway broadcasts one reload event on the dedicated dev SSE channel', async () => {
  const gateway = createDashboardDevGateway({
    host: '127.0.0.1', port: 0, upstream: new URL('http://127.0.0.1:43127'),
    getHtml: () => '<!doctype html><body>source</body>',
  })
  const address = await gateway.listen()
  let reader
  try {
    const response = await fetch(`${address.url}/__tasks_recorder_dev/reload`)
    reader = response.body.getReader()
    assert.match(await readSseEvent(reader), /event: ready/)
    gateway.broadcastReload()
    assert.match(await readSseEvent(reader), /event: reload/)
  } finally {
    await reader?.cancel().catch(() => {})
    await gateway.close()
  }
})
```

- [x] **Step 5: Implement the minimal gateway**

Use `node:http` `createServer` and `request`, not `fetch`, so request bodies and SSE responses remain streaming. The server request handler must execute this order:

```js
validateRequestBoundary(request, expectedHost, devOrigin)
if (GET / or /index.html) send injected getHtml()
else if (GET /__tasks_recorder_dev/reload) attachReloadClient(response)
else if (pathname starts /api/ or /health/) proxyRequest(request, response, upstream)
else send 404
```

The HTML response must use `Content-Type: text/html; charset=utf-8`, `Cache-Control: no-cache`, `X-Content-Type-Options: nosniff`, and the same loopback-only Content Security Policy as taskd (`default-src 'self'`, inline script/style for the self-contained bundle, `connect-src 'self'`, data image/font, and `frame-ancestors 'none'`). Error and 404 responses use JSON with `Cache-Control: no-store`.

Define the hop-by-hop set exactly as:

```js
const hopByHopHeaders = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
])
```

For proxy request headers, copy entries not in that set, set `host` to `upstream.host`, and only when incoming `origin` exists set it to `upstream.origin`. Pipe `request` into the upstream request. Copy non-hop-by-hop response headers and pipe the upstream response into the browser response. Before response headers are sent, map upstream connection errors to:

```json
{"ok":false,"error":{"code":"DEV_UPSTREAM_UNAVAILABLE","message":"Tasks Recorder upstream is unavailable"}}
```

with status `502`, `Content-Type: application/json; charset=utf-8`, and `Cache-Control: no-store`. Do not expose the original socket error.

`close()` must end all reload responses, destroy active proxy sockets if needed, and await `server.close()` so test processes cannot hang.

- [x] **Step 6: Verify focused GREEN and connection cleanup**

Run:

```bash
node --test test/dashboard-dev-gateway.test.mjs
```

Expected: all config, HTML, security, body proxy, SSE proxy, reload SSE, 404, 502, and close tests PASS; the test process exits without `--test-force-exit`.

- [x] **Step 7: Run affected regressions and commit**

Run:

```bash
node --check ui/dev-gateway.mjs
node --test test/dashboard-dev-gateway.test.mjs test/api-server.test.mjs
git diff --check
```

Then commit:

```bash
git add ui/dev-gateway.mjs test/dashboard-dev-gateway.test.mjs
git commit -m "feat(ui): add dashboard dev gateway"
```

### Task 3: Add last-good rebuild lifecycle, source watch, and CLI composition

**Files:**
- Create: `ui/dev-runtime.mjs`
- Create: `ui/dev-server.mjs`
- Create: `test/dashboard-dev-runtime.test.mjs`
- Modify: `package.json`
- Modify: `scripts/check-syntax.mjs`

**Interfaces:**
- Produces: `createDashboardBuildLoop({ compile, onSuccess, onError, debounceMs? })` with `buildInitial()`, `notifyChange()`, `whenIdle()`, and `close()`.
- Produces: `watchDashboardSources({ sourceRoot, onChange, watchImpl? })` returning a closeable watcher.
- Produces: `startDashboardDevRuntime({ config, projectRoot?, compile?, watchSources?, stderr?, debounceMs? }): Promise<{ address, whenIdle(), close() }>`.
- Produces: executable `ui/dev-server.mjs`, used by `npm run dev:ui`.

- [x] **Step 1: Write the failing last-good build loop test**

Create `test/dashboard-dev-runtime.test.mjs`:

```js
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
      host: '127.0.0.1', port: 0,
      upstream: new URL('http://127.0.0.1:43127'),
    },
    compile: async () => { throw new Error('initial compile failed') },
    watchSources: () => { throw new Error('watch must not start') },
  }), /initial compile failed/)
})
```

- [x] **Step 2: Run the test and verify RED**

Run:

```bash
node --test test/dashboard-dev-runtime.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `ui/dev-runtime.mjs`.

- [x] **Step 3: Implement the serialized build loop and source watcher**

In `ui/dev-runtime.mjs`, implement one build at a time. `notifyChange()` debounces; if called while compiling it sets one pending flag, never launches a concurrent esbuild. `whenIdle()` resolves only when timer, active build, and pending flag are all clear. `close()` cancels a timer and waits for an active build.

Use this public watcher boundary:

```js
import { watch } from 'node:fs'

export function watchDashboardSources({ sourceRoot, onChange, watchImpl = watch }) {
  return watchImpl(sourceRoot, { recursive: true }, (_eventType, filename) => {
    if (filename) onChange(filename)
  })
}
```

The loop's `buildInitial()` must propagate failure; scheduled builds must call `onError(error)` and remain usable. `onSuccess(html, { durationMs })` is called only after a complete successful compile.

- [x] **Step 4: Add a runtime integration test with injected compiler and watcher**

Extend `test/dashboard-dev-runtime.test.mjs`:

```js
test('runtime serves the initial build then reloads after a watched successful build', async () => {
  const builds = [
    '<!doctype html><body>initial</body>',
    '<!doctype html><body>changed</body>',
  ]
  let sourceChanged
  let watcherClosed = false
  const runtime = await startDashboardDevRuntime({
    config: {
      host: '127.0.0.1', port: 0,
      upstream: new URL('http://127.0.0.1:43127'),
    },
    compile: async () => builds.shift(),
    watchSources: ({ onChange }) => {
      sourceChanged = onChange
      return { close() { watcherClosed = true } }
    },
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
```

Add the failure/recovery runtime case with one pending SSE read so the negative assertion does not leave a second reader operation behind:

```js
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
      host: '127.0.0.1', port: 0,
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
```

- [x] **Step 5: Compose compiler, gateway, watcher, logging, and signals**

`startDashboardDevRuntime` must:

1. call `compileDashboard()` before constructing the listener;
2. hold HTML in a closure used by `createDashboardDevGateway({ getHtml })`;
3. listen, then start the filesystem watcher;
4. replace HTML and call `gateway.broadcastReload()` only in `onSuccess` for later builds;
5. write source-relative, privacy-bounded build errors to the injected `stderr`;
6. close watcher, build loop, and gateway in that order.

Use `projectRoot = fileURLToPath(new URL('..', import.meta.url))`, derive `sourceRoot = join(projectRoot, 'ui', 'src')`, and keep the composition explicit:

```js
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { compileDashboard } from './compiler.mjs'
import { createDashboardDevGateway } from './dev-gateway.mjs'

export async function startDashboardDevRuntime({
  config,
  projectRoot = fileURLToPath(new URL('..', import.meta.url)),
  compile = () => compileDashboard({ sourceRoot: join(projectRoot, 'ui', 'src') }),
  watchSources = watchDashboardSources,
  stderr = process.stderr,
  debounceMs = 75,
} = {}) {
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
      const bounded = String(error?.message ?? error)
        .replaceAll(`${projectRoot}/`, '')
        .split('\n').slice(0, 20).join('\n')
      stderr.write(`Dashboard rebuild failed: ${bounded}\n`)
    },
  })
  await buildLoop.buildInitial()
  gateway = createDashboardDevGateway({ ...config, getHtml: () => html })
  const address = await gateway.listen()
  const watcher = watchSources({
    sourceRoot: join(projectRoot, 'ui', 'src'),
    onChange: () => buildLoop.notifyChange(),
  })
  return {
    address,
    whenIdle: () => buildLoop.whenIdle(),
    async close() {
      watcher.close()
      await buildLoop.close()
      await gateway.close()
    },
  }
}
```

Create `ui/dev-server.mjs`:

```js
#!/usr/bin/env node

import { resolveDashboardDevConfig } from './dev-gateway.mjs'
import { startDashboardDevRuntime } from './dev-runtime.mjs'

try {
  const config = resolveDashboardDevConfig()
  const runtime = await startDashboardDevRuntime({ config })
  process.stderr.write(`Tasks Recorder source Dashboard: ${runtime.address.url}\n`)
  process.stderr.write(`Live taskd upstream: ${config.upstream.origin}\n`)
  process.stderr.write('Warning: Dashboard mutations update your real local Tasks Recorder data.\n')
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
```

Add to `package.json` scripts:

```json
"dev:ui": "node ui/dev-server.mjs"
```

Change `scripts/check-syntax.mjs` roots from separate `ui/src` and `ui/build.mjs` entries to one `ui` entry. Its existing recursive walker already skips `dist` and `node_modules`, so it will check compiler, gateway, runtime, CLI, and source modules exactly once.

- [x] **Step 6: Verify focused GREEN, real CLI startup, and signal shutdown**

Run focused tests:

```bash
node --test test/dashboard-dev-runtime.test.mjs test/dashboard-dev-gateway.test.mjs
npm run check
```

Expected: all PASS and syntax output includes the new modules in its source-file count.

With the installed taskd already ready at `43127`, start:

```bash
npm run dev:ui
```

Expected stderr includes the `43128` URL, `43127` upstream, and mutation warning. In a second terminal verify:

```bash
curl -fsS http://127.0.0.1:43128/ >/dev/null
curl -fsS http://127.0.0.1:43128/api/v1/snapshot >/dev/null
```

Send `Ctrl-C`; acceptance requires `curl http://127.0.0.1:43128/` can no longer connect. Direct `node ui/dev-server.mjs` must exit `0`; an interactive `npm run dev:ui` wrapper may itself report the delivered terminal signal as a non-zero shell status even though the child closed cleanly.

- [x] **Step 7: Commit the complete live-development workflow**

```bash
git add ui/dev-runtime.mjs ui/dev-server.mjs test/dashboard-dev-runtime.test.mjs package.json scripts/check-syntax.mjs
git commit -m "feat(ui): add live dashboard development workflow"
```

### Task 4: Document, visually validate, and close the public development contract

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-08-24-dashboard-dev-gateway-design.md`
- Modify: `docs/superpowers/plans/2026-08-24-dashboard-dev-gateway.md`
- Verify: `ui/dist/index.html`
- Verify: `release/*.tar.gz`

**Interfaces:**
- Documents: installed Dashboard `43127` versus source preview `43128`, override variables, real-data mutation warning, and production Release separation.
- Closes: all automated, browser, packaging, documentation-tree, and Johari evidence required by the spec.

- [x] **Step 1: Update README Development instructions**

In `## Develop from source`, after `npm ci`, add the primary UI loop:

~~~markdown
保持已安装的 taskd 在 `http://127.0.0.1:43127` 运行，然后启动源码 Dashboard：

```bash
npm run dev:ui
```

打开 <http://127.0.0.1:43128>。`ui/src` 构建成功后页面会自动刷新；实时 snapshot、任务变更 SSE 和 API 操作仍由 `43127` 的正式 taskd 提供，不需要发布 Release 或重新安装。

`43128` 页面中的编辑、归属和状态修改会写入当前真实本机数据库。只做视觉检查时不要触发 mutation；需要其他端口或 taskd upstream 时使用：

```bash
TASKS_RECORDER_DEV_PORT=44128 \
TASKS_RECORDER_DEV_UPSTREAM=http://127.0.0.1:44127 \
npm run dev:ui
```

dev gateway 只监听 loopback，不读取 SQLite，也不会写入已安装的 immutable release。正式交付前仍需执行下面的 production gates。
~~~

Keep the existing build/check/test command block after this explanation. Do not describe `npm run dev:ui` as part of normal end-user installation.

- [x] **Step 2: Run fresh focused and full automated gates**

Run from the feature worktree:

```bash
npm run build
npm run build:adapters
npm run check
TZ=UTC npm test
npm run package:release
bash -n install.sh
git diff --check
```

Expected: every command exits `0`; production UI contains no `__tasks_recorder_dev`, `43128`, or reload client. Record exact test and syntax counts in the spec closeout note.

- [x] **Step 3: Verify release archives exclude dev source runtime**

Run:

```bash
for archive in release/tasks-recorder-macos.tar.gz release/tasks-recorder-codex-adapter.tar.gz release/tasks-recorder-claude-adapter.tar.gz; do
  tar -tzf "$archive" >/dev/null
done
tar -tzf release/tasks-recorder-macos.tar.gz | rg 'ui/(dev-|compiler\.mjs)' && exit 1 || true
rg -n '__tasks_recorder_dev|43128|data-tasks-recorder-dev-reload' ui/dist/index.html && exit 1 || true
```

Expected: archives are readable and both negative scans produce no matches.

- [x] **Step 4: Run Playwright headless against the real dev gateway**

Use the existing `playwright-headless` MCP server. Keep installed taskd `43127` ready and run `npm run dev:ui` in this worktree. At `1440×900` open `http://127.0.0.1:43128` and verify:

- title and Project-first Grid/Timeline render from source HTML;
- `GET /api/v1/snapshot` through `43128` returns `200`;
- Dashboard `/api/v1/events` remains open and receives the taskd `ready` event;
- dev `/__tasks_recorder_dev/reload` remains open and receives its own `ready` event;
- console has zero errors and zero warnings;
- no mutation control is activated during this production-data smoke.

Then make a reversible source-only presentation change in `ui/src/dashboard.css` using `apply_patch`, observe automatic page reload and the computed style change, immediately revert that exact patch with `apply_patch`, and observe a second automatic reload restoring the original computed style. Confirm `git diff -- ui/src/dashboard.css` is empty afterward. Record initial build and both reload latencies; if a stable reload exceeds two seconds, stop and reassess the HMR assumption instead of declaring success.

- [x] **Step 5: Perform the required documentation-tree scan**

Run:

```bash
git diff --name-only HEAD
find . -name "*.md" -not -path "*/node_modules/*" -not -path "*/.git/*" -not -path "*/.worktree/*"
rg -n "npm run build|Develop from source|43127|Dashboard|ui/build\.mjs" README.md docs -g '*.md'
```

Update only documentation whose current public contract is affected. Historical specs/plans remain historical. If no other file needs changes, record exactly: `扫描了文档树，无需同步`.

- [x] **Step 6: Close the spec and plan with evidence**

Change the spec header status from `待用户复核` to `已实现并验证`. Append a short `## Implementation Evidence` section containing:

- the design/spec/plan commit hashes and four preceding code commit hashes；final documentation commit 在提交后由 handoff 报告，不能把 commit 自身 hash 写进自身；
- focused and full test counts;
- syntax count and production/release build results;
- Playwright URL, viewport, snapshot/SSE/reload/console results, and measured latency;
- production bundle/archive negative-scan results;
- remaining known limitation: mutations use real local data; sandbox remains a separate future design.

Check every completed plan checkbox only after its command or observation has direct evidence. Do not mark a failed or skipped gate complete.

- [x] **Step 7: Run final diff, link, and worktree checks**

Run:

```bash
git diff --check
git status --short
node --test test/dashboard-compiler.test.mjs test/dashboard-dev-gateway.test.mjs test/dashboard-dev-runtime.test.mjs test/dashboard-build.test.mjs
```

Resolve the spec link from this plan and every new relative README link. Expected: no missing target, no whitespace error, and only Task 4 documentation files remain uncommitted.

- [x] **Step 8: Commit documentation and verification closeout**

```bash
git add README.md \
  docs/superpowers/specs/2026-08-24-dashboard-dev-gateway-design.md \
  docs/superpowers/plans/2026-08-24-dashboard-dev-gateway.md
git commit -m "docs: document dashboard source preview"
```

After the commit, run `git status --short --branch`; expected: clean `feature/dashboard-dev-gateway` worktree with no unrelated changes.

## Final Johari Checkpoint

- **Open Area:** Compiler parity, gateway boundary, streaming proxy, last-good rebuild state, production packaging, and browser reload each require direct test or browser evidence before completion.
- **Hidden Area:** The user may later need destructive interaction testing without real data; this plan documents the limitation but does not infer a sandbox requirement.
- **Blind Spot:** Dev-origin rewriting can become a security bypass if performed before validation. Task 2 requires rejecting incoming foreign `Host`/`Origin` first and tests the exact rewritten upstream values.
- **Unknown Area:** Whole-page reload latency is measured in Task 4. A stable result above two seconds invalidates the current YAGNI choice and triggers a new HMR design decision.
