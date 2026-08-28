# Runtime Agent Registry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the independent Scheduled runner chain with an OpenDesign-style multi-CLI runtime registry, direct taskd process orchestration, a single durable Run lifecycle, and an internal wall-clock scheduler.

**Architecture:** `taskd` remains the sole local daemon and SQLite writer. A registry discovers local agent CLIs and supplies runtime-specific probes, model discovery, invocation building, and event parsing; shared services own process supervision, Run persistence, scheduling, HTTP/SSE, and UI state. Codex is the only adapter in this cutover, while all scheduler and Dashboard contracts use a stable runtime ID.

**Tech Stack:** Node.js 24 ESM, built-in `node:child_process`, built-in `node:sqlite`, HTTP/SSE, React 19, esbuild, Node test runner, macOS launchd for the taskd service only.

**Spec:** `docs/superpowers/specs/2026-08-27-runtime-agent-registry-design.md`

## Global Constraints

- Tasks 1–12 work only in `/Users/joi-com/Desktop/space/projects/tasks-recorder/.worktree/feature-scheduled-tasks`; verify `git rev-parse --show-toplevel` before every phase.
- Task 13 public-documentation edits use `/Users/joi-com/Desktop/space/projects/tasks-recorder/.worktree/docs-public-documentation` only after verifying its branch/path mapping. Never edit public-documentation paths through the feature worktree.
- Preserve all pre-existing dirty changes. Stage or commit only files from the current task, and do not create any commit without explicit owner authorization.
- Use TDD: add one focused failing test, prove the expected failure, implement the smallest passing behavior, then run the focused suite.
- `taskd` remains the only SQLite writer and the only long-lived Tasks Recorder process.
- Runtime probes and Runs use argv arrays with `shell: false`; probes run in a private temporary cwd.
- Schedule definitions remain Markdown; SQLite stores Run facts and immutable execution snapshots.
- Codex is the only delivered adapter. Do not add dynamic third-party adapter loading or speculative ACP infrastructure.
- Manual and scheduled execution must enter the same `RunService.create()` path.
- Do not keep the legacy runner active beside the new direct supervisor.
- A missing runtime or model catalog is a typed capability state, never a missing HTTP route.
- The source Dashboard must not connect silently to an incompatible source or installed taskd.

## File structure

New runtime files:

- `server/src/runtime/runtime-errors.mjs`: stable runtime and Run error constructors.
- `server/src/runtime/executable-resolver.mjs`: shared candidate discovery, canonicalization, and version probes.
- `server/src/runtime/runtime-agent-registry.mjs`: immutable runtime definitions, detection cache, refresh, and normalized status.
- `server/src/runtime/process-supervisor.mjs`: spawn, input, timeout, cancellation, output bounds, and exit.
- `server/src/runtime/runtime-event.mjs`: common normalized event envelope and payload bounds.
- `server/src/runtime/adapters/codex.mjs`: Codex definition, models, invocation, capabilities, and session extraction.
- `server/src/runtime/parsers/codex-jsonl.mjs`: Codex JSONL to normalized Run events.

New Run and scheduling files:

- `server/src/runs/run-store.mjs`: schema-v4 Run ledger, lifecycle mutations, occurrence dedupe, review, and queries.
- `server/src/runs/run-event-hub.mjs`: bounded per-Run SSE replay buffer and subscribers.
- `server/src/runs/run-service.mjs`: durable create, asynchronous launch, cancel, complete, recovery, and read model.
- `server/src/scheduler/scheduler-clock.mjs`: periodic wall-clock due/catch-up planning.
- `server/src/scheduler/legacy-launchd-cleanup.mjs`: one-shot removal of Tasks Recorder-owned per-Schedule LaunchAgents.
- `scripts/dev.mjs`: one-process development supervisor for isolated source taskd plus live Dashboard.

Existing files retained and changed:

- `server/src/scheduler/cadence.mjs`: expose the latest due occurrence calculation.
- `server/src/scheduler/schedule-definition-codec.mjs`: add normalized `agent` field with legacy default `codex`.
- `server/src/scheduler/schedule-definition-repository.mjs`: preserve the new field through atomic writes.
- `server/src/scheduler/scheduled-run-logs.mjs`: become taskd-owned Run log storage.
- `server/src/scheduler/scheduler-migration.mjs`: transactional v3-to-v4 ledger migration.
- `server/src/taskd-runtime.mjs`: compose registry, RunService, scheduler clock, and direct supervisor.
- `server/src/api-server.mjs`: runtime, Run, meta, log, review, cancel, and resume routes.
- `server/src/session-resume-service.mjs`: resolve unified Run session targets.
- `ui/src/dashboard-api.mjs`: runtime and unified Run clients.
- `ui/src/scheduled-task-editor.mjs`: runtime-aware agent/model/reasoning controls.
- `ui/src/scheduled-tasks.mjs`: durable queued/running/terminal list state.
- `ui/src/scheduled-run-review.mjs`: unified Run detail, logs, artifacts, Session ID, and Resume.
- `ui/src/dashboard.mjs`: runtime bootstrap and service compatibility gate.
- `ui/src/dashboard.css`: runtime/run states without alert-like status prose.
- `ui/dev-gateway.mjs` and `ui/dev-runtime.mjs`: dev parent integration and compatibility diagnostics.
- `package.json`: add `npm run dev`.

Legacy files deleted only after the replacement path passes integration tests:

- `server/scheduled-runner.mjs`
- `server/src/scheduler/launchd-backend.mjs`
- `server/src/scheduler/runner-completion-evidence.mjs`
- `server/src/scheduler/runner-lock.mjs`
- `server/src/scheduler/runner-protocol.mjs`
- `server/src/scheduler/runner-spool.mjs`
- their dedicated tests

---

### Task 1: Runtime definition registry and executable resolver

**Files:**
- Create: `server/src/runtime/runtime-errors.mjs`
- Create: `server/src/runtime/executable-resolver.mjs`
- Create: `server/src/runtime/runtime-agent-registry.mjs`
- Test: `test/runtime-executable-resolver.test.mjs`
- Test: `test/runtime-agent-registry.test.mjs`

**Interfaces:**
- Produces: `runtimeError(code, message, details?)`.
- Produces: `createExecutableResolver(options).resolve(definition) -> Promise<ResolvedLaunch>`.
- Produces: `createRuntimeAgentRegistry({ definitions, resolver, clock, ttlMs })`.
- Registry methods: `list()`, `get(id)`, `resolve(id, { refresh = false })`, `models(id, { refresh = false })`, and `refresh(id?)`.
- `ResolvedLaunch` is `{ runtime_id, executable, version, source }`.
- `RuntimeStatus` is `{ id, display_name, state, launch, auth, capabilities, models_source, error_code }`.

- [x] **Step 1: Write resolver tests for candidate precedence and broken shims**

