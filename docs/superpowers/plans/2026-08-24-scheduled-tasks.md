# Scheduled Tasks Implementation Plan

> **Historical / superseded (2026-08-27)**：本文记录已退役的 per-Schedule `launchd` / runner 实施计划，不是现行操作指南。当前架构见 [`README.md`](../../../README.md) 与 [`Runtime Agent Registry 设计`](../specs/2026-08-27-runtime-agent-registry-design.md)。

> **Superseded（2026-08-25）**：这是 SQLite-defined Scheduler 的历史实施计划。当前计划见 [`2026-08-25-file-native-scheduled-tasks.md`](./2026-08-25-file-native-scheduled-tasks.md)。

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a macOS-first Scheduled Tasks control plane whose Dashboard can schedule, run, review, and resume standalone unattended Codex work.

**Architecture:** `launchd` owns durable calendar wake-ups, `taskd` exclusively owns `scheduler.sqlite` desired state and run facts, and an independent runner owns locks, Codex process supervision, timeout, JSONL/logs, and completion delivery. The existing Recorder plane observes the generated Codex thread through normal trusted Hooks; Scheduled Tasks never mutates semantic Tasks implicitly.

**Tech Stack:** Node.js 24 ESM, `node:sqlite`, macOS `launchd`/`launchctl`, Unix domain sockets, Codex CLI JSONL, vanilla browser modules, React/SVAR retained only for the existing Tasks view, Node test runner, Playwright MCP for visual verification.

**Spec:** [`../specs/2026-08-24-scheduled-tasks-design.md`](../specs/2026-08-24-scheduled-tasks-design.md)

## Global Constraints

- Node.js `>=24.0.0`; do not add a scheduler runtime dependency.
- macOS `launchd` is the only implemented v1 backend; other platforms return a typed unsupported capability.
- `taskd` is the only process that opens `tasks.sqlite` or `scheduler.sqlite`.
- Prompt is transported only over the 0600 Unix socket and Codex stdin; it must not appear in plist, argv, public API logs, or structured logs.
- Public HTTP remains `127.0.0.1` with existing Host/Origin guards; runner mutations use the private Unix socket.
- Default sandbox is `read-only`; broader modes are explicit per Schedule.
- Never add Codex bypass-sandbox, bypass-approval, or bypass-hook-trust flags.
- Scheduled and manual triggers share one lock/claim/supervision/completion path.
- An active Run uses an immutable Job revision/spec snapshot; edits affect only future Runs.
- Missed occurrences coalesce to at most one catch-up; Agent work is not automatically retried.
- Schedule/Run state never automatically creates, completes, archives, or reopens a semantic Task.
- Preserve unrelated user changes. Do not commit unless the user explicitly authorizes it again.

## File and Interface Map

### Scheduler domain

- `server/src/scheduler/cadence.mjs` — structured cadence validation, summary, next occurrence, launchd calendar dictionaries.
- `server/src/scheduler/scheduler-schema.mjs` — scheduler schema v1 and invariant checks.
- `server/src/scheduler/scheduler-store.mjs` — the only façade over `scheduler.sqlite`.
- `server/src/scheduler/scheduler-service.mjs` — Job/Run domain operations, revision guards, desired-state reconciliation coordination.
- `server/src/scheduler/scheduler-errors.mjs` — typed Scheduler errors mapped by API and internal protocol.

### Native scheduler and runner

- `server/src/scheduler/launchd-backend.mjs` — owned plist rendering, install/remove/reconcile, manual kickstart, backend capability.
- `server/src/scheduler/runner-spool.mjs` — bounded 0600 dispatch/overlap/completion evidence.
- `server/src/scheduler/runner-protocol.mjs` — taskd Unix socket server plus runner client.
- `server/src/scheduler/codex-run-spec.mjs` — allowlisted immutable Codex invocation spec and preflight.
- `server/src/scheduler/codex-jsonl.mjs` — bounded stdout JSONL parser for thread ID/final message.
- `server/src/scheduler/process-supervisor.mjs` — shell-free spawn, heartbeat, process-group TERM/KILL, logs.
- `server/src/scheduler/runner-lock.mjs` — per-Schedule PID/nonce lock and multi-evidence stale recovery.
- `server/scheduled-runner.mjs` — minimal executable composition entrypoint.

### Service and distribution

- `mcp/src/config.mjs` — scheduler DB/runtime/socket/log/spool paths and validated Codex path config.
- `server/src/taskd-runtime.mjs` — scheduler composition and startup/shutdown reconciliation.
- `server/src/api-server.mjs` — typed public Schedule/Run routes only.
- `server/src/session-resume-service.mjs` — validated resume by scheduled Run thread ID.
- `server/src/journal-diagnostics.mjs` — scheduler degraded capability without weakening recorder readiness.
- `server/cli.mjs`, `server/control.mjs`, `install.sh` — scheduler diagnostics/reconcile, absolute runtime paths, owned-unit uninstall.
- `scripts/package-release.mjs` and package tests — runner/runtime allowlist and installed smoke.

### Dashboard

- `ui/src/dashboard.mjs` — global Tasks/Scheduled view state and nav composition only.
- `ui/src/index.html` — separate `#scheduled-tasks` panel next to `#gantt_here`.
- `ui/src/dashboard.css` — top-level switch and Scheduled visual system.
- `ui/src/dashboard-api.mjs` — typed Schedule/Run client methods.
- `ui/src/scheduled-tasks.mjs` — Scheduled list/review controller, search/filter/sort/loading/error/empty.
- `ui/src/scheduled-task-editor.mjs` — create/edit Sheet, cadence builder, preflight and risk confirmation.
- `ui/src/scheduled-run-review.mjs` — Run history, final result, bounded logs, reviewed/resume actions.

