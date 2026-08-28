# Dashboard Live Session Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stream an active Codex Run into Dashboard and let the user steer or stop its current Turn without exposing shell or runtime protocol identity.

**Architecture:** Codex Runs use one isolated `codex app-server` stdio process managed by a focused interactive driver. RunService retains lifecycle ownership, publishes normalized bounded events through the existing Run Event Hub, and exposes typed Turn-revision control methods to HTTP; Dashboard renders ephemeral Live Session state and posts semantic steer/stop intents.

**Tech Stack:** Node.js ESM, `node:child_process`, newline-delimited JSON-RPC 2.0 over stdio, taskd HTTP/SSE, vanilla browser modules/CSS, Node test runner, existing Playwright MCP.

**Spec:** `docs/superpowers/specs/2026-08-27-live-session-control-design.md`

## Global Constraints

- Implement only active-Turn observation, steer, and stop; completed Runs continue through Terminal Resume.
- Use one app-server process per interactive Run; do not add a shared daemon or a second control plane.
- The browser sends Run ID, taskd-generated `expected_turn_revision`, and bounded text only.
- Runtime `turnId` remains inside taskd's Codex driver. Codex `threadId` continues as the existing public `session_id` for copy and Terminal Resume, but the browser never submits it as control authority.
- Do not persist prompt, guidance, reasoning, tool payload, assistant message, or transcript content in SQLite or logs.
- Spawn with argv and `shell: false`; use the existing Runtime Environment for child environment repair.
- Preserve the existing one-shot Process Supervisor for non-interactive runtime definitions.
- Bound JSON line size at 256 KiB, intervention text at 16 KiB UTF-8, protocol request timeout at 10 seconds, and graceful-to-force shutdown at 2 seconds.
- Do not add dependencies.
- Do not create a Git commit unless the user explicitly requests one.

---

## File map

### New files

- `server/src/runtime/codex-app-server-client.mjs`: bounded JSON-RPC stdio transport, request correlation, notifications, and shutdown.
- `server/src/runtime/adapters/codex-interactive-session.mjs`: Codex protocol handshake, private thread/Turn state, event normalization, steer, interrupt, and completion result.
- `ui/src/run-event-stream.mjs`: Run-specific SSE connection, sequence cursor, reset, reconnect, and teardown.
- `test/codex-app-server-client.test.mjs`: transport contract tests with fake child streams.
- `test/codex-interactive-session.test.mjs`: protocol flow and normalized event tests.
- `test/run-event-stream.test.mjs`: browser stream lifecycle tests.

### Modified files

- `server/src/runtime/adapters/codex.mjs`: declare `interactiveSession` capability and construct the Codex driver.
- `server/src/runtime/runtime-event.mjs`: accept the normalized interactive event vocabulary.
- `server/src/runs/run-service.mjs`: select interactive execution, own public Turn revisions, expose `steer()` and `stop()`.
- `server/src/runs/run-event-hub.mjs`: report replay gaps deterministically, including an expired empty buffer.
- `server/src/taskd-runtime.mjs`: inject shared Runtime Environment and interactive session factory.
- `server/src/api-server.mjs`: typed steer/stop routes, status mapping, request limits, and SSE reset consistency.
- `ui/src/dashboard-api.mjs`: typed steer/stop methods.
- `ui/src/scheduled-run-review.mjs`: Live Session state reducer, event rendering, composer, stop, and read-only fallback.
- `ui/src/dashboard.css`: Live Session sheet, stream, activity, composer, responsive, focus, and reduced-motion styles.
- `test/run-service.test.mjs`, `test/run-event-hub.test.mjs`, `test/run-api.test.mjs`, `test/runtime-api.test.mjs`, `test/scheduled-run-review.test.mjs`, `test/dashboard-build.test.mjs`, `test/taskd-runtime.test.mjs`: focused regression and integration coverage.
- `README.md`, `docs/architecture.md`, `docs/job/tasks-recorder-scheduled-tasks/04-test-plan.md`, and `docs/job/tasks-recorder-scheduled-tasks/06-test-report.md`: public behavior, privacy boundary, protocol health, test coverage, and evidence.