```js
test('resolver skips a broken override and selects the next probed candidate', async () => {
  const resolver = createExecutableResolver({
    env: { CODEX_BIN: '/broken/codex', PATH: '/tools/bin' },
    candidatePaths: () => ['/tools/bin/codex'],
    canonicalize: async (path) => path,
    probe: async (path) => path === '/tools/bin/codex'
      ? { version: 'codex-cli 0.150.0' }
      : null,
  })
  assert.deepEqual(await resolver.resolve(CODEX_DEF), {
    runtime_id: 'codex',
    executable: '/tools/bin/codex',
    version: 'codex-cli 0.150.0',
    source: 'path',
  })
})
```

- [x] **Step 2: Run the resolver test and prove the module is missing**

Run: `node --test test/runtime-executable-resolver.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `server/src/runtime/executable-resolver.mjs`.

- [x] **Step 3: Implement bounded candidate collection and probing**

```js
export function createExecutableResolver({
  env = process.env,
  candidatePaths,
  canonicalize,
  probe,
  maximumCandidates = 8,
} = {}) {
  return {
    async resolve(definition) {
      const candidates = collectCandidates(definition, {
        env,
        candidatePaths,
        maximumCandidates,
      })
      for (const candidate of candidates) {
        const executable = await canonicalize(candidate.path).catch(() => null)
        if (!executable) continue
        const result = await probe(executable, definition.versionProbe).catch(() => null)
        if (result) {
          return {
            runtime_id: definition.id,
            executable,
            version: result.version,
            source: candidate.source,
          }
        }
      }
      throw runtimeError('RUNTIME_UNAVAILABLE', 'Runtime executable is unavailable', {
        runtime_id: definition.id,
      })
    },
  }
}
```

- [x] **Step 4: Add registry tests for duplicate IDs, isolated failures, cache, and refresh**

```js
test('registry reports one unavailable runtime without hiding healthy runtimes', async () => {
  const registry = createRuntimeAgentRegistry({
    definitions: [CODEX_DEF, CLAUDE_DEF],
    resolver: {
      resolve: async ({ id }) => {
        if (id === 'claude') throw runtimeError('RUNTIME_UNAVAILABLE', 'missing')
        return { runtime_id: id, executable: '/bin/codex', version: '1', source: 'path' }
      },
    },
    ttlMs: 300_000,
  })
  const statuses = await registry.list()
  assert.equal(statuses.find(({ id }) => id === 'codex').state, 'ready')
  assert.equal(statuses.find(({ id }) => id === 'claude').state, 'unavailable')
})
```

- [x] **Step 5: Implement immutable definitions and status caching**

The registry must reject duplicate/unsafe IDs, freeze definitions, run detection independently with `Promise.all`, return a status for every definition, and invalidate one or all entries through `refresh(id?)`.

- [x] **Step 6: Run focused tests**

Run: `node --test test/runtime-executable-resolver.test.mjs test/runtime-agent-registry.test.mjs`

Expected: PASS.

- [x] **Step 7: Review checkpoint**

Inspect `git diff -- server/src/runtime test/runtime-*`. Do not commit without explicit owner authorization.

### Task 2: Codex runtime adapter and normalized event parser

**Files:**
- Create: `server/src/runtime/adapters/codex.mjs`
- Create: `server/src/runtime/parsers/codex-jsonl.mjs`
- Create: `server/src/runtime/runtime-event.mjs`
- Modify: `server/src/scheduler/codex-jsonl.mjs`
- Modify: `test/codex-jsonl.test.mjs`
- Modify: `test/codex-model-catalog.test.mjs`
- Create: `test/codex-runtime-adapter.test.mjs`

**Interfaces:**
- Consumes: `RuntimeAgentDef` and `ResolvedLaunch` from Task 1.
- Produces: `createCodexRuntimeDefinition()`.
- Produces: `parseCodexJsonLine(line, context) -> RuntimeEvent[]`.
- Produces: `runtimeEvent({ runId, sequence, observedAt, type, payload })`.
- `buildInvocation({ launch, run })` returns `{ command, args, cwd, stdin, env, timeout_ms }`.

- [x] **Step 1: Write Codex definition tests**

```js
test('Codex definition uses the same resolved executable for models and Runs', async () => {
  const definition = createCodexRuntimeDefinition()
  const launch = {
    runtime_id: 'codex',
    executable: '/opt/codex',
    version: 'codex-cli 0.150.0',
    source: 'path',
  }
  const invocation = await definition.buildInvocation({
    launch,
    run: RUN_SNAPSHOT,
  })
  assert.equal(invocation.command, '/opt/codex')
  assert.deepEqual(invocation.args.slice(0, 3), ['exec', '--json', '--color'])
  assert.equal(invocation.stdin, RUN_SNAPSHOT.prompt)
})
```

- [x] **Step 2: Run and prove the adapter does not exist**

Run: `node --test test/codex-runtime-adapter.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [x] **Step 3: Implement the Codex definition**

```js
export function createCodexRuntimeDefinition() {
  return Object.freeze({
    id: 'codex',
    displayName: 'Codex',
    launch: {
      overrideEnv: 'CODEX_BIN',
      executableNames: Object.freeze(['codex']),
      packagedCandidates: Object.freeze([]),
      platformResolvers: Object.freeze(['codex-app']),
    },
    versionProbe: Object.freeze({ args: ['--version'], timeout_ms: 5_000 }),
    fallbackModels: Object.freeze([{
      id: 'default',
      displayName: 'Default (CLI config)',
      reasoningLevels: [],
    }]),
    streamFormat: 'codex-jsonl',
    capabilities: Object.freeze({
      modelSelection: true,
      reasoning: true,
      sessionResume: true,
      sandbox: true,
    }),
    fetchModels,
    buildInvocation,
    parseEvent: parseCodexJsonLine,
  })
}
```

`fetchModels` must execute `launch.executable` with `['debug', 'models']`, filter `visibility === 'list'`, return normalized entries, and return `{ source: 'fallback', models }` on bounded probe failure.

Registry listing deliberately does not execute an auth probe. Authentication is verified by the real Run and persisted as a typed failure; runtime/model discovery therefore cannot block daemon readiness on mutable login state.

- [x] **Step 4: Port the existing Codex JSONL cases to normalized events**

Include these exact parser cases:

```js
assert.deepEqual(events.at(-1), {
  runId: RUN_ID,
  sequence: 4,
  observedAt: '2026-08-27T00:00:00.000Z',
  type: 'session',
  payload: { session_id: SESSION_ID },
})
```

Successful file-change events must remain Workspace-relative and bounded. Unknown events return an empty array instead of throwing the Run into a false terminal state.

- [x] **Step 5: Keep a temporary compatibility re-export**

Until Task 8 removes the old runner, make `server/src/scheduler/codex-jsonl.mjs` re-export the parser functions required by legacy tests. Do not duplicate parsing logic.

- [x] **Step 6: Run focused adapter and parser tests**

Run: `node --test test/codex-runtime-adapter.test.mjs test/codex-jsonl.test.mjs test/codex-model-catalog.test.mjs`

Expected: PASS.

- [x] **Step 7: Review checkpoint**

Verify that the adapter contains no HTTP, SQLite, cadence, or UI imports. Do not commit without explicit owner authorization.