---

## Phase 1 — Scheduler Domain

### Task 1: Structured Cadence Contract

**Files:**
- Create: `server/src/scheduler/cadence.mjs`
- Create: `test/scheduler-cadence.test.mjs`

**Interfaces:**
- Produces: `validateCadence(input, { now = new Date() } = {}) -> Cadence`
- Produces: `nextOccurrence(cadence, after, { inclusive = false } = {}) -> Date | null`
- Produces: `cadenceSummary(cadence, { locale = 'zh-CN' } = {}) -> string`
- Produces: `launchdCalendars(cadence) -> Array<Record<'Minute'|'Hour'|'Day'|'Weekday'|'Month', number>>`
- Cadence shapes are exactly `once`, `hourly`, `daily`, `weekly`, and `monthly` from the spec; `timezone_mode` is always `system`.

- [ ] **Step 1: Write failing validation and calendar tests**

```js
test('normalizes weekly cadence without changing ISO weekdays', () => {
  assert.deepEqual(validateCadence({
    kind: 'weekly', weekdays: [5, 1, 5], hour: 9, minute: 30,
  }), { kind: 'weekly', weekdays: [1, 5], hour: 9, minute: 30, timezone_mode: 'system' })
})

test('maps ISO Sunday to launchd Sunday without exposing raw plist input', () => {
  assert.deepEqual(launchdCalendars(validateCadence({
    kind: 'weekly', weekdays: [7], hour: 8, minute: 0,
  })), [{ Weekday: 0, Hour: 8, Minute: 0 }])
})
```

- [ ] **Step 2: Run the focused test and verify it fails because the module is absent**

Run: `node --test test/scheduler-cadence.test.mjs`
Expected: FAIL with module-not-found for `cadence.mjs`.

- [ ] **Step 3: Implement exact field/type/range validation**

Reject unknown keys, invalid local dates, duplicate semantics, `once` at or before `now`, `once` beyond 366 days, hourly minute outside 0–59, empty weekdays, monthly day outside 1–31, and non-system timezone. Return a fresh plain object; never retain browser input references.

- [ ] **Step 4: Implement server-authoritative next occurrence and summary**

Use local `Date` construction so the same system timezone semantics drive summary, next occurrence, and launchd calendars. Monthly days missing from a month are skipped. Search forward with a hard bounded horizon and return `null` after a consumed one-time cadence.

- [ ] **Step 5: Add DST and subprocess-TZ cases**

Spawn Node with `TZ=America/New_York` and `TZ=Asia/Shanghai`; assert daily wall-clock hour remains the requested local hour through DST boundaries and that `nextOccurrence` returns distinct UTC instants.

- [ ] **Step 6: Run focused tests and syntax check**

Run: `node --test test/scheduler-cadence.test.mjs && node --check server/src/scheduler/cadence.mjs`
Expected: all cadence tests PASS.

- [ ] **Step 7: Record phase evidence; commit only if explicitly authorized**

Files eligible for a later authorized commit: `server/src/scheduler/cadence.mjs`, `test/scheduler-cadence.test.mjs`, workflow status/log files.

### Task 2: Scheduler SQLite Schema and Store

**Files:**
- Create: `server/src/scheduler/scheduler-schema.mjs`
- Create: `server/src/scheduler/scheduler-store.mjs`
- Create: `server/src/scheduler/scheduler-errors.mjs`
- Create: `test/scheduler-store.test.mjs`

**Interfaces:**
- Produces: `createSchedulerStore({ databasePath, clock })`
- Store methods: `jobs.list/get/create/update/setEnabled/softDelete`, `runs.list/get/claim/markRunning/heartbeat/complete/reportOverlap/markReviewed`, `snapshot`, `check`, `transaction`, `close`.
- Consumes: normalized Cadence JSON from Task 1; the store never interprets launchd fields.

- [ ] **Step 1: Write failing schema, permissions, and lifecycle tests**

```js
const store = createSchedulerStore({ databasePath, clock })
const job = store.jobs.create(validJobInput)
assert.equal(job.revision, 1)
assert.equal(statSync(databasePath).mode & 0o777, 0o600)
assert.throws(() => store.jobs.update(job.id, 99, { title: 'stale' }), {
  code: 'SCHEDULE_VERSION_CONFLICT',
})
```

Cover schema `user_version = 1`, STRICT tables, WAL, foreign keys, one active Run per Job, soft delete history, immutable `spec_json`, idempotent completion, nonce mismatch, and reviewed state.

- [ ] **Step 2: Verify focused tests fail for missing store**

Run: `node --test test/scheduler-store.test.mjs`
Expected: FAIL before any DB file is created by test setup.

- [ ] **Step 3: Implement schema v1 and invariant checks**

Create `scheduled_jobs` and `scheduled_runs` with CHECK constraints matching the spec, JSON validity checks, foreign keys, indexes for active/next/review ordering, and a partial unique index for `claimed/running` Runs per Job.

- [ ] **Step 4: Implement nested transactions and Job mutations**

Use `BEGIN IMMEDIATE`, entity revision CAS, UTC ISO timestamps, soft delete, `sync_state=pending` generation increments, and fresh return objects. Deleted Jobs remain addressable for Run history but are excluded from active list by default.

- [ ] **Step 5: Implement Run claim/state mutations**

`claim` atomically snapshots Job revision/spec and advances `last_run_at/next_run_at`; one-time Jobs become disabled after accepted claim. `complete` accepts the matching nonce once, rejects terminal rewrites, and allows recovery from `lost` only when the same nonce supplies stronger completion evidence.

- [ ] **Step 6: Run focused tests and integrity checks**

Run: `node --test test/scheduler-store.test.mjs`
Expected: schema/invariant/permission/lifecycle tests PASS with database cleanup in `finally`.

