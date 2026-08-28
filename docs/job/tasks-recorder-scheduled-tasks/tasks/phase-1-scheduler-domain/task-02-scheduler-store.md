# task-02-scheduler-store

> **Historical task**：本任务交付的 schema v1 Job store 已在 2026-08-25 被 Markdown registry + schema v2 Run ledger supersede；参见 [`2026-08-25-file-native-scheduled-tasks-design.md`](../../../../superpowers/specs/2026-08-25-file-native-scheduled-tasks-design.md)。

**所属 phase**：phase-1-scheduler-domain
**前置依赖**：task-01 的 normalized Cadence JSON contract。

## 目标

建立独立 `scheduler.sqlite` schema v1 和 taskd-only Job/Run store，保存 desired state 与不可伪造的运行事实。

## 涉及范围

- 新建：`server/src/scheduler/scheduler-schema.mjs`
- 新建：`server/src/scheduler/scheduler-store.mjs`
- 新建：`server/src/scheduler/scheduler-errors.mjs`
- 新建：`test/scheduler-store.test.mjs`
- 不涉及：launchd、runner process、public API。

## 验收标准

- [ ] database/parent directory 权限分别为 0600/0700，WAL/foreign keys/STRICT/user_version=1。
- [ ] Jobs 支持 revision CAS、generation/sync state、enable、soft delete、next/last run。
- [ ] Runs 固化 job revision/spec，支持 claim/running/heartbeat/terminal/review，nonce completion 幂等。
- [ ] 每 Job 最多一个 active Run；soft delete 不删除 history。
- [ ] integrity、foreign key 与 domain invariants 一起报告。
- [ ] focused tests 与 `git diff --check` 通过。

## 备注

runner 绝不能导入或打开本 store。