### Task 3: Schema-v4 unified Run ledger

**Files:**
- Create: `server/src/runs/run-store.mjs`
- Modify: `server/src/scheduler/scheduler-schema.mjs`
- Modify: `server/src/scheduler/scheduler-migration.mjs`
- Create: `test/run-store.test.mjs`
- Modify: `test/scheduler-migration.test.mjs`

**Interfaces:**
- Produces: `createRunStore({ databasePath, clock, createId })`.
- Produces methods: `create`, `markRunning`, `complete`, `cancelQueued`, `interruptOpen`, `get`, `list`, `markReviewed`, `hasOccurrence`.
- `create(input)` accepts `{ schedule, runtime_id, origin, occurrence_key, scheduled_for, idempotency_key }`.
- `RunStatus` is `queued | running | succeeded | failed | timed_out | canceled | interrupted`.

- [x] **Step 1: Write lifecycle and uniqueness tests**

```js
test('Run creation is durable before launch and deduplicates an occurrence', () => {
  const first = store.create({
    schedule: SCHEDULE_SNAPSHOT,
    runtime_id: 'codex',
    origin: 'scheduled',
    occurrence_key: '2026-08-27T09:30+08:00',
    scheduled_for: '2026-08-27T01:30:00.000Z',
    idempotency_key: null,
  })
  assert.equal(first.status, 'queued')
  assert.throws(() => store.create({
    schedule: SCHEDULE_SNAPSHOT,
    runtime_id: 'codex',
    origin: 'catchup',
    occurrence_key: first.occurrence_key,
    scheduled_for: first.scheduled_for,
    idempotency_key: null,
  }), { code: 'RUN_OCCURRENCE_EXISTS' })
})
```

Also prove:

- a second queued/running Run for one Schedule fails with `RUN_ALREADY_ACTIVE`;
- repeating one manual `idempotency_key` returns the existing Run instead of creating another row;
- reusing one manual `idempotency_key` for a different Schedule fails with `RUN_IDEMPOTENCY_CONFLICT`;
- terminal completion clears the active constraint;
- `interruptOpen()` changes queued/running to interrupted;
- review is monotonic;
- the immutable snapshot includes the prompt but `list()` can omit it.

- [x] **Step 2: Run and prove schema v4 is absent**

Run: `node --test test/run-store.test.mjs`

Expected: FAIL because `createRunStore` or schema v4 does not exist.

- [x] **Step 3: Define schema v4**

The migration creates a replacement `scheduled_runs` table with:

```sql
id TEXT PRIMARY KEY,
schedule_id TEXT NOT NULL,
definition_etag TEXT NOT NULL,
runtime_id TEXT NOT NULL,
origin TEXT NOT NULL CHECK(origin IN ('manual','scheduled','catchup')),
occurrence_key TEXT,
idempotency_key TEXT,
scheduled_for TEXT,
status TEXT NOT NULL CHECK(status IN (
  'queued','running','succeeded','failed','timed_out','canceled','interrupted'
)),
snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
runtime_version TEXT,
executable_digest TEXT,
pid INTEGER,
session_id TEXT,
created_at TEXT NOT NULL,
started_at TEXT,
finished_at TEXT,
exit_code INTEGER,
error_code TEXT,
final_message TEXT,
usage_json TEXT CHECK(usage_json IS NULL OR json_valid(usage_json)),
file_changes_json TEXT CHECK(file_changes_json IS NULL OR json_valid(file_changes_json)),
stdout_log_path TEXT,
stderr_log_path TEXT,
reviewed_at TEXT,
updated_at TEXT NOT NULL
```

Add:

```sql
CREATE UNIQUE INDEX scheduled_runs_occurrence
ON scheduled_runs(schedule_id, occurrence_key)
WHERE occurrence_key IS NOT NULL;

CREATE UNIQUE INDEX scheduled_runs_idempotency
ON scheduled_runs(idempotency_key)
WHERE idempotency_key IS NOT NULL;

CREATE UNIQUE INDEX scheduled_runs_one_active
ON scheduled_runs(schedule_id)
WHERE status IN ('queued', 'running');
```

- [x] **Step 4: Implement the transactional v3-to-v4 migration**

Map legacy terminal states directly. Map `claimed` to `interrupted`; map legacy non-terminal `running` to `interrupted`; preserve logs, Session ID, review, file changes, and final message. Pending dispatch rows are intentionally not converted to Runs. Set `PRAGMA user_version = 4` only after invariant checks pass.

- [x] **Step 5: Implement Run store transitions**

Every mutation uses a transaction and verifies the current state:

```js
const TRANSITIONS = Object.freeze({
  queued: new Set(['running', 'failed', 'canceled', 'interrupted']),
  running: new Set(['succeeded', 'failed', 'timed_out', 'canceled', 'interrupted']),
})
```

Invalid transitions throw `RUN_STATE_CONFLICT` without changing the row.

- [x] **Step 6: Run store and migration tests**

Run: `node --test test/run-store.test.mjs test/scheduler-migration.test.mjs`

Expected: PASS, including rollback on malformed legacy rows.

- [x] **Step 7: Review checkpoint**

Inspect the migration SQL and verify terminal history preservation. Do not run it against the user's real database during this task. Do not commit without explicit owner authorization.

### Task 4: Shared process supervisor and event hub

**Files:**
- Create: `server/src/runtime/process-supervisor.mjs`
- Create: `server/src/runs/run-event-hub.mjs`
- Test: `test/process-supervisor.test.mjs`
- Test: `test/run-event-hub.test.mjs`

**Interfaces:**
- Produces: `createProcessSupervisor({ spawnImpl, clock, setTimer, clearTimer })`.
- Produces: `supervisor.start({ invocation, parseEvent, emit, onSpawn, signal }) -> Promise<ProcessResult>`.
- `ProcessResult` is `{ status, exit_code, error_code, duration_ms, session_id, final_message, usage, file_changes }`.
- Produces: `createRunEventHub({ maximumEventsPerRun }).publish(event)`, `.subscribe(runId, listener, { afterSequence })`, and `.close()`.

- [x] **Step 1: Write supervisor tests for success, timeout, cancel, malformed output, and spawn error**

```js
test('supervisor normalizes a successful process without shell execution', async () => {
  const spawnCalls = []
  const supervisor = createProcessSupervisor({
    spawnImpl(command, args, options) {
      spawnCalls.push({ command, args, options })
      return fakeChild({ stdout: ['{\"type\":\"done\"}\\n'], code: 0 })
    },
  })
  const result = await supervisor.start({
    invocation: INVOCATION,
    parseEvent: parseFakeEvent,
    emit: () => {},
    onSpawn: () => {},
    signal: new AbortController().signal,
  })
  assert.equal(spawnCalls[0].options.shell, false)
  assert.equal(result.status, 'succeeded')
})
```

- [x] **Step 2: Run and prove the supervisor is absent**