- [ ] **Step 7: Record phase evidence; commit only if explicitly authorized**

Do not include the generated SQLite fixture or WAL files in Git.

### Task 3: Scheduler Domain Service

**Files:**
- Create: `server/src/scheduler/scheduler-service.mjs`
- Create: `test/scheduler-service.test.mjs`

**Interfaces:**
- Produces: `createSchedulerService({ store, backend, runnerDispatcher, codexPreflight, clock })`
- Public methods: `capability`, `listJobs`, `getJob`, `createJob`, `updateJob`, `pauseJob`, `resumeJob`, `deleteJob`, `runNow`, `listRuns`, `getRun`, `markReviewed`, `retrySync`.
- Internal methods: `claimRun`, `reportOverlap`, `heartbeatRun`, `completeRun`, `reconcile`, `recoverStaleRuns`.

- [ ] **Step 1: Write failing desired-state and revision tests**

```js
const created = await service.createJob(validInput)
assert.equal(created.job.sync_state, 'synced')
assert.deepEqual(backend.reconcileCalls, [{ jobId: created.job.id, generation: 1 }])

backend.failWith('LAUNCHD_BOOTSTRAP_FAILED')
const updated = await service.updateJob(created.job.id, created.job.revision, { title: 'Daily brief' })
assert.equal(updated.job.sync_state, 'error')
assert.equal(updated.job.sync_error_code, 'LAUNCHD_BOOTSTRAP_FAILED')
```

Cover validation-before-write, persisted definition despite sync error, Pause not canceling active Run, Edit not changing active spec, Run now through dispatcher, and unsupported backend capability.

- [ ] **Step 2: Verify focused failure**

Run: `node --test test/scheduler-service.test.mjs`
Expected: FAIL because the service module is absent.

- [ ] **Step 3: Implement input normalization and preflight boundary**

Only accept typed fields from the spec. Canonicalize Workspace without following browser-provided log paths, require an existing directory, normalize cadence through Task 1, bound prompt/title/model/reasoning/timeout, default sandbox to `read-only`, and fix `thread_mode='new'`.

- [ ] **Step 4: Implement persisted desired state plus reconciliation**

Commit Job first, invoke backend reconcile, then update sync result through a generation guard. A stale reconcile result must not overwrite a newer generation. Publish happens in the composition layer only after committed store changes.

- [ ] **Step 5: Implement internal Run coordination**

Claim creates immutable spec and raw nonce, overlap creates a terminal Run fact, heartbeat extends evidence, completion stores bounded final message/error/thread ID, and stale recovery requires the caller to provide OS lock/PID evidence rather than lease time alone.

- [ ] **Step 6: Run focused phase tests**

Run: `node --test test/scheduler-cadence.test.mjs test/scheduler-store.test.mjs test/scheduler-service.test.mjs`
Expected: all phase-1 tests PASS.

- [ ] **Step 7: Update workflow phase evidence; commit only if explicitly authorized**

Mark phase 1 complete only after the three focused suites and `git diff --check` pass.

---

## Phase 2 — Native Scheduler and Runner

### Task 4: launchd Backend and Reconciliation

**Files:**
- Create: `server/src/scheduler/launchd-backend.mjs`
- Create: `test/launchd-scheduler-backend.test.mjs`
- Modify: `server/control.mjs` only to export/reuse safe XML and command helpers where that removes duplication without changing taskd LaunchAgent behavior.

**Interfaces:**
- Produces: `renderSchedulePlist({ label, nodePath, runnerPath, jobId, calendars, stdoutPath, stderrPath }) -> string`
- Produces: `createLaunchdSchedulerBackend({ uid, homeDirectory, nodePath, runnerPath, runCommand, platform })`
- Backend methods: `capability`, `reconcile(job)`, `remove(jobId)`, `trigger(jobId)`, `inspect(jobId)`, `listOwned()`.

- [ ] **Step 1: Write failing plist privacy and ownership tests**

```js
const plist = renderSchedulePlist(input)
assert.match(plist, /scheduled-runner\.mjs/)
assert.match(plist, new RegExp(input.jobId))
assert.doesNotMatch(plist, /private prompt|\/Users\/private-workspace|danger-full-access/)
assert.doesNotMatch(plist, /<key>StartInterval<\/key>/)
```

Also assert XML escaping, stable absolute Node/runner paths, `StartCalendarInterval` arrays, Background process type, private log files, exact owned label prefix, and no shell.

- [ ] **Step 2: Verify focused failure**

Run: `node --test test/launchd-scheduler-backend.test.mjs`
Expected: FAIL because backend exports do not exist.

- [ ] **Step 3: Implement atomic plist rendering/writes**

Reject non-absolute executable paths and unsafe Job IDs. Write a mode-0600 temporary plist in `~/Library/LaunchAgents`, rename atomically, and never interpolate command strings.

- [ ] **Step 4: Implement generation-safe reconcile and cleanup**

Use `launchctl bootout gui/<uid> <plist>` with allowed not-loaded failure, then `bootstrap`. `remove` operates only on the exact safe ID; `listOwned` verifies both Label prefix and ProgramArguments before reporting a unit as owned.

- [ ] **Step 5: Implement manual trigger through the same unit**

`trigger(jobId)` calls `launchctl kickstart gui/<uid>/<label>`. It never directly starts Codex, so Run now uses the same runner and lock.

- [ ] **Step 6: Run focused and existing control regression tests**

Run: `node --test test/launchd-scheduler-backend.test.mjs test/control.test.mjs`
Expected: new backend tests and existing taskd LaunchAgent tests PASS.

- [ ] **Step 7: Record phase evidence; commit only if explicitly authorized**

### Task 5: Private Runner Protocol and Bounded Spool

