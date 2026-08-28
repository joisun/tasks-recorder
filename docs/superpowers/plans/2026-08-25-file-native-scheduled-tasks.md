# File-native Scheduled Tasks Implementation Plan

> **Historical / partially superseded (2026-08-27)**：Markdown definition 仍然有效，但本文中的 per-Schedule `launchd` / runner execution path 已退役。当前架构见 [`README.md`](../../../README.md) 与 [`Runtime Agent Registry 设计`](../specs/2026-08-27-runtime-agent-registry-design.md)。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Scheduled Tasks 的当前定义迁移为自定义目录中的 Markdown source of truth，同时保留可靠的 SQLite Run ledger。

**Architecture:** 新的 codec/repository/monitor 提供 file-native definition registry；scheduler service 组合 definitions、ledger 与 launchd。SQLite v2 不保存当前定义，只保存运行事实、immutable execution evidence 与可重建 sync state。

**Tech Stack:** Node.js 24 ESM、`yaml`、`node:sqlite`、launchd、vanilla DOM UI、Node test runner

**Spec:** `docs/superpowers/specs/2026-08-25-file-native-scheduled-tasks-design.md`

## Global Constraints

- Markdown 是未来执行的唯一 source of truth；SQLite 不保存当前 definition 字段。
- 只识别 `type: tasks-recorder/schedule` 的 Markdown，递归 scan 时忽略 dot directories。
- invalid、duplicate、removed、paused 均 fail closed。
- Dashboard file writes 必须 atomic、CAS-protected、recoverable delete。
- 默认 root 为 `~/.config/tasks-recorder/schedules`；v1 只支持一个 root。
- 不修改或安装正式用户数据库；所有迁移测试使用临时目录。
- 未经用户明确要求不 commit、push、release 或本地安装。

---

### Task 1: Markdown codec

**Files:**
- Create: `server/src/scheduler/schedule-definition-codec.mjs`
- Create: `test/schedule-definition-codec.test.mjs`
- Modify: `package.json`, `package-lock.json`

**Interfaces:**
- Produces: `parseScheduleDefinition(source, { sourcePath, clock }) -> Job`
- Produces: `serializeScheduleDefinition(job) -> string`
- Produces: `definitionEtag(source) -> sha256 hex`

- [x] Write failing tests for marker filtering, valid daily/weekly definitions, round-trip, duration, malformed YAML and unsupported fields.
- [x] Run `node --test test/schedule-definition-codec.test.mjs`; expect focused failures.
- [x] Add `yaml` dependency and implement strict codec with no handwritten YAML parsing.
- [x] Re-run focused tests; expect pass.

### Task 2: File repository and monitor

**Files:**
- Create: `server/src/scheduler/schedule-definition-repository.mjs`
- Create: `server/src/scheduler/schedule-definition-monitor.mjs`
- Create: `test/schedule-definition-repository.test.mjs`
- Create: `test/schedule-definition-monitor.test.mjs`

**Interfaces:**
- Produces: `createScheduleDefinitionRepository({ rootDirectory, clock })`
- Repository methods: `scan()`, `list()`, `get(id)`, `create(input)`, `update(id, expectedEtag, patch)`, `setEnabled(id, expectedEtag, enabled)`, `remove(id, expectedEtag)`.
- Produces: `createScheduleDefinitionMonitor({ repository, onDiff, rescanMs })` with `start()` and `close()`.

- [x] Write repository tests for nested scan, ordinary Markdown ignore, duplicate ID, CAS conflict, atomic create/update and `.trash` delete.
- [x] Run repository tests; expect focused failures.
- [x] Implement repository with canonical root checks, regular-file checks, temp/fsync/rename writes and bounded validation records.
- [x] Write monitor tests using injected watcher/timers for debounce, invalid diff and periodic rescan.
- [x] Implement monitor and run both focused suites; expect pass.

### Task 3: SQLite v2 Run ledger

**Files:**
- Modify: `server/src/scheduler/scheduler-schema.mjs`
- Modify: `server/src/scheduler/scheduler-store.mjs`
- Modify: `test/scheduler-store.test.mjs`
- Create: `server/src/scheduler/scheduler-migration.mjs`
- Create: `test/scheduler-migration.test.mjs`