Run: `node --test test/process-supervisor.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [x] **Step 3: Implement process supervision**

Use `spawn(command, args, { cwd, env, shell: false, stdio: ['pipe','pipe','pipe'] })`. Call `onSpawn({ pid: child.pid })` only after the child emits `spawn`. Write stdin once, close it, split stdout as bounded lines, call the adapter parser, emit normalized events, collect bounded summaries, and settle exactly once.

Cancellation sequence:

1. abort signal sends `SIGINT`;
2. start a 2-second force timer;
3. still-running child receives `SIGKILL`;
4. final state is `canceled`, not `failed`.

Timeout uses the same termination path but final state `timed_out`.

- [x] **Step 4: Write event-hub replay tests**

```js
test('event hub replays only events after the requested sequence', () => {
  hub.publish(event(1))
  hub.publish(event(2))
  const received = []
  const unsubscribe = hub.subscribe(RUN_ID, (value) => received.push(value), {
    afterSequence: 1,
  })
  assert.deepEqual(received.map(({ sequence }) => sequence), [2])
  unsubscribe()
})
```

- [x] **Step 5: Implement bounded per-Run replay**

Retain no more than 256 normalized events per active Run. Evict terminal Run buffers after all subscribers disconnect and the configured retention expires. Never persist prompt or raw environment data in the hub.

- [x] **Step 6: Run focused tests**

Run: `node --test test/process-supervisor.test.mjs test/run-event-hub.test.mjs`

Expected: PASS with no leaked fake child handles.

- [x] **Step 7: Review checkpoint**

Confirm every settle path removes timers and listeners. Do not commit without explicit owner authorization.

### Task 5: Durable RunService

**Files:**
- Create: `server/src/runs/run-service.mjs`
- Test: `test/run-service.test.mjs`
- Modify: `server/src/scheduler/scheduled-run-logs.mjs`
- Modify: `test/scheduled-run-logs.test.mjs`

**Interfaces:**
- Consumes: registry from Task 1, Codex adapter from Task 2, Run store from Task 3, supervisor and event hub from Task 4.
- Produces: `createRunService(dependencies)`.
- Methods: `create`, `get`, `list`, `latestOccurrence`, `cancel`, `markReviewed`, `events`, `recover`, `whenIdle`, and `shutdown`.
- `create({ schedule, origin, occurrence_key, scheduled_for, idempotency_key }) -> Promise<{ run }>` returns after the queued row commits, while launch continues asynchronously.

- [x] **Step 1: Write a test proving commit-before-spawn**

```js
test('RunService returns a queued Run before runtime resolution settles', async () => {
  const resolution = deferred()
  registry.resolve = () => resolution.promise
  const result = await service.create({
    schedule: SCHEDULE,
    origin: 'manual',
    occurrence_key: null,
    scheduled_for: null,
    idempotency_key: '33333333-3333-4333-8333-333333333333',
  })
  assert.equal(result.run.status, 'queued')
  assert.equal(runStore.get(result.run.id).status, 'queued')
  resolution.resolve(RESOLVED_CODEX)
  await service.whenIdle()
  assert.equal(runStore.get(result.run.id).status, 'succeeded')
})
```

- [x] **Step 2: Run and prove RunService is absent**

Run: `node --test test/run-service.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [x] **Step 3: Implement asynchronous launch**

```js
async function create(input) {
  const run = runStore.create(snapshot(input))
  queueMicrotask(() => {
    launch(run.id).catch((error) => finishLaunchFailure(run.id, error))
  })
  onChange({ kind: 'run', id: run.id })
  return { run: publicRun(run) }
}
```

`launch` re-reads the immutable snapshot, resolves the runtime, builds the invocation, opens trusted logs, passes `onSpawn` to the supervisor, marks running only from that callback, streams events, and completes the Run once.

- [x] **Step 4: Add failure and recovery tests**

Cover:

- runtime unavailable → queued to failed with `RUNTIME_UNAVAILABLE`;
- model probe fallback does not prevent a default-model Run;
- spawn error → `RUN_SPAWN_FAILED`;
- cancel queued and cancel running;
- timeout;
- taskd startup → `recover()` marks open rows interrupted;
- completion preserves Session ID and file changes;
- repeated completion cannot overwrite a terminal Run.

- [x] **Step 5: Make logs daemon-owned**

Update `scheduled-run-logs.mjs` so RunService opens and closes stdout/stderr streams directly. Remove assumptions that a separate runner publishes relative paths after completion. Keep current private directory and bounded-retention checks.

- [x] **Step 6: Run focused tests**

Run: `node --test test/run-service.test.mjs test/scheduled-run-logs.test.mjs`

Expected: PASS.

- [x] **Step 7: Review checkpoint**

Confirm that `RunService` contains no launchd, Unix socket, or spool imports. Do not commit without explicit owner authorization.

### Task 6: Runtime, Run, and compatibility HTTP APIs

**Files:**
- Modify: `server/src/api-server.mjs`
- Modify: `server/src/taskd-runtime.mjs`
- Modify: `ui/src/dashboard-api.mjs`
- Create: `test/runtime-api.test.mjs`
- Create: `test/run-api.test.mjs`
- Modify: `test/api-server.test.mjs`
- Modify: `test/scheduled-dashboard-api.test.mjs`

**Interfaces:**
- Consumes: runtime registry and RunService.
- Produces: `/api/v1/meta`, `/api/v1/runtimes`, `/api/v1/runtimes/refresh`, `/api/v1/runtimes/:id/models`.
- Produces: `/api/v1/runs`, `/api/v1/runs/:id`, `/events`, `/cancel`, `/log`, `/review`, `/resume`.

- [x] **Step 1: Write the capability-route regression test**

```js
test('known runtime routes exist even when the binary is unavailable', async () => {
  const result = await json(runtime.url, '/api/v1/runtimes/codex/models')
  assert.equal(result.status, 503)
  assert.equal(result.body.error.code, 'MODEL_CATALOG_UNAVAILABLE')
  assert.notEqual(result.body.error.code, 'ROUTE_NOT_FOUND')
})
```

- [x] **Step 2: Write the meta handshake test**

Expected response:

```js
{
  service: 'tasks-recorder',
  service_version: PACKAGE_VERSION,
  api_version: 4,
  capabilities: {
    runtime_registry: true,
    unified_runs: true,
    internal_scheduler: true,
  },
}
```

- [x] **Step 3: Run and prove the new routes fail**

Run: `node --test test/runtime-api.test.mjs test/run-api.test.mjs`

Expected: FAIL with `ROUTE_NOT_FOUND`.

- [x] **Step 4: Register routes independently of current capability**

Inject `runtimeRegistry`, `runService`, `packageVersion`, and `apiVersion` into `createApiServer`. Route matching must depend on the service being composed, not on a non-null `codexModelCatalog`.

- [x] **Step 5: Implement Run HTTP behavior**

`POST /api/v1/runs` accepts exactly:

```js
{ schedule_id, origin: 'manual', idempotency_key }
```

The server loads the Schedule; the browser cannot send prompt, command, executable, cwd, or environment. Return `202` and `{ run }`. Map duplicate idempotency to the existing Run and an active conflict to `409 RUN_ALREADY_ACTIVE`.

