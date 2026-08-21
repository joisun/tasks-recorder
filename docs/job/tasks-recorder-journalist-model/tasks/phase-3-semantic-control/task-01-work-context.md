# task-01-work-context

## 目标

实现 `agent_work_context(execution_id)` 的 compact read model：告诉 Agent 当前执行属于哪个 Project、当前 Segment/focus 是什么，以及最多三个同 Project 的 Main Task candidates 与直接 Subtasks。

## Contract

- 查询是纯读，不创建 Task、Observation、Attribution 或 session binding。
- Source Session 未解析 Project 时返回 Project Inbox 状态和空 candidates；不得用 branch、remote suggestion 或跨 Project 活跃度猜测。
- candidates 只包含同 Project、未归档/未删除、非 done/canceled 的 Main Task；最多三个，每项只带 direct children。
- current accepted Attribution 优先；其余按 lifecycle priority、最近语义更新时间、稳定 id 排序。
- response 不返回完整 session 列表、历史 event 全量或 raw payload。

## 验收

- unresolved、current focus、跨 Project 隔离、candidate 上限与 deterministic order tests 全部通过。