**Interfaces:**
- Store no longer exposes `jobs`; it exposes `sync`, `dispatches`, `runs`.
- `runs.claim({ definition, trigger, dispatch, scheduled_for })` persists immutable `spec_json` and returns `{run, nonce, spec}`.
- `migrateSchedulerV1({ databasePath, repository, clock })` is conflict-safe and idempotent.

- [x] Rewrite schema/store tests to assert no current definition columns/table dependency and history survival after definition removal.
- [x] Run store tests; expect schema mismatch failures.
- [x] Implement v2 schema and definition-independent run/dispatch operations.
- [x] Add migration success, conflict, rollback and repeat-run tests.
- [x] Implement migration with file-first round-trip validation and transactional v2 switch.
- [x] Run store and migration suites; expect pass.

### Task 4: Service, runtime and launchd integration

**Files:**
- Modify: `server/src/scheduler/scheduler-service.mjs`
- Modify: `server/src/taskd-runtime.mjs`
- Modify: `mcp/src/config.mjs`
- Modify: `server/src/scheduler/launchd-backend.mjs`
- Modify: `server/scheduled-runner.mjs`
- Modify: `test/scheduler-service.test.mjs`
- Modify: `test/taskd-runtime.test.mjs`
- Modify: `test/launchd-scheduler-backend.test.mjs`
- Modify: `test/scheduled-runtime-e2e.test.mjs`

**Interfaces:**
- `createSchedulerService({ definitions, store, backend, runnerDispatcher, clock })`.
- Config adds absolute `scheduleDefinitionsDirectory` from `schedule_definitions_dir`.
- Service mutation responses expose `etag` and `source_path`; mutations consume `expected_etag`.

- [x] Add failing service tests proving claim reads current file and removed/invalid/paused definitions cannot claim.
- [x] Refactor service CRUD/reconcile/list composition around repository and sync ledger.
- [x] Wire migration, repository and monitor lifecycle into taskd; publish SSE invalidation on definition diff.
- [x] Update launchd generation/stale handling for etag-backed definitions.
- [x] Run service/runtime/launchd/E2E focused suites; expect pass.

### Task 5: API, Settings and editor

**Files:**
- Modify: `server/src/api-server.mjs`
- Modify: `server/control.mjs`
- Modify: `ui/src/dashboard-api.mjs`
- Modify: `ui/src/scheduled-task-editor.mjs`
- Modify: `ui/src/scheduled-tasks.mjs`
- Modify: `ui/src/settings-dialog.mjs`
- Modify: `ui/src/dashboard.mjs`
- Modify: `test/scheduled-api.test.mjs`
- Modify: `test/scheduled-dashboard-api.test.mjs`
- Modify: `test/scheduled-task-editor.test.mjs`
- Modify: `test/scheduled-tasks-ui.test.mjs`

**Interfaces:**
- API PATCH/action/delete bodies use `expected_etag`.
- Settings API adds `schedule_definitions_dir` and validates the target directory. Task 8 upgrades path changes from the initial restart contract to transactional runtime relocation.
- Scheduled detail response includes `source_path`, `etag`, parse/sync errors.

- [x] Write failing API/UI tests for etag CAS, source path, file-backed mutations and Settings directory validation.
- [x] Update API serializers and exact-body allowlists.
- [x] Update Dashboard client/editor/list/settings without changing route names.
- [x] Run focused API/UI tests; expect pass.

### Task 6: Remove decorative microcopy and visually verify

**Files:**
- Modify: `ui/src/settings-dialog.mjs`
- Modify: `ui/src/scheduled-tasks.mjs`
- Modify: `ui/src/scheduled-task-editor.mjs`
- Modify: `ui/src/scheduled-run-review.mjs`
- Modify: `ui/src/dashboard.css`
- Modify: `test/dashboard-build.test.mjs`
- Modify: related UI markup tests

- [x] Add markup assertions that decorative kicker strings are absent while semantic headings remain.
- [x] Remove kicker/version elements and collapse their layout space.
- [x] Build with `npm run build`.
- [x] Use Playwright MCP at desktop and 390px mobile for Scheduled list, Settings, Editor, invalid file and conflict states; capture overflow, focus and console evidence.