SSE uses `Last-Event-ID` or `?after=` as a bounded sequence. On replay gap, emit a `reset` event instructing the client to refetch `GET /api/v1/runs/:id`.

- [x] **Step 6: Add Dashboard API methods**

```js
runtimes: () => request('/api/v1/runtimes'),
refreshRuntimes: () => request('/api/v1/runtimes/refresh', { method: 'POST', body: {} }),
runtimeModels: (id) => request(`/api/v1/runtimes/${encodeURIComponent(id)}/models`),
createRun: (scheduleId, idempotencyKey) => request('/api/v1/runs', {
  method: 'POST',
  body: { schedule_id: scheduleId, origin: 'manual', idempotency_key: idempotencyKey },
}),
run: (id) => request(`/api/v1/runs/${encodeURIComponent(id)}`),
cancelRun: (id) => request(`/api/v1/runs/${encodeURIComponent(id)}/cancel`, {
  method: 'POST',
  body: {},
}),
```

- [x] **Step 7: Run focused API tests**

Run: `node --test test/runtime-api.test.mjs test/run-api.test.mjs test/api-server.test.mjs test/scheduled-dashboard-api.test.mjs`

Expected: PASS.

- [x] **Step 8: Review checkpoint**

Verify Host/Origin checks and JSON-body allowlists remain active on every new mutation. Do not commit without explicit owner authorization.

### Task 7: Runtime-aware Schedule definitions and internal scheduler clock

**Files:**
- Modify: `server/src/scheduler/schedule-definition-codec.mjs`
- Modify: `server/src/scheduler/schedule-definition-repository.mjs`
- Modify: `server/src/scheduler/cadence.mjs`
- Modify: `server/src/scheduler/scheduler-service.mjs`
- Create: `server/src/scheduler/scheduler-clock.mjs`
- Modify: `test/schedule-definition-codec.test.mjs`
- Modify: `test/schedule-definition-repository.test.mjs`
- Modify: `test/scheduler-cadence.test.mjs`
- Modify: `test/scheduler-service.test.mjs`
- Create: `test/scheduler-clock.test.mjs`

**Interfaces:**
- Produces: normalized Schedule field `agent`, defaulting to `codex`.
- Produces: a definition-only `createScheduleService({ definitions, runtimeRegistry })`.
- Produces: `latestDueOccurrence(cadence, { after, at }) -> Instant | null`.
- Produces: `createSchedulerClock({ definitions, runService, clock, setTimer, clearTimer, intervalMs })`.
- Clock methods: `start`, `tick`, `notifyDefinitionsChanged`, `whenIdle`, `close`.

- [x] **Step 1: Add codec tests for `agent`**

```js
test('legacy definition defaults agent to codex without rewriting source', () => {
  const parsed = parseScheduleDefinition(LEGACY_MARKDOWN)
  assert.equal(parsed.job.agent, 'codex')
  assert.equal(parsed.source.includes('agent:'), false)
})

test('definition rejects an unsafe agent ID', () => {
  assert.throws(
    () => parseScheduleDefinition(markdown({ agent: '../codex' })),
    { code: 'SCHEDULE_DEFINITION_INVALID' },
  )
})
```

- [x] **Step 2: Implement `agent` normalization**

Accept `/^[a-z][a-z0-9-]{0,63}$/`. New writes emit `agent: codex`; reads of missing fields normalize to `codex` while retaining the original source until a user mutation occurs.

- [x] **Step 3: Add due-occurrence tests for sleep, restart, and clock changes**

```js
test('latestDueOccurrence coalesces many missed hourly occurrences', () => {
  assert.equal(
    latestDueOccurrence(HOURLY_AT_15, {
      after: new Date('2026-08-27T00:00:00Z'),
      at: new Date('2026-08-27T05:47:00Z'),
    }).toISOString(),
    '2026-08-27T05:15:00.000Z',
  )
})
```

Test daily, weekly, monthly, once, DST boundary in the system timezone, no occurrence before `after`, and a backwards wall-clock move.

- [x] **Step 4: Write scheduler-clock tests**

Use a fake clock and fake `RunService.create` to prove:

- startup ticks immediately;
- repeated ticks produce one occurrence key;
- five missed occurrences coalesce to the latest one;
- active Run conflict does not spin or enqueue another Run;
- manual Runs and scheduled ticks share the active constraint;
- a file-change notification triggers a debounced tick;
- `close()` clears timers and waits for the active tick.

- [ ] **Step 5: Reduce ScheduleService to definition CRUD**

Retain `listJobs`, `getJob`, `createJob`, `updateJob`, `pauseJob`, `resumeJob`, and `deleteJob`. Remove backend reconciliation, sync state, dispatch, claim, heartbeat, completion, and `runNow`. Schedule creation validates that `agent` is a registered runtime ID but does not require the runtime binary, authentication, or model probe to be available.

- [x] **Step 6: Run and prove the clock module is missing**