---

### Task 1: Bounded Codex app-server JSON-RPC transport

**Files:**
- Create: `server/src/runtime/codex-app-server-client.mjs`
- Test: `test/codex-app-server-client.test.mjs`

**Interfaces:**
- Consumes: `spawnImpl(command, args, { cwd, env, shell:false, stdio })`, `AbortSignal`, `runtimeEnvironment.childEnvironment()`.
- Produces: `createCodexAppServerClient(options)` returning `{ request(method, params), notify(method, params), onNotification(listener), close(), closed }`.
- Request failures expose stable codes: `RUNTIME_PROTOCOL_TIMEOUT`, `RUNTIME_PROTOCOL_CLOSED`, `RUNTIME_PROTOCOL_INVALID`, and `RUNTIME_PROTOCOL_ERROR`.

- [ ] **Step 1: Write failing framing and correlation tests**

```js
const client = createCodexAppServerClient({
  executable: '/opt/bin/codex', cwd: '/tmp/project',
  spawnImpl: fakeSpawn.child,
  runtimeEnvironment: { childEnvironment: () => ({ PATH: '/opt/bin' }) },
})
const pending = client.request('initialize', { clientInfo: { name: 'tasks-recorder', version: 'source' } })
assert.deepEqual(JSON.parse(fakeSpawn.stdin.at(-1)), {
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { clientInfo: { name: 'tasks-recorder', version: 'source' } },
})
fakeSpawn.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { userAgent: 'codex' } })}\n`)
assert.deepEqual(await pending, { userAgent: 'codex' })
```

Also assert notification delivery, split chunks, multiple lines per chunk, unmatched response rejection, 256 KiB overflow failure, child exit rejection, request timeout, AbortSignal, one SIGINT followed by bounded SIGKILL, and no `shell` option other than `false`.

- [ ] **Step 2: Run the test and verify the transport is absent**

Run: `node --test test/codex-app-server-client.test.mjs`

Expected: FAIL with module-not-found for `codex-app-server-client.mjs`.

- [ ] **Step 3: Implement the minimal transport**

```js
export function createCodexAppServerClient({
  executable, cwd, env = {}, signal, spawnImpl = spawn,
  runtimeEnvironment = createRuntimeEnvironment({ env: process.env }),
  requestTimeoutMs = 10_000, maximumLineBytes = 256 * 1024,
  forceKillAfterMs = 2_000, setTimer = setTimeout, clearTimer = clearTimeout,
} = {}) {
  const child = spawnImpl(executable, ['app-server', '--listen', 'stdio://'], {
    cwd, env: runtimeEnvironment.childEnvironment(env), shell: false,
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  })
  // Correlate monotonically increasing numeric IDs, parse bounded lines,
  // route method-bearing messages to listeners, and settle every pending
  // request exactly once during timeout, abort, invalid frame, or close.
}
```

The implementation must never write protocol frames to Run logs and must never include request params in public errors.

- [ ] **Step 4: Run focused transport tests**

Run: `node --test test/codex-app-server-client.test.mjs`

Expected: PASS.

- [ ] **Step 5: Run formatting and syntax checks for the new unit**

Run: `node --check server/src/runtime/codex-app-server-client.mjs && git diff --check -- server/src/runtime/codex-app-server-client.mjs test/codex-app-server-client.test.mjs`

Expected: both commands exit 0.

### Task 2: Codex interactive session driver

**Files:**
- Create: `server/src/runtime/adapters/codex-interactive-session.mjs`
- Modify: `server/src/runtime/adapters/codex.mjs`
- Modify: `server/src/runtime/runtime-event.mjs`
- Test: `test/codex-interactive-session.test.mjs`
- Test: `test/codex-runtime-adapter.test.mjs`

**Interfaces:**
- Consumes: `createCodexAppServerClient()`, resolved executable, Run snapshot, clock, AbortSignal, `emit({ type, payload })`.
- Produces: `createCodexInteractiveSessionFactory({ createClient, clock })` with `create({ launch, run, signal, emit, onSpawn })`.
- Created session produces `{ start(), steer({ expectedTurnRevision, text }), interrupt({ expectedTurnRevision }), close(), completion }` and read-only `{ turnRevision, steerable }`.
- Driver emits semantic events without sequence; RunService adds Run ID, time, and sequence.

- [ ] **Step 1: Write failing protocol-flow tests**

```js
const session = factory.create({ launch, run, signal, emit: events.push.bind(events), onSpawn })
const completion = session.start()
assert.deepEqual(client.requests.map(({ method }) => method), [
  'initialize', 'thread/start', 'turn/start',
])
client.notify('turn/started', { threadId: 'private-thread', turn: { id: 'private-turn' } })
client.notify('item/agentMessage/delta', {
  threadId: 'private-thread', turnId: 'private-turn', itemId: 'message-1', delta: 'Working',
})
assert.deepEqual(events.at(-1), {
  type: 'assistant_delta', payload: { item_id: 'message-1', delta: 'Working', turn_revision: 1 },
})
await session.steer({ expectedTurnRevision: 1, text: 'Check the migration first.' })
assert.equal(client.requests.at(-1).method, 'turn/steer')
```

Assert initialize-before-thread ordering, `approvalPolicy: 'never'`, Run cwd/model/reasoning/sandbox mapping, private identity redaction, command/tool/file activity normalization, usage, completion result, unknown item fallback, stale revision rejection, `activeTurnNotSteerable` mapping, interrupt idempotency, AbortSignal, and protocol exit.

- [ ] **Step 2: Run driver tests and verify failure**

Run: `node --test test/codex-interactive-session.test.mjs test/codex-runtime-adapter.test.mjs`

Expected: FAIL because the factory and `interactiveSession` capability do not exist.

- [ ] **Step 3: Implement the driver and registry capability**

```js
const INTERACTIVE_EVENT_TYPES = [
  'turn_started', 'assistant_delta', 'activity_started',
  'activity_completed', 'usage_updated', 'intervention_accepted',
]