### Task 7: Documentation, migration audit and final gates

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-08-24-scheduled-tasks-design.md`
- Modify: `docs/job/tasks-recorder-scheduled-tasks/05-test-cases.md`
- Modify: `docs/job/tasks-recorder-scheduled-tasks/06-test-report.md`
- Modify: related phase/progress documents

- [x] Run `git diff --name-only HEAD` and full Markdown reference scan required by project policy.
- [x] Update README architecture, file format, custom directory, migration, troubleshooting and privacy text.
- [x] Run `npm run check`, `npm test`, `npm run build`, `npm run build:adapters`, `npm run package:release`.
- [x] Audit release archive: definition source included, no temp definitions, DBs, logs, spool or private paths included.
- [x] Record exact passed/failed/not-directly-tested evidence; do not claim real sleep/wake validation without evidence.
- [x] Present scoped diff and verification summary; do not commit unless the user explicitly requests it.

### Task 8: Hot-relocate the Schedule definitions root

**Files:**
- Create: `server/src/scheduler/schedule-definition-relocation.mjs`
- Create: `test/schedule-definition-relocation.test.mjs`
- Modify: `server/src/scheduler/scheduler-service.mjs`
- Modify: `server/src/taskd-runtime.mjs`
- Modify: `server/src/dashboard-settings.mjs`
- Modify: `server/src/api-server.mjs`
- Modify: `ui/src/settings-dialog.mjs`
- Modify: `test/scheduler-service.test.mjs`
- Modify: `test/taskd-runtime.test.mjs`
- Modify: `test/dashboard-settings.test.mjs`
- Modify: `test/settings-dialog.test.mjs`
- Modify: `README.md` and workflow evidence documents

**Interfaces:**
- Produces: `stageScheduleDefinitionRelocation({ sourceRepository, targetDirectory, clock }) -> { candidateRepository, verifySource(), commit(), rollback() }`.
- Scheduler runtime consumes: `relocateDefinitionsDirectory({ directory, persist }) -> { moved_count, merged_count, cleanup_warning }`.
- Scheduler service consumes an active repository proxy so CRUD, claim, list and monitor diff handling always resolve the same current registry.
- Settings update delegates `schedule_definitions_dir` to the runtime relocation callback; it no longer returns `restart_required: true`.

- [x] Write failing relocation tests for successful nested copy/verify, existing non-conflicting target merge, ID/path conflicts, invalid source, target-local staging/rename semantics, rollback and old-root archival.
- [x] Run `node --test test/schedule-definition-relocation.test.mjs`; verify failures describe missing relocation behavior.
- [x] Implement the standalone staged relocation transaction using repository scans, private hidden staging, fsync/rename publication and recoverable old-root archival.
- [x] Re-run the relocation suite; 6/6 cases pass, including external-writer preservation and deferred watcher diff delivery.
- [x] Write failing service/runtime tests proving concurrent mutations serialize behind relocation, active repository/watcher swap once, reconcile uses the merged target set, and cleanup failure remains a bounded warning.
- [x] Add the active repository controller, runtime relocation queue and handoff diff buffer; wire Settings persistence only after the candidate registry becomes active.
- [x] Run the focused service/runtime/settings/monitor/relocation suites; 41/41 pass.
- [x] Write failing UI tests proving successful save says the library moved immediately and no restart copy remains.
- [x] Update Settings response/UI copy and run UI/build regressions; pass.
- [x] Build and visually verify directory relocation in the isolated source preview: same ID/etag and new source path after move, Create writes only to new root, canonical path/result copy render at 1440×900 and 390×844 without overflow.
- [x] Update README, spec and workflow test evidence; run the required full Markdown reference scan.
- [x] Run `npm run check`, `npm test`, `npm run build`, `npm run build:adapters`, isolated `npm run package:release`, archive audit and `git diff --check`; final full suite 516/516.
- [x] Present the scoped diff and remaining real macOS launchd/sleep-wake limitation; do not commit, publish or install without explicit authorization.