Run: `node --test test/scheduler-clock.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 7: Implement the single wall-clock scheduler**

```js
async function tick() {
  const observedAt = clock()
  for (const schedule of await definitions.list()) {
    if (!schedule.enabled) continue
    const previous = await runService.latestOccurrence(schedule.id)
    const due = latestDueOccurrence(schedule.cadence, {
      after: previous?.scheduled_for
        ? new Date(previous.scheduled_for)
        : new Date(schedule.created_at),
      at: observedAt,
    })
    if (!due) continue
    const latenessMs = observedAt.getTime() - due.getTime()
    const origin = latenessMs <= Math.max(intervalMs * 2, 90_000)
      ? 'scheduled'
      : 'catchup'
    await runService.create({
      schedule,
      origin,
      occurrence_key: occurrenceKey(schedule, due),
      scheduled_for: due.toISOString(),
      idempotency_key: null,
    }).catch(ignoreExpectedDedupeOrActiveConflict)
  }
}
```

Use a chained promise to serialize ticks. Schedule the next 30-second timer after the current tick settles; never overlap tick loops.

- [ ] **Step 8: Run focused scheduler tests**

Run: `node --test test/schedule-definition-codec.test.mjs test/schedule-definition-repository.test.mjs test/scheduler-cadence.test.mjs test/scheduler-service.test.mjs test/scheduler-clock.test.mjs`

Expected: PASS.

- [ ] **Step 9: Review checkpoint**

Confirm there is no launchctl, plist, socket, runner, or spool dependency in `scheduler-clock.mjs`. Do not commit without explicit owner authorization.

### Task 8: Compose the direct runtime pipeline in taskd

**Files:**
- Modify: `server/src/taskd-runtime.mjs`
- Modify: `server/src/api-server.mjs`
- Modify: `server/src/session-resume-service.mjs`
- Modify: `server/src/journal-diagnostics.mjs`
- Modify: `test/taskd-runtime.test.mjs`
- Modify: `test/scheduled-runtime-e2e.test.mjs`
- Modify: `test/session-resume-service.test.mjs`
- Modify: `test/journal-diagnostics.test.mjs`

**Interfaces:**
- Consumes Tasks 1–7.
- Produces one taskd composition with registry, RunStore, RunService, RunEventHub, SchedulerClock, and API.
- Produces startup recovery and coordinated shutdown.

- [ ] **Step 1: Replace the E2E test's fake launchd backend with a fake runtime definition**

The fake runtime invocation must spawn a fixture Node process that emits:

```json
{"type":"thread.started","thread_id":"019fcfae-8d5b-7640-aec8-83a114810589"}
{"type":"item.completed","item":{"type":"file_change","path":"result.md","kind":"update"}}
{"type":"turn.completed","final_output":"done"}
```

The E2E test creates a Markdown Schedule, calls `POST /api/v1/runs`, observes queued/running/succeeded, checks Session ID and file changes, and never invokes launchctl.

- [ ] **Step 2: Run and prove current composition still requires the legacy backend**

Run: `node --test test/scheduled-runtime-e2e.test.mjs`

Expected: FAIL because the runtime does not accept registry/supervisor injection or because launchd is still invoked.

- [ ] **Step 3: Compose services in `startTaskd`**

Construction order:

```js
const runtimeRegistry = createRuntimeAgentRegistry({
  definitions: [createCodexRuntimeDefinition()],
  resolver: createExecutableResolver(runtimeResolverOptions),
})
const runStore = createRunStore({ databasePath: config.schedulerDatabasePath })
const runEventHub = createRunEventHub({ maximumEventsPerRun: 256 })
const processSupervisor = createProcessSupervisor(processOptions)
const runService = createRunService({
  runStore,
  definitions: schedulerDefinitions,
  runtimeRegistry,
  processSupervisor,
  eventHub: runEventHub,
  logs: scheduledRunLogs,
  onChange: (change) => hub.publish(change),
})
const schedulerClock = createSchedulerClock({
  definitions: schedulerDefinitions,
  runService,
  intervalMs: 30_000,
})
```

Call `await runService.recover()` before `schedulerClock.start()`.

- [ ] **Step 4: Register monitor-to-clock refresh**

The Schedule definition monitor continues to refresh the repository. After a successful diff, publish Dashboard invalidation and call `schedulerClock.notifyDefinitionsChanged()`. It no longer reconciles launchd state.

- [ ] **Step 5: Coordinate shutdown**

Close in this order:

1. stop accepting new HTTP mutations;
2. close SchedulerClock;
3. ask RunService to cancel owned children and await bounded shutdown;
4. close definition monitor;
5. close event hub and logs;
6. close RunStore and journal stores;
7. close HTTP server.

- [ ] **Step 6: Update diagnostics**

`/api/v1/status` reports:

```js
{
  runtime_registry: { registered: 1, ready: 0, unavailable: 1 },
  scheduler: { engine: 'taskd-clock', running: true, last_tick_at, last_error_code },
  runs: { queued, running, interrupted },
}
```

It no longer reports per-Schedule launchd sync, runner socket, or spool backlog.

- [ ] **Step 7: Update Session Resume**

`resumeScheduledRun(runId)` reads `runtime_id`, `session_id`, and `workspace` from unified RunService. Initially only `runtime_id === 'codex'` is resumable. Unknown adapters return `RUNTIME_RESUME_UNSUPPORTED`.

- [ ] **Step 8: Run focused integration tests**

Run: `node --test test/taskd-runtime.test.mjs test/scheduled-runtime-e2e.test.mjs test/session-resume-service.test.mjs test/journal-diagnostics.test.mjs`

Expected: PASS without a launchd fixture or Unix socket.

- [ ] **Step 9: Review checkpoint**

Search: `rg -n "runnerProtocol|runnerSpool|createLaunchdSchedulerBackend|scheduledRunnerPath" server/src/taskd-runtime.mjs`

Expected: no matches. Do not commit without explicit owner authorization.

### Task 9: Remove the legacy runner and clean up owned LaunchAgents

**Files:**
- Create: `server/src/scheduler/legacy-launchd-cleanup.mjs`
- Modify: `server/control.mjs`
- Modify: `scripts/package-release.mjs`
- Modify: `test/control.test.mjs`
- Modify: `test/release-package.test.mjs`
- Create: `test/legacy-launchd-cleanup.test.mjs`
- Delete: `server/scheduled-runner.mjs`
- Delete: `server/src/scheduler/launchd-backend.mjs`
- Delete: `server/src/scheduler/runner-completion-evidence.mjs`
- Delete: `server/src/scheduler/runner-lock.mjs`
- Delete: `server/src/scheduler/runner-protocol.mjs`
- Delete: `server/src/scheduler/runner-spool.mjs`
- Delete: `server/src/scheduler/scheduler-store.mjs`
- Delete: `test/launchd-scheduler-backend.test.mjs`
- Delete: `test/runner-completion-evidence.test.mjs`
- Delete: `test/scheduled-runner.test.mjs`
- Delete: `test/scheduler-runner-protocol.test.mjs`
- Delete: `test/scheduler-runner-spool.test.mjs`
- Delete: `test/scheduler-store.test.mjs`

**Interfaces:**
- Produces: `cleanupLegacyScheduleLaunchAgents({ homeDirectory, uid, commandRunner })`.
- Cleanup only owns labels beginning `com.joi.tasks-recorder.schedule.` and matching private plist files.

- [ ] **Step 1: Write cleanup ownership tests**

Prove:

- owned Tasks Recorder schedule plist is booted out and removed;
- unrelated LaunchAgents are untouched;
- a symlink, wrong owner/mode, or malformed ID is reported and not removed;
- repeated cleanup is idempotent;
- one failed unit does not hide the IDs that were cleaned successfully.

- [ ] **Step 2: Run and prove cleanup is absent**

Run: `node --test test/legacy-launchd-cleanup.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement one-shot cleanup**

Reuse the existing strict label and private-path checks, but expose only:

```js
{
  removed: [{ job_id, label }],
  skipped: [{ label, error_code }],
}
```

Call cleanup during install/update before starting the source clock. If any owned unit cannot be safely classified, service startup is degraded and the old/new execution paths must not both run.

- [ ] **Step 4: Remove legacy packaging**

Delete the standalone runner entry from release manifests, package smoke assertions, third-party notices if no longer applicable, and launchd scheduler assets. Keep the taskd LaunchAgent controller unchanged.

- [ ] **Step 5: Delete legacy code and tests**

Use `apply_patch` deletions only after Tasks 7–8 pass. Update imports and the syntax-check file list so no deleted path remains.

- [ ] **Step 6: Run removal gates**

Run:

```bash
node --test test/legacy-launchd-cleanup.test.mjs test/control.test.mjs test/release-package.test.mjs
npm run check
rg -n "scheduled-runner|runner-protocol|runner-spool|runner-lock|launchd-backend" server scripts package.json test
```

Expected: tests and syntax check PASS; `rg` finds only historical specs/plans or explicit legacy cleanup descriptions.

- [ ] **Step 7: Review checkpoint**

