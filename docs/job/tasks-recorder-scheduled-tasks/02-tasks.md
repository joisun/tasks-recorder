# 任务总览

> **Historical / superseded (2026-08-27)**：这是早期 Scheduler 任务清单，不代表现行 execution path。当前架构见 [`README.md`](../../../README.md) 与 [`Runtime Agent Registry 设计`](../../superpowers/specs/2026-08-27-runtime-agent-registry-design.md)。

## phase-1-scheduler-domain

- [x] [task-01-structured-cadence](./tasks/phase-1-scheduler-domain/task-01-structured-cadence.md) — 结构化 cadence、next occurrence、summary 与 launchd calendars。
- [x] [task-02-scheduler-store](./tasks/phase-1-scheduler-domain/task-02-scheduler-store.md) — scheduler schema v1、Job/Run ledger 与 invariants。
- [x] [task-03-scheduler-service](./tasks/phase-1-scheduler-domain/task-03-scheduler-service.md) — desired-state Job/Run domain service。

## phase-2-native-runner

- [x] [task-04-launchd-backend](./tasks/phase-2-native-runner/task-04-launchd-backend.md) — owned plist 与 generation-safe reconciliation。
- [x] [task-05-runner-protocol-spool](./tasks/phase-2-native-runner/task-05-runner-protocol-spool.md) — 0600 Unix socket 与 bounded runner spool。
- [x] [task-06-codex-supervisor](./tasks/phase-2-native-runner/task-06-codex-supervisor.md) — lock、Codex JSONL、process-group timeout 与 runner entry。

## phase-3-service-integration

- [x] [task-07-runtime-api-resume](./tasks/phase-3-service-integration/task-07-runtime-api-resume.md) — taskd composition、public API、diagnostics 与 Resume。
- [x] [task-08-cli-install-release](./tasks/phase-3-service-integration/task-08-cli-install-release.md) — CLI、installer、owned uninstall 与 package contract。

## phase-4-scheduled-dashboard

- [x] [task-09-view-switch-inbox](./tasks/phase-4-scheduled-dashboard/task-09-view-switch-inbox.md) — nav switch 与 Scheduled inbox shell。
- [x] [task-10-schedule-editor](./tasks/phase-4-scheduled-dashboard/task-10-schedule-editor.md) — Schedule Editor、permissions 与 mutations。
- [x] [task-11-run-review](./tasks/phase-4-scheduled-dashboard/task-11-run-review.md) — Run history、logs、Review 与 Resume。

## phase-5-validation-rollout

- [x] [task-12-scheduled-e2e](./tasks/phase-5-validation-rollout/task-12-scheduled-e2e.md) — 6 组 fake launchctl/Codex 跨层 E2E 已通过，包含 crash→lost、offline replay、immutable edit/delete 与 Recorder correlation。
- [~] [task-13-real-visual-docs](./tasks/phase-5-validation-rollout/task-13-real-visual-docs.md) — file-native redesign、VDR、docs 与 package audit；真实 launchd/Codex 和 sleep/wake 仍未执行。