**Files:**
- Create: `server/src/scheduler/runner-protocol.mjs`
- Create: `server/src/scheduler/runner-spool.mjs`
- Create: `test/scheduler-runner-protocol.test.mjs`
- Create: `test/scheduler-runner-spool.test.mjs`

**Interfaces:**
- Produces: `createRunnerProtocolServer({ socketPath, schedulerService })`
- Produces: `createRunnerProtocolClient({ socketPath, timeoutMs })`
- Client methods: `claim`, `reportOverlap`, `heartbeat`, `complete`.
- Produces: `createRunnerSpool({ directory, maxBytes, maxFiles, maxAgeMs })` with `enqueue`, `replay`, `status`.

- [ ] **Step 1: Write failing socket permission and protocol tests**

Start a server in a 0700 temp directory, assert socket mode 0600, claim response contains spec/nonce but no database path, invalid operation returns a stable code, timeout is bounded, and close removes the socket only if owned by this server.

- [ ] **Step 2: Write failing spool durability tests**

Cover atomic 0600 records, hard file/byte/age caps, idempotency key, replay deleting only acknowledged records, permanent rejection quarantine, stale claim recovery, and no Prompt/spec content in spool.

- [ ] **Step 3: Run both focused suites and verify failure**

Run: `node --test test/scheduler-runner-protocol.test.mjs test/scheduler-runner-spool.test.mjs`
Expected: FAIL for missing modules.

- [ ] **Step 4: Implement newline-bounded JSON protocol over Unix HTTP/socket**

Validate operation-specific bodies, hard-limit bytes, map domain errors without stacks, and return claim spec only after store transaction. Compare nonce using constant-time-safe byte comparison where equal-length hashes are checked.

- [ ] **Step 5: Implement privacy-bounded spool**

Records may contain Job/Run IDs, trigger, observed time, status, exit/error code, thread ID, duration, and truncated final-message hash; they must not contain Prompt, Workspace, sandbox spec, raw stdout, stderr, nonce, or secrets.

- [ ] **Step 6: Integrate startup replay contract**

Replay `dispatch_failed`, `overlap`, and `completion` idempotently. A dispatch failure creates a failed attempt fact and asks scheduler service for at most one catch-up if the Job is still enabled and due.

- [ ] **Step 7: Run focused tests**

Run: `node --test test/scheduler-runner-protocol.test.mjs test/scheduler-runner-spool.test.mjs`
Expected: all protocol/spool tests PASS.

- [ ] **Step 8: Record phase evidence; commit only if explicitly authorized**

### Task 6: Codex Process Supervisor and Runner Entry

**Files:**
- Create: `server/src/scheduler/codex-run-spec.mjs`
- Create: `server/src/scheduler/codex-jsonl.mjs`
- Create: `server/src/scheduler/process-supervisor.mjs`
- Create: `server/src/scheduler/runner-lock.mjs`
- Create: `server/scheduled-runner.mjs`
- Create: `test/codex-run-spec.test.mjs`
- Create: `test/codex-jsonl.test.mjs`
- Create: `test/scheduled-runner.test.mjs`

**Interfaces:**
- Produces: `buildCodexInvocation(spec) -> { command, args, cwd, stdin }`
- Produces: `createCodexJsonlCollector({ maxLineBytes, maxFinalMessageBytes })`
- Produces: `superviseProcess({ command, args, cwd, stdin, timeoutMs, graceMs, logs, onHeartbeat, spawnImpl })`
- Produces: `acquireRunnerLock({ lockPath, jobId, runNonce, inspectPid, inspectRun })`
- Produces: `runScheduledJob({ jobId, trigger, protocolClient, spool, paths, clock })` from the entry module.

- [ ] **Step 1: Write failing invocation privacy tests**

```js
const invocation = buildCodexInvocation(spec)
assert.equal(invocation.command, '/absolute/bin/codex')
assert.equal(invocation.stdin, spec.prompt)
assert.equal(invocation.args.at(-1), '-')
assert.equal(invocation.args.includes(spec.prompt), false)
assert.deepEqual(invocation.args.slice(0, 2), ['exec', '--json'])
assert.equal(invocation.args.includes('--dangerously-bypass-approvals-and-sandbox'), false)
```

Reject relative Codex paths, unsupported sandbox/model/reasoning values, missing workspace, unknown spec keys, and any command override.

- [ ] **Step 2: Write failing JSONL collector tests**

Feed chunk-split JSONL with `thread.started`, tool events, multiple agent messages, `turn.completed`, malformed/bounded lines, and stderr-like fake JSON. Assert only stdout JSONL sets thread ID/final message and raw Prompt never appears in parsed structured logs.

- [ ] **Step 3: Write failing supervisor/lock tests with fake child processes**

Cover lock contention → `skipped_overlap`, PID-alive stale guard, claim after lock, heartbeat, success/failure, TERM then process-group KILL, signal propagation, completion spool when taskd disconnects, and `finally` lock release.

- [ ] **Step 4: Verify focused tests fail**

Run: `node --test test/codex-run-spec.test.mjs test/codex-jsonl.test.mjs test/scheduled-runner.test.mjs`
Expected: FAIL before any real Codex process is started.

- [ ] **Step 5: Implement shell-free immutable invocation**

Use args arrays and `shell:false`; add `--json`, `--color never`, `--sandbox`, `--cd`, `-c approval_policy="never"`, optional model/reasoning, and final `-`. Do not add bypass flags.

- [ ] **Step 6: Implement bounded JSONL/log collection**

Write stdout JSONL and stderr into separate mode-0600 files under validated data-directory paths. Rotate/prune by configured retention. Store only a bounded final agent message in Run state.

- [ ] **Step 7: Implement detached process-group supervision**