Inspect `git diff --stat` and confirm the deletion is net-negative production code. Do not commit without explicit owner authorization.

### Task 10: Runtime-aware Schedule editor

**Files:**
- Modify: `ui/src/dashboard-api.mjs`
- Modify: `ui/src/scheduled-task-editor.mjs`
- Modify: `ui/src/scheduled-tasks.mjs`
- Modify: `ui/src/dashboard.css`
- Modify: `test/scheduled-task-editor.test.mjs`
- Modify: `test/scheduled-tasks-ui.test.mjs`
- Modify: `test/dashboard-build.test.mjs`

**Interfaces:**
- Consumes runtime API from Task 6.
- Produces editor state `{ runtimes, selectedRuntimeId, modelState, models, selectedModel, reasoningLevels }`.
- Schedule save sends semantic `agent`, `model`, and `reasoning_effort`.

- [ ] **Step 1: Add editor state tests**

Cover:

- `probing` shows a real loading indicator and disables model selection;
- `live` shows live models and reasoning levels;
- `fallback` labels the source without disabling the form;
- `unavailable` shows a stable inline explanation and Retry action;
- saved unavailable model remains selected with `Unavailable`, no spinner;
- changing runtime resets model/reasoning to that runtime's defaults;
- a runtime with `modelSelection: false` hides Model and Reasoning.
- the Agent picker remains visible when Codex is the only registered runtime.

- [ ] **Step 2: Run and prove current Codex-only editor fails**

Run: `node --test test/scheduled-task-editor.test.mjs`

Expected: FAIL because the editor has no runtime registry state and conflates unavailable with loading.

- [ ] **Step 3: Implement pure runtime/model state derivation**

```js
export function deriveRuntimeControls({ runtimes, runtimeId, savedModel, savedReasoning }) {
  const runtime = runtimes.find(({ id }) => id === runtimeId)
  if (!runtime) return { state: 'unavailable', error_code: 'RUNTIME_NOT_FOUND' }
  const modelState = runtime.models_source === 'probing'
    ? 'probing'
    : runtime.models_source
  return {
    runtime,
    modelState,
    models: includeSavedModel(runtime.models, savedModel),
    reasoningLevels: reasoningFor(runtime.models, savedModel, savedReasoning),
  }
}
```

- [ ] **Step 4: Render Agent, Model, and Reasoning controls**

Use normal form labels. Do not add eyebrow headings, toast messages, status banners, or animated decoration. Loading exists only during an active probe request. Error detail belongs under the affected control with a Retry button.

- [ ] **Step 5: Integrate editor loading**

Opening the editor fetches `/api/v1/runtimes`, selects the saved `agent`, and fetches models only for the selected runtime. Cache the successful response for the dialog lifetime; Retry explicitly refreshes.

- [ ] **Step 6: Run focused UI tests and build**

Run:

```bash
node --test test/scheduled-task-editor.test.mjs test/scheduled-tasks-ui.test.mjs test/dashboard-build.test.mjs
npm run build
```

Expected: PASS.

- [ ] **Step 7: Review checkpoint**

Inspect the generated UI at narrow and desktop widths later in Task 13; this task's gate is DOM/state correctness. Do not commit without explicit owner authorization.

### Task 11: Unified Run list, history, and live events

**Files:**
- Modify: `ui/src/scheduled-tasks.mjs`
- Modify: `ui/src/scheduled-run-review.mjs`
- Modify: `ui/src/event-stream.mjs`
- Modify: `ui/src/dashboard.css`
- Modify: `test/scheduled-tasks-ui.test.mjs`
- Modify: `test/scheduled-run-review.test.mjs`
- Create: `test/run-event-stream.test.mjs`

**Interfaces:**
- Consumes unified Run API and SSE from Task 6.
- Produces one Run row model for queued/running/terminal states.
- Produces Run Review sheet/table with logs, artifacts, Session ID, Resume, Review, and Cancel.

- [ ] **Step 1: Replace dispatch-state fixtures with queued Run fixtures**

```js
const QUEUED_RUN = {
  id: RUN_ID,
  schedule_id: SCHEDULE_ID,
  runtime_id: 'codex',
  origin: 'manual',
  status: 'queued',
  created_at: '2026-08-27T01:00:00.000Z',
}
```

Delete UI fixtures for `dispatch_stalled`, `attempt_count`, and `last_attempted_at`.

- [ ] **Step 2: Add lifecycle rendering tests**

Assert one consistent status system for:

- queued;
- running with local duration;
- succeeded;
- failed with stable error detail;
- timed out;
- canceled;
- interrupted with Retry.

No normal path renders “requested”, “watcher verified”, or an alert/toast.

- [ ] **Step 3: Add event-stream reconnect tests**

Prove:

- last sequence is sent on reconnect;
- ordered events update the active Run;
- a sequence gap/reset fetches authoritative Run state;
- terminal event closes the per-Run stream;
- Dashboard-wide invalidation still refreshes Schedule summaries.

- [ ] **Step 4: Implement Run now through unified API**

Generate one idempotency UUID per click, call `createRun`, insert the returned queued Run immediately, open its SSE stream, and disable another Run while it is queued/running.

- [ ] **Step 5: Implement Run Review**

The Review surface uses a table or collapsible sheet. Required columns/fields:

- status;
- origin;
- runtime;
- started/finished/duration;
- Session ID with copy;
- artifacts/file changes;
- stdout/stderr log tabs;
- Resume when supported;
- Cancel only while queued/running;
- Review state for terminal Runs.

- [ ] **Step 6: Run focused UI tests**

Run: `node --test test/scheduled-tasks-ui.test.mjs test/scheduled-run-review.test.mjs test/run-event-stream.test.mjs`

Expected: PASS.

- [ ] **Step 7: Review checkpoint**

Confirm status text comes from Run facts, not optimistic transient copy. Do not commit without explicit owner authorization.

### Task 12: One-command isolated development runtime

**Files:**
- Create: `scripts/dev.mjs`
- Modify: `package.json`
- Modify: `ui/dev-gateway.mjs`
- Modify: `ui/dev-runtime.mjs`
- Modify: `ui/dev-server.mjs`
- Create: `test/dev-supervisor.test.mjs`
- Modify: `test/dashboard-dev-gateway.test.mjs`
- Modify: `test/dashboard-dev-runtime.test.mjs`

**Interfaces:**
- Produces: `npm run dev`.
- Produces: `startDevSupervisor({ projectRoot, temporaryRoot, taskdFactory, dashboardFactory, stderr })`.
- Default source taskd and Dashboard share API version 4 and isolated development state.

- [ ] **Step 1: Write lifecycle tests for the parent supervisor**

Prove:

- isolated config and databases are created beneath the supplied temporary root;
- taskd starts before the Dashboard gateway;
- gateway upstream is the exact source taskd address;
- taskd startup failure prevents the gateway;
- `close()` shuts down gateway, watcher, child Runs, taskd, and temporary resources;
- signal handling settles once;
- installed `43127` is never stopped or modified.

- [ ] **Step 2: Run and prove the supervisor is missing**

