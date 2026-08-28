# Scheduled Execution Observability Implementation Plan

> **Historical / partially superseded (2026-08-27)**：Run ledger 与 execution evidence 仍然有效，但本文中的 dispatch / runner execution path 已退役。当前架构见 [`README.md`](../../../README.md) 与 [`Runtime Agent Registry 设计`](../specs/2026-08-27-runtime-agent-registry-design.md)。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `Run now` 成为可实时观察、可追溯产出、可从 terminal 召回 Session 的 durable execution flow，并重构 Scheduled UI 为 compact list + Run ledger Sheet。

**Architecture:** SQLite 同时保存 manual dispatch attempt 和 immutable Run evidence；Schedule API 把 pending dispatch 与 Run 聚合为 execution read model。Runner 从 Codex JSONL 收集 bounded Workspace-relative file changes，并通过 protocol/spool 完整传递；runner mutation 通过 revision hub 驱动 Dashboard SSE。UI 不依赖 toast，而是渲染 read model。

**Tech Stack:** Node.js 24 ESM、`node:sqlite`、native HTML/CSS/JavaScript、SSE、Node test runner、Playwright MCP。

**Spec:** `docs/superpowers/specs/2026-08-26-scheduled-execution-observability-design.md`

## Global Constraints

- 不新增 runtime 或 UI dependency。
- 不扫描 Workspace 推断产出，只消费 successful Codex `file_change` JSONL evidence。
- 不向浏览器暴露 absolute log path、任意 shell command 或 browser-supplied Session/Workspace。
- 保持 Run snapshot immutable、manual/scheduled 共用 runner/no-overlap path。
- 保留 worktree 中现有未提交改动；本任务不创建 commit。

---

### Task 1: Durable Dispatch Attempts and Read Model

**Files:**
- Modify: `server/src/scheduler/scheduler-schema.mjs`
- Modify: `server/src/scheduler/scheduler-migration.mjs`
- Modify: `server/src/scheduler/scheduler-store.mjs`
- Modify: `server/src/scheduler/scheduler-service.mjs`
- Modify: `server/src/api-server.mjs`
- Test: `test/scheduler-store.test.mjs`
- Test: `test/scheduler-service.test.mjs`
- Test: `test/scheduler-migration.test.mjs`
- Test: `test/scheduled-api.test.mjs`

**Interfaces:**
- Produces: `store.dispatches.oldestPending(jobId)`, `store.dispatches.recordAttempt(id, { error_code })`, `schedulerService.listDispatches(jobId?)`。
- Produces: Schedule list `current_execution` and Run list `dispatches`。

- [x] **Step 1: Write failing tests** for v2-to-v3 migration, one pending dispatch per Schedule, retry attempt count/error persistence, and serialized queued/dispatch-failed execution summaries.
- [x] **Step 2: Run focused tests and verify RED**:

```bash
node --test test/scheduler-store.test.mjs test/scheduler-service.test.mjs test/scheduler-migration.test.mjs test/scheduled-api.test.mjs
```

- [x] **Step 3: Implement schema/store/service/API changes**. `runNow()` must reuse `oldestPending()` when no explicit idempotency key is supplied, call dispatcher, then persist `recordAttempt()` before returning.
- [x] **Step 4: Run the same focused tests and verify GREEN**.

### Task 2: Runner Lifecycle Revisions

**Files:**
- Modify: `server/src/scheduler/runner-protocol.mjs`
- Modify: `server/src/taskd-runtime.mjs`
- Test: `test/scheduler-runner-protocol.test.mjs`
- Test: `test/taskd-runtime.test.mjs`
- Test: `test/scheduled-runtime-e2e.test.mjs`

**Interfaces:**
- Produces: `createRunnerProtocolServer({ ..., onChange })` callback after successful `claim`, `reportOverlap`, `mark_running`, and `complete`.

- [x] **Step 1: Write failing protocol tests** proving lifecycle mutations publish once and heartbeat/read operations do not.
- [x] **Step 2: Run tests and verify RED**:

```bash
node --test test/scheduler-runner-protocol.test.mjs test/taskd-runtime.test.mjs
```

- [x] **Step 3: Invoke `onChange({ operation })` only after a successful mutation response and wire it to `hub.publish()` in taskd runtime**.
- [x] **Step 4: Run focused protocol/runtime tests and the cross-process lifecycle test**.

### Task 3: File-Change Completion Evidence