Spawn with `{ detached:true, shell:false, stdio:['pipe','pipe','pipe'] }`; on timeout call `process.kill(-pid, 'SIGTERM')`, wait `graceMs`, then `process.kill(-pid, 'SIGKILL')`. Handle already-exited errors without rewriting the terminal result.

- [ ] **Step 8: Implement runner ordering and recovery**

Acquire OS lock → claim → mark running → spawn → heartbeat → complete/spool → release lock. Lock contention reports overlap; claim failure never starts Codex; one-time Prompt is kept only in memory.

- [ ] **Step 9: Run phase-2 focused suites**

Run: `node --test test/launchd-scheduler-backend.test.mjs test/scheduler-runner-protocol.test.mjs test/scheduler-runner-spool.test.mjs test/codex-run-spec.test.mjs test/codex-jsonl.test.mjs test/scheduled-runner.test.mjs`
Expected: all phase-2 tests PASS.

- [ ] **Step 10: Update workflow evidence; commit only if explicitly authorized**

---

## Phase 3 — Service, API, Resume, and Distribution

### Task 7: taskd Composition, Public API, and Scheduled Resume

**Files:**
- Modify: `mcp/src/config.mjs`
- Modify: `server/src/taskd-runtime.mjs`
- Modify: `server/src/api-server.mjs`
- Modify: `server/src/session-resume-service.mjs`
- Modify: `server/src/journal-diagnostics.mjs`
- Modify: `ui/src/dashboard-api.mjs`
- Create: `test/scheduled-api.test.mjs`
- Modify: `test/taskd-runtime.test.mjs`
- Modify: `test/session-resume-service.test.mjs`
- Modify: `test/journal-diagnostics.test.mjs`

**Interfaces:**
- Config adds `schedulerDatabasePath`, `schedulerSocketPath`, `schedulerLocksDirectory`, `schedulerLogsDirectory`, `schedulerSpoolDirectory`, caps/retention, and nullable validated `codexPath`.
- Public API routes exactly match the spec.
- `sessionResume.resumeSession({ sessionId, workspace, title })` validates local inventory before calling the terminal adapter.

- [ ] **Step 1: Add failing config and runtime composition tests**

Assert default paths live below `~/.config/tasks-recorder`, taskd constructs/closes both stores once, protocol socket lifecycle is bounded, startup runs spool replay/stale recovery/reconcile in that order, and Scheduler startup failure degrades capability without closing the Journal service.

- [ ] **Step 2: Add failing public API tests**

Exercise list/create/get/patch/pause/resume/run/delete, runs list/detail/log tail/review/resume, revision conflicts, unsupported capability, Prompt omission from list responses where summary is sufficient, same-Origin/Host guards, and one SSE publish per committed mutation.

- [ ] **Step 3: Add failing scheduled Session Resume tests**

Require a valid `thread_id`, existing transcript in `sessionInventory`, canonical Run workspace/title, and allowlisted terminal. Reject browser-supplied workspace or arbitrary session ID on the Run route.

- [ ] **Step 4: Run focused tests and confirm failures**

Run: `node --test test/config.test.mjs test/taskd-runtime.test.mjs test/scheduled-api.test.mjs test/session-resume-service.test.mjs test/journal-diagnostics.test.mjs`
Expected: new contract tests FAIL while existing Recorder tests remain green.

- [ ] **Step 5: Extend config with validated scheduler paths/caps**

Resolve relative scheduler paths under the data directory, reject remote/socket traversal, enforce positive safe caps, and expose no Prompt or secret in returned diagnostics.

- [ ] **Step 6: Compose Scheduler as a degradable sibling plane**

Create Scheduler store/service/backend/protocol after Journal core, replay spool and reconcile on startup, publish Scheduler changes through the existing revision hub, and close protocol/backend/store in deterministic reverse order.

- [ ] **Step 7: Map public routes without domain logic in api-server**

Use existing `requireJson/readJson/sendJson`, add exact status mappings for Schedule errors, and enforce bounded log-tail query values. Never accept absolute paths or command fields.

- [ ] **Step 8: Extend Resume through trusted Run facts**

Resolve the Run from scheduler service, then validate `thread_id` against Codex inventory and pass its immutable Workspace/title to terminal launcher. Return only typed launch metadata.

- [ ] **Step 9: Run focused tests**

Run the Step 4 command.
Expected: all phase-3 integration tests PASS.

- [ ] **Step 10: Record phase evidence; commit only if explicitly authorized**

### Task 8: CLI, Installer, Control, and Release Contract

**Files:**
- Modify: `server/cli.mjs`
- Modify: `server/control.mjs`
- Modify: `install.sh`
- Modify: `scripts/package-release.mjs`
- Modify: `test/cli-import.test.mjs`
- Modify: `test/control.test.mjs`
- Modify: `test/install-script.test.mjs`
- Modify: `test/release-package.test.mjs`
- Modify: `test/package-runtime.test.mjs`

**Interfaces:**
- CLI adds read-oriented `scheduler status` and mutation `scheduler reconcile`; internal runner remains a direct Node entry, not a public arbitrary-exec command.
- Installer persists a valid absolute `codex_path` only when auto-detection succeeds and never overwrites an existing explicit value.
- Uninstall bootouts/removes only verified owned Schedule units and preserves Scheduler DB/logs.

- [ ] **Step 1: Write failing CLI/controller tests**

Assert exact parsing, JSON-only stdout, taskd-unavailable errors, status/reconcile client delegation, no Schedule Prompt/command flags, and `launchctl` cleanup limited to verified owned labels/arguments.

- [ ] **Step 2: Write failing installer/update/package tests**