// In createCodexRuntimeDefinition return value:
capabilities: Object.freeze({
  modelSelection: true, reasoning: true, sessionResume: true,
  sandbox: true, interactiveSession: true,
}),
createInteractiveSession: interactiveFactory.create,
```

Map the installed protocol's generated schema names exactly. Treat unknown notifications as bounded `activity_completed` summaries only when a safe item type/title is available; otherwise ignore them. Keep raw protocol frames, prompt, and steer text out of emitted payloads.

- [ ] **Step 4: Run driver and adapter tests**

Run: `node --test test/codex-app-server-client.test.mjs test/codex-interactive-session.test.mjs test/codex-runtime-adapter.test.mjs`

Expected: PASS.

- [ ] **Step 5: Confirm privacy properties mechanically**

Run: `rg -n "prompt|reasoningContent|tool_input|tool_output|expectedTurnId" server/src/runtime/adapters/codex-interactive-session.mjs server/src/runtime/runtime-event.mjs`

Expected: only Run input mapping references prompt/reasoning configuration; no emitted payload includes raw prompt, reasoning content, tool input/output, or runtime Turn ID.

### Task 3: RunService interactive lifecycle and intervention ownership

**Files:**
- Modify: `server/src/runs/run-service.mjs`
- Test: `test/run-service.test.mjs`

**Interfaces:**
- Consumes: optional `definition.createInteractiveSession({ launch, run, signal, emit, onSpawn })`; existing `supervisor.start()` fallback.
- Produces: `runService.steer(runId, { expected_turn_revision, text })`, `runService.stop(runId, { expected_turn_revision })`, and public Run fields `interactive` plus `turn_revision` while active.
- Stable errors: `RUN_NOT_ACTIVE`, `TURN_CHANGED`, `TURN_NOT_STEERABLE`, `RUNTIME_NOT_INTERACTIVE`, and `RUNTIME_PROTOCOL_UNAVAILABLE`.

- [ ] **Step 1: Add failing active-session tests**

```js
const { run } = await service.create(input)
await running.promise
assert.deepEqual(await service.steer(run.id, {
  expected_turn_revision: 1,
  text: 'Verify the failing test before editing.',
}), { accepted: true, run_id: run.id, turn_revision: 1 })
assert.deepEqual(interactive.steers, [{ expectedTurnRevision: 1, text: 'Verify the failing test before editing.' }])
```

Also cover queued/no-Turn, completed Run, stale revision, non-interactive runtime, accepted steer not persisted or emitted with text, stop-to-terminal convergence, repeated stop, session crash, completion exactly once, existing one-shot path, cancellation during resolution, and shutdown.

- [ ] **Step 2: Run RunService tests and verify missing methods**

Run: `node --test test/run-service.test.mjs`

Expected: FAIL because `steer` and `stop` are undefined.

- [ ] **Step 3: Refactor launch into two explicit execution paths**

```js
const execution = definition.createInteractiveSession
  ? await launchInteractive({ definition, launchTarget, queued, signal, logs })
  : await launchOneShot({ definition, launchTarget, queued, signal, logs })