**Files:**
- Modify: `server/src/scheduler/codex-jsonl.mjs`
- Modify: `server/src/scheduler/process-supervisor.mjs`
- Modify: `server/scheduled-runner.mjs`
- Modify: `server/src/scheduler/runner-spool.mjs`
- Modify: `server/src/taskd-runtime.mjs`
- Modify: `server/src/scheduler/scheduler-schema.mjs`
- Modify: `server/src/scheduler/scheduler-store.mjs`
- Modify: `server/src/scheduler/scheduler-service.mjs`
- Modify: `server/src/api-server.mjs`
- Test: `test/codex-jsonl.test.mjs`
- Test: `test/scheduled-runner.test.mjs`
- Test: `test/scheduler-runner-spool.test.mjs`
- Test: `test/scheduler-store.test.mjs`
- Test: `test/scheduled-api.test.mjs`

**Interfaces:**
- Produces: collector result `file_changes: Array<{path:string, kind:'add'|'update'|'delete'}>`.
- Produces: Run API `file_changes` with Workspace-relative paths.

- [x] **Step 1: Write failing collector tests** for completed-only events, path containment, dedupe, UTF-8, unknown kind and hard caps.
- [x] **Step 2: Write failing runner/store/API tests** proving direct completion and spool replay retain file changes and never expose absolute Workspace paths.
- [x] **Step 3: Run focused tests and verify RED**:

```bash
node --test test/codex-jsonl.test.mjs test/scheduled-runner.test.mjs test/scheduler-runner-spool.test.mjs test/scheduler-store.test.mjs test/scheduled-api.test.mjs
```

- [x] **Step 4: Implement the bounded evidence pipeline**, including `file_changes_json` validation and v2 migration default `NULL`.
- [x] **Step 5: Run the focused tests and verify GREEN**.

### Task 4: Compact Schedule List and Run Ledger Sheet

**Files:**
- Modify: `ui/src/scheduled-tasks.mjs`
- Modify: `ui/src/scheduled-run-review.mjs`
- Modify: `ui/src/dashboard.mjs`
- Modify: `ui/src/dashboard.css`
- Modify: `test/scheduled-tasks-ui.test.mjs`
- Modify: `test/scheduled-run-review.test.mjs`
- Modify: `test/dashboard-build.test.mjs`

**Interfaces:**
- Consumes: Schedule `current_execution`; Run history `{ runs, dispatches }`; Run `file_changes` and `thread_id`.
- Produces: `scheduledExecutionPresentation(execution)` and table-based Sheet markup/actions.

- [x] **Step 1: Write failing markup tests** that forbid `Runs`, `ACTIVE`, `已同步`, green row rail selectors and normal mutation alert; require current execution, loading button, ledger table, Outputs, Session copy and Resume actions.
- [x] **Step 2: Write failing interaction tests** for dispatch response states, Sheet open from execution summary, copy Session and authoritative Run-ID Resume.
- [x] **Step 3: Run UI tests and verify RED**:

```bash
node --test test/scheduled-tasks-ui.test.mjs test/scheduled-run-review.test.mjs test/dashboard-build.test.mjs
```

- [x] **Step 4: Refactor markup and CSS** to compact table-like rows plus full-width mobile Sheet; use semantic status text/icon, 44px hit areas and reduced-motion-safe loading.
- [x] **Step 5: Run UI tests and `npm run build`**.

### Task 5: Cross-Layer Verification and Documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/job/tasks-recorder-scheduled-tasks/03-phases.md`
- Modify: matching Scheduled docs found by documentation scan
- Evidence: `.vdr-log/2026-08-26-scheduled-execution-observability/`

**Interfaces:**
- Consumes all prior tasks.

- [x] **Step 1: Run focused end-to-end verification** with fake Codex emitting `thread.started`, completed `file_change`, and terminal result; assert queued -> running -> succeeded and resumable Session metadata.
- [x] **Step 2: Run full code gates**:

```bash
npm test
npm run check
npm run build
git diff --check
```

- [x] **Step 3: Scan the full Markdown tree** for affected behavior and update README/architecture/job docs.
- [x] **Step 4: Run Visual-Driven Review** at desktop 1440x900 and mobile 375x812 against the isolated preview; cover initial, running, succeeded, failed, Sheet, logs, empty and error states.
- [x] **Step 5: Record remaining OS-only gate** for real launchd/Codex execution without claiming it from fake-runner evidence.
