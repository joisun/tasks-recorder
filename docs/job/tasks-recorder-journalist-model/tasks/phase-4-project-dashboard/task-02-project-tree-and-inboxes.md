# task-02-project-tree-and-inboxes

## 目标

把 Dashboard information architecture 切换为 Project-first control surface，并把 unresolved Project 与 unattributed work 分开处理。

## Contract

- Project row 展示项目级进度、running/idle/stale 信号、blocked 数量和最近上下文，但不提供 Task lifecycle mutation。
- Main Task/Subtask 继续支持显式 lifecycle 修改；详情 Sheet 中展示 Task semantics 与 attributed execution/segment facts。
- Project Inbox 与 Attribution Inbox 使用不同入口、计数与解释；不得用 branch 自动归属。
- workspace/worktree/branch/session id 保持 compact 展示、完整 tooltip/Sheet 与 session copy。

## 验收

- 层级展开折叠、状态 mutation guard、双 Inbox 空态/计数/键盘操作与详情内容 tests 通过。