Assert generated config includes `codex_path` only for an executable absolute detection, reinstall preserves explicit path and scheduler DB, current symlink remains stable, runtime archive contains `server/scheduled-runner.mjs` and scheduler modules, and installed runner executes outside source tree with a fake Codex binary.

- [ ] **Step 3: Run focused tests and confirm failure**

Run: `node --test test/cli-import.test.mjs test/control.test.mjs test/install-script.test.mjs test/release-package.test.mjs test/package-runtime.test.mjs`
Expected: FAIL only on new Scheduler expectations.

- [ ] **Step 4: Implement CLI scheduler status/reconcile**

Use the typed local client; do not open scheduler DB or manipulate launchd from CLI. `reconcile` requires taskd and returns per-Job bounded sync results.

- [ ] **Step 5: Implement Codex path install contract**

At installer execution time use an allowlisted executable lookup from the current interactive environment, canonicalize to an absolute path, verify `codex exec --help` boundedly, then add `codex_path` only to newly created config or when the stored path is absent/invalid and user has not explicitly set it.

- [ ] **Step 6: Implement owned-unit uninstall and package smoke**

Use the backend ownership verifier before bootout/remove. Preserve `scheduler.sqlite`, Schedule logs/spool, and config. Ensure release packaging naturally includes the complete `server/` tree and package smoke starts the installed runner with fake protocol/Codex dependencies.

- [ ] **Step 7: Run focused package gates**

Run the Step 3 command.
Expected: all CLI/install/package Scheduler contracts PASS.

- [ ] **Step 8: Run phase-1 through phase-3 backend tests**

Run: `node --test test/scheduler-*.test.mjs test/launchd-scheduler-backend.test.mjs test/codex-*.test.mjs test/scheduled-runner.test.mjs test/taskd-runtime.test.mjs test/scheduled-api.test.mjs`
Expected: all backend Scheduler tests PASS.

- [ ] **Step 9: Update workflow evidence; commit only if explicitly authorized**

---

## Phase 4 — Scheduled Dashboard

### Task 9: Global View Switch and Scheduled Inbox Shell

**Files:**
- Modify: `ui/src/index.html`
- Modify: `ui/src/dashboard.mjs`
- Modify: `ui/src/dashboard.css`
- Create: `ui/src/scheduled-tasks.mjs`
- Modify: `ui/src/dashboard-api.mjs`
- Create: `test/scheduled-tasks-ui.test.mjs`
- Modify: `test/dashboard-build.test.mjs`

**Interfaces:**
- `createScheduledTasksView({ element, api, onResume, onMessage })` returns `show`, `hide`, `refresh`, `destroy`.
- Global view state is `tasks|scheduled`; Tasks view state remains untouched while hidden.
- API client adds typed Job/Run reads before mutation methods are introduced in Task 10.

- [ ] **Step 1: Write failing nav/accessibility tests**

Assert a leftmost `role=tablist` with visible `Tasks` and `Scheduled` labels, roving tabindex/aria-selected, Scheduled hides Task filters/Timeline tools but not Settings, keyboard arrows switch views, and returning to Tasks preserves Gantt filter/zoom/scroll state.

- [ ] **Step 2: Write failing Scheduled shell states**

Assert loading, empty, unsupported, connection error, sync-error banner, search, All/Active/Paused filters, active/unread counts, sort order, escaped titles/workspaces, and New Task CTA.

- [ ] **Step 3: Run focused tests and confirm failure**

Run: `node --test test/scheduled-tasks-ui.test.mjs test/dashboard-build.test.mjs`
Expected: FAIL because Scheduled panel/controller is absent.

- [ ] **Step 4: Add a separate panel without mounting SVAR in it**

Keep `#gantt_here` as the Tasks renderer root. Add `#scheduled-tasks` hidden by default and switch with `hidden`/aria state; do not destroy/recreate the Gantt instance during navigation.

- [ ] **Step 5: Implement nav composition and preference**

Render the view switch before status tabs. Task controls are conditionally present only in Tasks mode; Settings remains the rightmost global control. Persist only `tasks|scheduled` in localStorage and default safely to Tasks.

- [ ] **Step 6: Implement Scheduled list read model**

Render semantic rows/cards with title, cadence summary, Workspace, next run, last result, unread and enabled state. Use one delegated click handler, escaped HTML, relative time refreshed without refetch, and authoritative refresh on SSE invalidation.

- [ ] **Step 7: Run focused tests and Dashboard build**

Run: `node --test test/scheduled-tasks-ui.test.mjs test/dashboard-build.test.mjs && npm run build`
Expected: tests PASS and compiled Dashboard contains the Scheduled panel without remote assets.

- [ ] **Step 8: Record phase evidence; commit only if explicitly authorized**

### Task 10: Schedule Editor and Mutations

**Files:**
- Create: `ui/src/scheduled-task-editor.mjs`
- Modify: `ui/src/scheduled-tasks.mjs`
- Modify: `ui/src/dashboard-api.mjs`
- Modify: `ui/src/dashboard.css`
- Create: `test/scheduled-task-editor.test.mjs`

**Interfaces:**
- `createScheduledTaskEditor({ element, backdrop, api, onSaved, onMessage })` returns `openCreate`, `openEdit`, `close`, `isOpen`.
- API adds `createSchedule`, `updateSchedule`, `pauseSchedule`, `resumeSchedule`, `runScheduleNow`, `deleteSchedule`, `retryScheduleSync`.

- [ ] **Step 1: Write failing Editor model/markup tests**

Cover title/prompt/workspace limits, cadence builder for all five kinds, system timezone label, server next-run preview, sandbox default read-only, workspace-write warning, danger-full-access explicit confirmation, model/reasoning/timeout options, loading/saving/conflict/sync-error states, focus trap and focus restoration.

- [ ] **Step 2: Write failing mutation client tests**