```

Store `{ controller, promise, session }` in `active`. RunService creates runtime events with the existing monotonic sequence, derives the public Turn revision from driver events, and finalizes both paths through one `completeRun()` function. `steer()` and `stop()` re-read the durable Run, validate the active record and exact revision, then call the session behavior.

- [ ] **Step 4: Run RunService and Run store regression tests**

Run: `node --test test/run-service.test.mjs test/run-store.test.mjs test/run-event-hub.test.mjs test/process-supervisor.test.mjs`

Expected: PASS with both interactive and one-shot paths.

- [ ] **Step 5: Verify the Run ledger remains transcript-free**

Run: `rg -n "assistant_delta|intervention|prompt|transcript" server/src/runs/run-store.mjs server/src/scheduler/scheduler-migration.mjs`

Expected: no new transcript or intervention persistence column/table; the existing immutable Schedule snapshot remains the only prompt-bearing Run input and is never returned by `publicRun()`.

### Task 4: Typed control API and Run SSE contract

**Files:**
- Modify: `server/src/api-server.mjs`
- Modify: `server/src/runs/run-event-hub.mjs`
- Test: `test/run-api.test.mjs`
- Test: `test/run-event-hub.test.mjs`

**Interfaces:**
- Consumes: `runService.steer()` and `runService.stop()`.
- Produces: `POST /api/v1/runs/:id/steer`, `POST /api/v1/runs/:id/stop`, and existing `GET /api/v1/runs/:id/events` with deterministic reset.
- Input shapes: `{ expected_turn_revision: integer, text: string }` and `{ expected_turn_revision: integer }`.

- [ ] **Step 1: Write failing API contract tests**

```js
const response = await request('/api/v1/runs/run-1/steer', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ expected_turn_revision: 3, text: 'Inspect the schema first.' }),
})
assert.equal(response.status, 202)
assert.deepEqual(serviceCalls.steer, [{
  runId: 'run-1', input: { expected_turn_revision: 3, text: 'Inspect the schema first.' },
}])
```

Assert exact-body rejection, empty/whitespace text, Boolean or unsafe revision, over-16-KiB UTF-8 body, stale Turn 409, non-steerable 409, protocol unavailable 503, no text echo in success/error, stop 202/idempotency, and SSE `after`/`Last-Event-ID` reset behavior. Run Event Hub tests must prove a gap is reported when its first retained sequence exceeds `after + 1` and when `after > 0` but the retained buffer is absent.

- [ ] **Step 2: Run API tests and verify route failure**

Run: `node --test test/run-api.test.mjs`

Expected: FAIL with 404 or route-not-found for steer/stop.

- [ ] **Step 3: Add strict validators and routes**

```js
const runControl = pathname.match(/^\/api\/v1\/runs\/([^/]+)\/(steer|stop)$/)
if (request.method === 'POST' && runControl && runService) {
  requireJson(request)
  const runId = safeSegment(runControl[1])
  const input = validateRunControl(runControl[2], await readJson(request, {
    limit: 16 * 1024 + 256,
  }))
  const result = runControl[2] === 'steer'
    ? await runService.steer(runId, input)
    : await runService.stop(runId, input)
  sendJson(response, 202, result)
  return
}
```

Use the existing `readJson(request, { limit })` API and a narrowly named `RUN_INTERVENTION_BODY_LIMIT` constant. Extend `statusFor()` and `PUBLIC_SERVICE_ERRORS` only for the stable codes in the design. Change `eventHub.subscribe()` to return replay metadata `{ unsubscribe, resetRequired }`; API emits exactly one reset event before replay/live delivery when `resetRequired` is true.

- [ ] **Step 4: Run API and HTTP utility tests**

Run: `node --test test/run-api.test.mjs test/run-event-hub.test.mjs test/api-server.test.mjs test/http-utils.test.mjs`

Expected: PASS; if either latter file does not exist, run only existing files reported by `rg --files test`.

- [ ] **Step 5: Confirm response redaction**

Run: `node --test --test-name-pattern="steer|stop|intervention|Turn" test/run-api.test.mjs`

Expected: PASS and assertions prove response bodies never contain submitted guidance.

### Task 5: Dashboard Run SSE client

**Files:**
- Create: `ui/src/run-event-stream.mjs`
- Modify: `ui/src/dashboard-api.mjs`
- Test: `test/run-event-stream.test.mjs`
- Test: `test/scheduled-dashboard-api.test.mjs`

**Interfaces:**
- Consumes: native `EventSource`, Run event URL, callbacks.
- Produces: `createRunEventStream({ runId, baseUrl, createSource, onEvent, onReset, onState })` returning `{ connect(), close(), sequence() }`.
- Dashboard API produces `steerRun(id, { expected_turn_revision, text })` and `stopRun(id, { expected_turn_revision })`.

- [ ] **Step 1: Write failing stream/client tests**

```js
const stream = createRunEventStream({
  runId: 'run-1', createSource: (url) => new FakeEventSource(url),
  onEvent: events.push.bind(events), onReset: () => resets += 1,
  onState: states.push.bind(states),
})
stream.connect()
source.dispatch('run', { lastEventId: '7', data: JSON.stringify(event) })
assert.equal(stream.sequence(), 7)
source.fail()
assert.match(createdUrls.at(-1), /after=7/)
```

Assert malformed/foreign Run events are ignored, reset callback, explicit reconnect, close cancels reconnect, one source at a time, and API request bodies use only typed fields.

- [ ] **Step 2: Run tests and verify module/method absence**

Run: `node --test test/run-event-stream.test.mjs test/scheduled-dashboard-api.test.mjs`

Expected: FAIL because the stream module and API methods do not exist.

- [ ] **Step 3: Implement the minimal client**

```js
steerRun: (id, input) => request(`/api/v1/runs/${encodeURIComponent(id)}/steer`, {
  method: 'POST', body: input,
}),
stopRun: (id, input) => request(`/api/v1/runs/${encodeURIComponent(id)}/stop`, {
  method: 'POST', body: input,
}),
```

The stream owns its reconnect cursor and lifecycle; it does not use the global invalidation stream and never persists message content to storage.

- [ ] **Step 4: Run stream and Dashboard API tests**

Run: `node --test test/run-event-stream.test.mjs test/scheduled-dashboard-api.test.mjs`

Expected: PASS.

- [ ] **Step 5: Validate browser-only code remains buildable**

Run: `node --check ui/src/run-event-stream.mjs && node --check ui/src/dashboard-api.mjs`

Expected: exit 0.

### Task 6: Live Session Run Review UI

**Files:**
- Modify: `ui/src/scheduled-run-review.mjs`
- Modify: `ui/src/dashboard.css`
- Modify: `ui/src/index.html` only if the existing sheet lacks a stable live-region/container hook.
- Test: `test/scheduled-run-review.test.mjs`
- Test: `test/dashboard-build.test.mjs`

**Interfaces:**
- Consumes: `api.steerRun`, `api.stopRun`, and `createRunEventStream`.
- Produces: Live Session state `{ connection, turnRevision, messages, activities, draft, submitting, controlError }` scoped to the selected active Run.
- Existing history table, logs, review, copy Session ID, and Terminal Resume remain available.

- [ ] **Step 1: Write failing reducer/controller tests**

```js
stream.emit({ type: 'turn_started', payload: { turn_revision: 1 } })
stream.emit({ type: 'assistant_delta', payload: {
  turn_revision: 1, item_id: 'message-1', delta: 'Inspecting',
} })
stream.emit({ type: 'assistant_delta', payload: {
  turn_revision: 1, item_id: 'message-1', delta: ' the schema.',
} })
assert.match(current.innerHTML, /Inspecting the schema\./)
assert.match(current.innerHTML, /data-run-review-action="steer"/)
```

Cover event ordering, per-item delta append, activity start/completion update, unknown activity, stream reset, selection/close teardown, long content escaping, composer enable rules, `Cmd+Enter`/`Ctrl+Enter`, plain Enter, accepted submit clearing draft, rejected submit retaining draft, Stop, completed fallback, and focus restoration.

- [ ] **Step 2: Run UI tests and verify failure**

Run: `node --test test/scheduled-run-review.test.mjs test/dashboard-build.test.mjs`

Expected: FAIL because Run Review does not create a Run event stream or render Live Session controls.

- [ ] **Step 3: Add Live Session state and behavior**

```js
function emptyLiveState() {
  return {
    connection: 'idle', turnRevision: null,
    messages: [], activities: [], draft: '',
    submitting: false, stopping: false, controlError: '',
  }
}
```

Create a stream only for the currently selected `queued` or `running` Run with `interactive === true`. Close it before selection changes, sheet close, and destroy. Keep DOM event delegation; add an `input` handler for the draft and submit handler that passes the exact current revision.

- [ ] **Step 4: Implement restrained production CSS**

```css
.scheduled-live-session{display:grid;min-height:0;grid-template-rows:auto minmax(0,1fr) auto}
.scheduled-live-stream{min-height:0;overflow:auto;padding:18px 20px 28px}
.scheduled-live-activity{border-top:1px solid var(--border-soft);color:var(--meta)}
.scheduled-live-composer{position:sticky;bottom:0;padding:12px 20px calc(12px + env(safe-area-inset-bottom));border-top:1px solid var(--border);background:color-mix(in oklab,#111215 94%,transparent)}
```

Use existing design tokens, 44px minimum mobile controls, visible `:focus-visible`, no horizontal overflow, no decorative status rail or micro-heading, and a `prefers-reduced-motion: reduce` rule.

- [ ] **Step 5: Run UI and build tests**

Run: `node --test test/scheduled-run-review.test.mjs test/dashboard-build.test.mjs test/scheduled-tasks-ui.test.mjs && npm run build`

Expected: PASS and `ui/dist/index.html` contains the updated bundled Live Session UI.

### Task 7: Composition, end-to-end behavior, docs, and visual verification

**Files:**
- Modify: `server/src/taskd-runtime.mjs`
- Modify: `test/taskd-runtime.test.mjs`
- Modify: `test/scheduled-runtime-e2e.test.mjs`
- Modify: `README.md`
- Modify: `docs/architecture.md`
- Modify: `docs/job/tasks-recorder-scheduled-tasks/04-test-plan.md`
- Modify: `docs/job/tasks-recorder-scheduled-tasks/06-test-report.md`

**Interfaces:**
- Consumes: Codex interactive session factory, RunService, taskd API, Dashboard bundle.
- Produces: one source `taskd` process that can execute, stream, steer, stop, recover, and report protocol failures without disabling Scheduled Tasks.

- [ ] **Step 1: Write failing composition and fixture end-to-end tests**

```js
assert.equal(createdCodexDefinition.capabilities.interactiveSession, true)
assert.equal(runServiceOptions.registry, runtimeRegistry)
assert.equal(interactiveFactoryOptions.runtimeEnvironment, runtimeEnvironment)
```

The end-to-end fixture must prove: Markdown Schedule → manual Run → initialize/thread/Turn → assistant delta SSE → steer request → completion → durable terminal facts, while querying SQLite confirms guidance and assistant text are absent.

- [ ] **Step 2: Run composition/e2e tests and verify missing wiring**

Run: `node --test test/taskd-runtime.test.mjs test/scheduled-runtime-e2e.test.mjs`

Expected: FAIL until the interactive factory is composed.

- [ ] **Step 3: Wire one shared Runtime Environment through the factory**

```js
const codexRuntime = createCodexRuntime({
  execFileImpl: runtimeExecFile,
  runtimeEnvironment,
})
runtimeRegistry = createRuntimeRegistry({
  definitions: [codexRuntime], resolver: runtimeResolver,
})
```

Do not create another resolver, database, server, or long-lived service. A protocol capability failure must fail only that Run and keep `schedulerState.ready === true`.

- [ ] **Step 4: Run the focused implementation suite**

Run: `node --test test/codex-app-server-client.test.mjs test/codex-interactive-session.test.mjs test/codex-runtime-adapter.test.mjs test/run-service.test.mjs test/run-api.test.mjs test/run-event-stream.test.mjs test/scheduled-dashboard-api.test.mjs test/scheduled-run-review.test.mjs test/taskd-runtime.test.mjs test/scheduled-runtime-e2e.test.mjs`

Expected: PASS.

- [ ] **Step 5: Scan and update documentation**

Run: `git diff --name-only HEAD && find . -name "*.md" -not -path "*/node_modules/*" -not -path "*/.git/*"`

Update every live document that describes Runtime execution, Run Review, privacy, taskd health, or manual verification. README must explain that only taskd-launched active Codex Runs stream and steer; external hook-observed sessions do not expose transcript content. Maintenance docs must include `tasks-recorder status`, runtime capability inspection, a real Live Session smoke procedure, protocol failure codes, and fallback to Terminal Resume.

- [ ] **Step 6: Run full repository verification**

Run: `npm run build && npm run build:adapters && npm run check && npm test && git diff --check`

Expected: all commands exit 0. Record the exact test count and any environment-only skip.

- [ ] **Step 7: Run Playwright MCP visual verification**

Start the source dev stack using the repository's documented source command. With `playwright-headless`, validate at minimum:

```text
1440×1000: active stream, mixed activity, long assistant text, successful steer, stop
390×844: full-height sheet, composer visible, 44px controls, no x-overflow
both: reconnect, typed steer rejection, succeeded and failed terminal states
keyboard: Tab order, Escape close, Cmd/Ctrl+Enter submit, focus restoration
accessibility: visible focus, live status does not announce every token, reduced motion
```

Capture screenshots for any visual defect, fix the root cause, rerun the affected state, and retain only final evidence in the task report.

- [ ] **Step 8: Inspect the final scoped diff**

Run: `git status --short && git diff --stat && git diff --check`

Expected: only intended implementation/docs plus pre-existing branch work; no temporary protocol schemas, screenshots, transcript files, or unrelated formatting churn.