Run: `node --test test/dev-supervisor.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement `scripts/dev.mjs`**

The command:

1. resolves the current source root;
2. creates a private temporary dev home;
3. writes a minimal isolated config through existing config helpers, not shell heredocs;
4. starts source taskd on an available loopback port;
5. starts live Dashboard compilation/gateway against that exact address;
6. prints one Dashboard URL and data directory;
7. handles SIGINT/SIGTERM and coordinated close.

`package.json`:

```json
{
  "scripts": {
    "dev": "node scripts/dev.mjs",
    "dev:ui": "node ui/dev-server.mjs"
  }
}
```

- [ ] **Step 4: Add version mismatch behavior to the advanced UI-only gateway**

Before serving the source Dashboard, fetch `/api/v1/meta`. If `api_version !== 4`, serve a bounded diagnostic page containing source API version, detected service version/API version, and the `npm run dev` command. Do not mount the application and wait for individual 404s.

- [ ] **Step 5: Run focused dev tests**

Run: `node --test test/dev-supervisor.test.mjs test/dashboard-dev-gateway.test.mjs test/dashboard-dev-runtime.test.mjs`

Expected: PASS with no listening handles after test completion.

- [ ] **Step 6: Manual source-loop smoke**

Run:

```bash
npm run dev
```

Expected:

- one URL is printed;
- `/api/v1/meta` reports API v4;
- Scheduled and runtime routes return structured responses;
- editing `ui/src/dashboard.css` triggers a rebuild and reload;
- `Ctrl+C` closes both source services;
- `tasks-recorder status` for the installed service is unchanged.

- [ ] **Step 7: Review checkpoint**

Confirm no preview instruction requires publishing, reinstalling, or running three manual ports. Do not commit without explicit owner authorization.

### Task 13: Documentation, visual verification, and release gates

**Files:**
- Modify in feature worktree: `README.md`
- Modify in documentation worktree: `MAINTAINERS.md`
- Modify in documentation worktree: `docs/architecture.md`
- Modify in documentation worktree: `docs/operations.md`
- Modify in documentation worktree: `docs/getting-started.md`
- Modify: `docs/superpowers/specs/2026-08-24-scheduled-tasks-design.md`
- Modify: `docs/superpowers/specs/2026-08-25-file-native-scheduled-tasks-design.md`
- Modify: `docs/superpowers/specs/2026-08-26-scheduled-execution-observability-design.md`
- Modify: `docs/job/tasks-recorder-scheduled-tasks/06-test-report.md`
- Test in documentation worktree: `test/documentation.test.mjs`

**Interfaces:**
- Documents the final source of truth and marks the independent-runner architecture superseded.
- Produces visual and command evidence for release review.

- [ ] **Step 1: Run the required documentation impact scan**

Run:

```bash
git diff --name-only HEAD
find . -name "*.md" -not -path "*/node_modules/*" -not -path "*/.git/*"
rg -n "scheduled-runner|per-Schedule|launchd backend|codex_path|dev:ui|43132|43133|Run now|model catalog" README.md docs -g "*.md"
```

Classify every match as current contract, historical evidence, or obsolete instruction.

- [ ] **Step 2: Update current documentation**

Document:

- one daemon and internal scheduler;
- runtime registry and Codex-first adapter;
- executable discovery order;
- live/fallback/unavailable model states;
- unified Run lifecycle and interruption recovery;
- `npm run dev`;
- source/service version mismatch;
- removal of per-Schedule LaunchAgents and runner troubleshooting.

Historical specs receive a banner:

```markdown
> Superseded on 2026-08-27 by
> [Runtime Agent Registry and Single-Daemon Scheduler Design](./2026-08-27-runtime-agent-registry-design.md).
> Retained as historical design evidence; do not implement its independent runner path.
```

Apply README and historical-spec changes in the feature worktree. Then run `git worktree list --porcelain`, verify `docs/public-documentation` maps to `/Users/joi-com/Desktop/space/projects/tasks-recorder/.worktree/docs-public-documentation`, switch command `workdir` to that worktree, and update MAINTAINERS/architecture/operations/getting-started without staging unrelated documentation changes.

- [ ] **Step 3: Run public-documentation tests**

Run in `/Users/joi-com/Desktop/space/projects/tasks-recorder/.worktree/docs-public-documentation`:

```bash
node --test test/documentation.test.mjs
```

Expected: PASS for entry-point ownership, relative links, machine-specific data, and versionless README assertions.

- [ ] **Step 4: Run complete automated gates**

Run in order:

```bash
npm run build
npm run build:adapters
npm run check
npm test
npm run package:release
bash -n install.sh
```

Expected: all commands PASS. Record exact test counts and durations in `docs/job/tasks-recorder-scheduled-tasks/06-test-report.md`.

- [ ] **Step 5: Perform Playwright MCP visual verification**

Use `playwright-headless`, not a locally installed Playwright package. Verify desktop and narrow viewport for:

- runtime probing;
- live models;
- fallback models;
- unavailable runtime and saved unavailable model;
- queued and running Runs;
- success, failure, timeout, canceled, interrupted;
- Run Review logs/artifacts/Session ID;
- version mismatch diagnostic.

Capture screenshots only for states with visual regressions or release evidence. Check browser console after each route/state.

- [ ] **Step 6: Perform real macOS smoke**

Using a disposable Workspace and current authenticated Codex:

1. resolve Codex without mandatory `codex_path`;
2. list models;
3. create one manual Run;
4. observe SSE and terminal success;
5. verify output file, Session ID, logs, and Resume;
6. cancel one bounded Run;
7. stop taskd during a Run and verify interrupted recovery;
8. schedule a near-future Run, sleep/wake across the due time, and verify exactly one catch-up.

Do not use the user's production project as the disposable Workspace.

- [ ] **Step 7: Verify package contents and source-loop docs**

Confirm the release archive contains registry/runtime/RunService code and does not contain `scheduled-runner.mjs` or per-Schedule launchd assets. Follow README/MAINTAINERS commands from a clean checkout or disposable package directory.

- [ ] **Step 8: Final diff and ownership review**

Run:

```bash
git diff --check
git status --short
git diff --stat
```

Separate the files changed by this plan from pre-existing unrelated work. Do not stage or commit without explicit owner authorization.

## Implementation order and phase gates

1. **Runtime foundation:** Tasks 1–2. Gate: registry and Codex adapter focused tests pass.
2. **Run foundation:** Tasks 3–5. Gate: durable lifecycle, supervisor, events, and recovery pass without HTTP/UI.
3. **Service cutover:** Tasks 6–9. Gate: direct source E2E passes and all legacy runner production code is deleted.
4. **Product surface:** Tasks 10–12. Gate: runtime-aware editor, unified Run history, SSE, and one-command dev pass.
5. **Release evidence:** Task 13. Gate: full automated, visual, real macOS, documentation, and package checks pass.

At the end of each phase, report:

- files changed in that phase;
- exact focused test commands and results;
- known remaining failures attributable to later phases;
- whether related documentation is now stale;
- a request for owner approval before any phase commit.
