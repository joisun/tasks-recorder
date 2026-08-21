# phase-3-semantic-control 执行日志

> 只追加，不重写历史记录。

| 时间 | Task | 状态 | 证据 / 备注 |
| --- | --- | --- | --- |
| 2026-08-20 | task-01-work-context | in progress | 只读、同 Project、最多三候选、direct children；unresolved Project 不跨项目猜测。 |
| 2026-08-20 | task-01-work-context | done | 14/14 work context + API regression；纯读、current focus、3-candidate cap 与 deterministic order 通过。 |
| 2026-08-20 | task-02-semantic-commands | in progress | focus/correction/checkpoint/task mutation/structure sync，全部使用 entity revision。 |
| 2026-08-20 | task-02-semantic-commands | done | focused 15/15；full suite 254/254；MCP discovery、HTTP mapping、atomic/no-op/conflict contracts 通过。 |
| 2026-08-20 | task-03-compatibility-cutover | in progress | 先冻结 deprecated/lossy projection，再原子组合 v3 store/service/API/runtime。 |
| 2026-08-20 | task-03-compatibility-cutover | done | default runtime 切换到 JournalStore；legacy `task_id` 为 Segment Attribution projection；v2 DB gate 零写；full suite 259/259。 |
| 2026-08-20 | task-04-adapter-skill-cutover | in progress | Codex/Claude 独立 adapter 各自映射 Event Envelope；skill 改用 compact semantic commands。 |
| 2026-08-20 | task-04-adapter-skill-cutover | done | Stop/heartbeat mechanical-only；spawn intent 补齐；canonical/host adapters contract regression 与 package advertisement 通过。 |
| 2026-08-20 | phase exit | done | full suite 259/259；84 个 source syntax checks；Codex/Claude bundles 重建；Markdown contract 扫描与 `git diff --check` 通过。 |
| 2026-08-21 | commit reconciliation | done | Phase 3 implementation committed as `5e83ffb` after release authorization；covers semantic commands、v3 runtime cutover 与 Codex/Claude native adapters。 |
