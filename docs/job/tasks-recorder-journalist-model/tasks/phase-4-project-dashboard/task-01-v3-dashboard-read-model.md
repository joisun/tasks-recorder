# task-01-v3-dashboard-read-model

## 目标

直接从 schema v3 canonical snapshot 构建 Dashboard query projection，不再先投影成 legacy v2 Task/Session shape。

## Contract

- 行结构固定为 `Project → Main Task → Subtask`；Project 使用稳定的 projection id，不伪装成持久化 Task。
- Task actual 只来自 accepted Segment Attribution；Main Task 与 Project actual 是后代 Segment 的只读 envelope。
- 同时暴露 planned range、actual segments、derived live state、最近 execution context 与可复制 external session id。
- Project Inbox 与 Attribution Inbox 独立计数；旧 `unassigned_execution_count` 只作为过渡 alias。
- malformed/孤儿事实跳过并返回 warning，不把不确定事实猜测到 Project 或 Task。

## 验收

- Project root、三层 hierarchy、A→B→A split segments、parent envelope、planned/actual、live state、双 Inbox tests 全部通过。
