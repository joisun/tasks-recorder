# task-03-planned-actual-timeline

## 目标

让 Timeline 表达项目周期而不是“Task 日期条”：Actual 使用真实 Segment，Planned 使用 baseline，父级使用后代事实 envelope。

## Contract

- leaf Task 使用 SVAR native split segments 表达 A→B→A 等不连续 actual；不得填满中间空档。
- 同时有 plan/actual 时使用 `base_start` / `base_end`；只有 plan 时使用 outline planned bar；只有 actual 时显示 solid actual。
- Main Task actual 包含 own + direct Subtask segments；Project actual 包含全部 descendant segments。
- 默认 `auto` scale 根据当前过滤结果的 planned/actual extent 选择 hour/day、day/week、week/month 或 month/quarter，并保留 8%–12% breathing room。
- 用户手动 zoom/pan、grid width、展开与 selection 在 SSE refresh 后保持。

## 验收

- split segment、planned baseline、summary envelope、四档 auto scale、manual zoom persistence 与 current marker tests 通过。