Assert exact methods/routes/bodies, Job revision inclusion, no command/plist/log path fields, domain error preservation, delete semantics, and Run now not accepting overrides.

- [ ] **Step 3: Run focused tests and confirm failure**

Run: `node --test test/scheduled-task-editor.test.mjs test/dashboard-api.test.mjs`
Expected: FAIL on absent Editor/API methods.

- [ ] **Step 4: Implement pure Editor state helpers first**

Build `normalizeDraft`, `draftToPayload`, `applyServerConflict`, and cadence-field visibility as pure exports. Do not duplicate server next-occurrence logic; preview comes from a typed validation/preview response or saved Job projection.

- [ ] **Step 5: Implement accessible Sheet/Dialog interactions**

Reuse existing Details/Settings spacing, tokens, focus trap, Escape/backdrop close, and motion reduction. Prompt uses a textarea; Workspace and permission warnings remain visible without hover.

- [ ] **Step 6: Wire mutations with optimistic conflict recovery**

Disable duplicate submits, preserve the local draft on version conflict, show the newest server revision, keep a persisted Job visible when `sync_state=error`, and offer Retry Sync without resubmitting Prompt.

- [ ] **Step 7: Run focused tests and build**

Run: `node --test test/scheduled-task-editor.test.mjs test/dashboard-api.test.mjs test/scheduled-tasks-ui.test.mjs && npm run build`
Expected: Editor/client/list tests PASS.

- [ ] **Step 8: Record phase evidence; commit only if explicitly authorized**

### Task 11: Run Review, Logs, and Resume

**Files:**
- Create: `ui/src/scheduled-run-review.mjs`
- Modify: `ui/src/scheduled-tasks.mjs`
- Modify: `ui/src/dashboard-api.mjs`
- Modify: `ui/src/dashboard.css`
- Create: `test/scheduled-run-review.test.mjs`

**Interfaces:**
- `createScheduledRunReview({ element, backdrop, api, onResumed, onMessage })` returns `open(jobId, runId?)`, `close`, `refresh`, `isOpen`.
- API adds `scheduleRuns`, `scheduledRun`, `scheduledRunLog`, `markScheduledRunReviewed`, `resumeScheduledRun`.

- [ ] **Step 1: Write failing history/review tests**

Cover all Run statuses, scheduled/manual/catchup trigger, relative/absolute timestamps, duration, thread ID copy, unread/read, final message escaping, no-result state, bounded stdout/stderr tabs, truncation marker, Resume availability and typed errors.

- [ ] **Step 2: Write failing list-to-review interaction tests**

Opening a Run marks nothing automatically; Mark reviewed is explicit; returning to list updates unread count after server commit; Resume only sends Run ID; switching Jobs cancels stale log fetches.

- [ ] **Step 3: Run focused tests and confirm failure**

Run: `node --test test/scheduled-run-review.test.mjs test/dashboard-api.test.mjs`
Expected: FAIL because review controller/client methods are absent.

- [ ] **Step 4: Implement Run presentation helpers**

Map status to semantic text/icon/color without raw JSON. Final message is primary content; logs are secondary monospace tails. Do not render absolute filesystem log paths.

- [ ] **Step 5: Implement bounded log loading and cancellation**

Request a fixed maximum tail; switch stdout/stderr via tabs; use `AbortController` or request generation to ignore stale results; show truncation and typed errors without clearing a previously loaded final message.

- [ ] **Step 6: Wire Mark reviewed, copy, and Resume**

Copy complete thread ID, send only Run ID to Resume route, reuse existing global terminal settings, and restore focus to the originating Run row after close.

- [ ] **Step 7: Run all phase-4 tests and build**

Run: `node --test test/scheduled-tasks-ui.test.mjs test/scheduled-task-editor.test.mjs test/scheduled-run-review.test.mjs test/dashboard-api.test.mjs test/dashboard-build.test.mjs && npm run build`
Expected: all Scheduled UI contracts PASS and bundle builds.

- [ ] **Step 8: Update workflow evidence; commit only if explicitly authorized**

---

## Phase 5 — End-to-End, Visual, Documentation, and Rollout

### Task 12: Cross-Layer Integration and Failure Matrix

**Files:**
- Create: `test/scheduled-runtime-e2e.test.mjs`
- Modify focused implementation/tests only when this integration test proves a contract gap.

**Interfaces:**
- Uses fake `launchctl` and fake Codex executable to exercise the packaged taskd/runner boundary without network/model usage.

- [ ] **Step 1: Build a fake Codex executable fixture**

The fixture reads Prompt from stdin, fails if Prompt appears in argv, emits chunked `thread.started`, `turn.started`, agent-message and `turn.completed` JSONL, optionally spawns a child process, sleeps, exits nonzero, or ignores TERM based on a non-secret test mode.

- [ ] **Step 2: Write create → reconcile → trigger → review E2E**

Start isolated taskd with separate data/socket/port, create a Schedule through HTTP, verify owned plist payload via fake backend, trigger runner, and assert Run success/thread/final message/log/review/SSE plus eventual Recorder Source Session fixture correlation.

- [ ] **Step 3: Write concurrency and recovery E2E**

Race scheduled and manual triggers, assert one Codex process plus one `skipped_overlap`; restart taskd during a running fixture, assert completion spool replay; crash runner and assert multi-evidence `lost`; timeout a TERM-ignoring process tree and assert no surviving child PID.

- [ ] **Step 4: Write mutation race E2E**

Edit/Pause/Delete while a Run is active; assert active spec remains immutable, future unit desired state changes correctly, history remains, and Pause does not mislabel the active Run canceled.

- [ ] **Step 5: Run E2E and full automated suite**

