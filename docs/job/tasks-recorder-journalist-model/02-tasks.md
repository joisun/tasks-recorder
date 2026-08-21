# 任务总览

> Task 详情在对应 phase 开始时冻结。phase 1 已完成，当前物化 phase 2 详情；后续 phase 在上游 contract 尚未实证前保持 summary，避免形成伪精确计划。phase summary 与退出条件以 [`01-plan.md`](./01-plan.md) 为准。

## phase-1-data-foundation

- [x] [task-01-schema-v3-contract](./tasks/phase-1-data-foundation/task-01-schema-v3-contract.md) — 独立定义并验证 schema v3 DDL 与完整性约束。
- [x] [task-02-v2-v3-migration](./tasks/phase-1-data-foundation/task-02-v2-v3-migration.md) — 实现 inventory、dry-run、backup、apply 与 invariant report。
- [x] [task-03-project-domain](./tasks/phase-1-data-foundation/task-03-project-domain.md) — 实现 Project/Location store 与不依赖 branch 的 resolver。
- [x] [task-04-work-journal](./tasks/phase-1-data-foundation/task-04-work-journal.md) — 实现 Observation/Session/Execution/Segment/Attribution lifecycle。
- [x] [task-05-v3-domain-facade](./tasks/phase-1-data-foundation/task-05-v3-store-cutover.md) — 组合独立 v3 JournalStore；双栈就绪前不切断 v2 runtime。

## phase-2-ingestion-reliability

- [x] [task-01-event-ingest](./tasks/phase-2-ingestion-reliability/task-01-event-ingest.md) — Event Envelope validation 与幂等 ingest API。
- [x] [task-02-bounded-spool](./tasks/phase-2-ingestion-reliability/task-02-bounded-spool.md) — bounded spool、权限、轮转与 replay。
- [x] [task-03-lifecycle-recovery](./tasks/phase-2-ingestion-reliability/task-03-lifecycle-recovery.md) — lifecycle transition、Stop fail-open 与 startup recovery。
- [x] [task-04-logs-status](./tasks/phase-2-ingestion-reliability/task-04-logs-status.md) — structured logs、retention 与 status diagnostics。

## phase-3-semantic-control

- [x] [task-01-work-context](./tasks/phase-3-semantic-control/task-01-work-context.md) — compact work context 与 deterministic candidate isolation。
- [x] [task-02-semantic-commands](./tasks/phase-3-semantic-control/task-02-semantic-commands.md) — focus/Attribution/checkpoint/Task mutation MCP commands。
- [x] [task-03-compatibility-cutover](./tasks/phase-3-semantic-control/task-03-compatibility-cutover.md) — legacy API/MCP compatibility wrapper、lossy warning 与 runtime cutover。
- [x] [task-04-adapter-skill-cutover](./tasks/phase-3-semantic-control/task-04-adapter-skill-cutover.md) — Codex/Claude adapter 与 task-manager skill 切换。

## phase-4-project-dashboard

- [x] [task-01-v3-dashboard-read-model](./tasks/phase-4-project-dashboard/task-01-v3-dashboard-read-model.md) — 从 canonical v3 facts/semantics 生成 Project-first read model。
- [x] [task-02-project-tree-and-inboxes](./tasks/phase-4-project-dashboard/task-02-project-tree-and-inboxes.md) — Project/Main Task/Subtask tree、详情 Sheet 与双 Inbox。
- [x] [task-03-planned-actual-timeline](./tasks/phase-4-project-dashboard/task-03-planned-actual-timeline.md) — native segments/baseline、summary envelope 与 adaptive scale。
- [x] [task-04-realtime-accessibility-vdr](./tasks/phase-4-project-dashboard/task-04-realtime-accessibility-vdr.md) — realtime state preservation、accessibility 与 visual-driven-review。

## phase-5-rollout-documentation

- [x] [task-01-migration-cli-and-rehearsal](./tasks/phase-5-rollout-documentation/task-01-migration-cli-and-rehearsal.md) — 提供显式 migration dry-run/apply CLI，并仅在隔离副本上验证 backup/restore。
- [x] [task-02-install-update-package-smoke](./tasks/phase-5-rollout-documentation/task-02-install-update-package-smoke.md) — 验证 service、adapters、installer/update、release archive 与真实 runtime smoke。
- [x] [task-03-docs-and-release-checkpoint](./tasks/phase-5-rollout-documentation/task-03-docs-and-release-checkpoint.md) — 对齐 README/architecture/migration/deprecation 文档并建立真实 DB/发布授权 checkpoint。