Run: `node --test test/scheduled-runtime-e2e.test.mjs && npm test && npm run check && npm run build && git diff --check`
Expected: Scheduler E2E PASS, full suite has zero failures, syntax/build/diff checks pass.

- [ ] **Step 6: Record failures as new task contracts, not ad hoc patches**

If the E2E reveals a spec gap, update `01-plan.md`, append a new immutable task file after plan approval rules, and record the reason in the phase log before implementation.

- [ ] **Step 7: Record phase evidence; commit only if explicitly authorized**

### Task 13: Real macOS Run, Visual Review, Docs, and Package Audit

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-08-19-project-journalist-lifecycle-design.md`
- Modify: `docs/job/tasks-recorder-scheduled-tasks/04-test-plan.md`
- Modify: `docs/job/tasks-recorder-scheduled-tasks/05-test-cases.md`
- Modify: `docs/job/tasks-recorder-scheduled-tasks/06-test-report.md`
- Modify other matching Markdown files found by the required full documentation scan.

**Interfaces:**
- Produces authoritative test evidence and user-facing How it works/operations documentation.

- [ ] **Step 1: Materialize test plan and case matrix from completed tasks**

Include cadence/DST, schema/invariants, privacy, owned launchd units, no-overlap, timeout process tree, taskd restart/spool, API/security, install/update/uninstall, UI states/accessibility/responsive, real scheduling, Hook correlation, Review and Resume. Every risk maps to at least one case.

- [ ] **Step 2: Start an isolated source preview/backend**

Use non-production port and isolated data directory for mutation/visual states. Do not reuse the installed real database for destructive UI tests. Build source Dashboard and confirm console has no errors before review.

- [ ] **Step 3: Run `visual-driven-review` with Playwright MCP**

Verify desktop and narrow widths across Tasks, Scheduled empty, loading, unsupported, active, paused, sync error, running, success Review, failure/log, Editor permissions, keyboard/focus, overflow and reduced motion. Capture screenshots and record every Major/Minor finding with disposition.

- [ ] **Step 4: Execute a real 2–3 minute launchd/Codex Schedule**

Use an isolated harmless read-only Prompt and Workspace, verify `launchctl print`, wait for OS trigger, then prove thread ID, terminal Run status, Hook-recorded Source Session/Execution, Review result and Resume. Do not use `danger-full-access` for this gate.

- [ ] **Step 5: Verify sleep/wake evidence or record the exact unverified gap**

When practical, schedule a harmless Run, sleep past multiple occurrences, wake and prove exactly one catch-up. If not practical, cite `launchd.plist(5)` plus automated due/reconcile tests and mark real sleep/wake as not directly exercised; do not claim it passed.

- [ ] **Step 6: Update README and architecture docs**

Document installation prerequisite/Codex path, Tasks/Scheduled navigation, creating/pausing/Run now/Review/Resume, standalone-new-thread semantics, permissions, system timezone, missed-run/no-retry policy, files/logs, scheduler status/reconcile, troubleshooting, uninstall preservation, and Automation/Recorder plane separation.

- [ ] **Step 7: Run the required full documentation scan**

Run:

```bash
git diff --name-only HEAD
find . -name '*.md' -not -path '*/node_modules/*' -not -path '*/.git/*'
```

Search every changed path/module/symbol/behavior across the Markdown tree and update matching docs. If no additional files need changes, record exactly `扫描了文档树，无需同步` in the phase log/test report.

- [ ] **Step 8: Run release/package/install audit**

Run: `npm test && npm run check && npm run build && npm run build:adapters && npm run package:release -- --output <isolated-temp-output>`; inspect archive allowlist, verify no Prompt/test logs/SQLite/runtime locks are packaged, and run installed-runtime smoke with fake Codex.

- [ ] **Step 9: Final completion audit against every spec requirement**

For each explicit v1 requirement and Out-of-Scope statement, point to authoritative code/test/runtime/visual/doc evidence. Missing or indirect evidence stays incomplete. Only after all P0 cases pass may workflow status become `done`.

- [ ] **Step 10: Present commit/release/local-update checkpoints separately**

Implementation completion does not authorize commit, push, GitHub Release, or installed-service mutation. Present the exact file list and verification evidence; request explicit authorization before each external Git/release/local-update action.

---

## Self-Review

### Spec coverage

- Product entry and Scheduled panel: Tasks 9–11.
- Separate Automation plane/database and taskd-only ownership: Tasks 2–3, 7.
- Structured cadence/system timezone/missed-run: Tasks 1, 4, 12–13.
- launchd desired-state reconciliation and owned cleanup: Tasks 4, 8.
- Unix socket/spool: Task 5.
- no-overlap/immutable claim/process-group timeout/Codex stdin+JSONL: Task 6 and Task 12.
- public API, diagnostics, Resume, SSE: Task 7.
- installer/stable paths/package/uninstall: Task 8 and Task 13.
- Review inbox/editor/history/logs: Tasks 9–11.
- real OS/Codex/Hook/visual/docs validation: Task 13.
- Out-of-Scope items remain absent from every implementation task.

### Placeholder scan

The plan contains no deferred implementation placeholders. Any execution-discovered spec gap must become an explicit reviewed task instead of an untracked side change.

### Type consistency

- Cadence names and fields match the spec and Task 1 exports.
- Job/Run service methods are defined once in Task 3 and consumed by Tasks 5, 7, and 8.
- Runner ordering and protocol method names match Tasks 5–6.
- Dashboard API names match the controllers in Tasks 9–11.

## Plan Checkpoint

After user approval, create `docs/job/tasks-recorder-scheduled-tasks/02-tasks.md`, phase logs, and one immutable task contract per Task 1–13. Execution should use `subagent-driven-development` with fresh worker context and spec/plan review after each task, while preserving the no-auto-commit rule.
