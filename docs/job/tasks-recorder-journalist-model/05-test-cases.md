# 测试用例矩阵

> 每条用例追溯到 [`04-test-plan.md`](./04-test-plan.md) 的回归点和 [`02-tasks.md`](./02-tasks.md) 的实施 Task。状态在最终 fresh gate 后统一更新。

| 用例编号 | 关联回归点 | 关联 task | 前置条件 | 操作步骤 | 预期结果 | 优先级 | 状态 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| TC-01 | R01 Migration safety | phase 1 task 02；phase 5 task 01 | 临时 schema v2 DB | 运行 schema/CLI migration tests，执行 dry-run→apply→restore rehearsal | dry-run 零写；backup 0600、checksum/integrity 有效；计数守恒；失败 rollback | P0 | 通过 |
| TC-02 | R02 Domain invariants | phase 1 tasks 01/03/04/05 | 临时 schema v3 DB | 运行 schema、Project、Task、Work stores tests | Project/location 唯一；一层 Task tree；单 open Segment/accepted Attribution；invariants 全绿 | P0 | 通过 |
| TC-03 | R03 Lifecycle separation | phase 2 task 03 | 临时 execution/Task | 执行 start/heartbeat/stop/session-end/recovery tests | execution 事实正确收口；Task lifecycle 不被自动完成；无证据只投影 stale | P0 | 通过 |
| TC-04 | R04 Semantic attribution | phase 1 task 04；phase 3 task 02 | 一个 execution、Task A/B | 运行 A→B→A、correction、checkpoint tests | 三个 Segment 保留；accepted Attribution 唯一；用户 correction 不被 heartbeat 覆盖 | P0 | 通过 |
| TC-05 | R05 Project resolution / Inbox | phase 1 task 03；phase 4 task 02 | 同 branch 不同 repo、ambiguous remote fixtures | 运行 Project resolution、Project Inbox、work context tests | branch 不参与确定性归属；歧义分流到 Project/Task Inbox；不跨 Project 泄漏 candidate | P0 | 通过 |
| TC-06 | R06 Semantic control surface | phase 3 tasks 01/02 | v3 service + MCP | 运行 semantic tools、API、client 与 structure sync tests | compact context ≤3 candidates；focus/checkpoint/mutation revision guarded；structure sync 原子 | P0 | 通过 |
| TC-07 | R07 Dashboard hierarchy/time | phase 4 tasks 01/03 | Project/Main/Subtask 与 split segments fixture | 运行 dashboard-data、SVAR state/contract tests | 三级 hierarchy 正确；parent actual/planned scope 包络全部 descendants；auto scale 合理 | P0 | 通过 |
| TC-08 | R08 Legacy compatibility | phase 3 task 03 | v3 runtime + legacy calls | 运行 `v3-compatibility` tests | legacy calls 可用；返回 deprecated/replacement/lossy；v2 DB 被零写拒绝 | P0 | 通过 |
| TC-09 | R09 Native adapters | phase 3 task 04；phase 5 task 02 | built Codex/Claude archives | 运行 adapter build/package tests 与 packaged MCP handshake | bundles 独立、自包含，host-native hooks 一致 fail-open，不依赖 source node_modules | P0 | 通过 |
| TC-10 | R10 Realtime UI state | phase 4 task 04 | Dashboard controller/SSE fixtures | 运行 renderer/controller/UI state/event stream tests | refresh 恢复 open/filter/selection/zoom/splitter/labels/focus；失败后可恢复 | P1 | 通过 |
| TC-11 | R11 Install/update/package | phase 5 task 02 | 临时 HOME、release archives | 运行 install/package tests：reinstall、tamper、symlink、readiness、archive allowlist | 不运行 npm；config/database 保留；tamper fail closed；三份 artifacts 可解包 | P0 | 通过 |
| TC-12 | R12 Operations/diagnostics | phase 2 task 04 | temp spool/logger/runtime | 运行 diagnostics/logger/startup tests，检查 `/health/ready` 与 `/api/v1/status` contract | ready/degraded 可区分；spool/logger/recovery 为 bounded summary；日志 allowlist | P1 | 通过 |
| TC-13 | R13 Failure/replay boundaries | phase 2 tasks 01–03；phase 5 task 01 | unavailable taskd、capacity/corrupt fixtures | 运行 Event ingest/delivery/spool/recovery/CLI guard tests | Hook 始终 fail-open；4xx 不污染 spool；replay 幂等；active taskd 阻止 apply | P0 | 通过 |
| TC-14 | R14 Timeline/responsive/a11y | phase 4 tasks 03/04 | `playwright-headless` PC/Mobile evidence | 复核 12-check VDR aggregate 与 focused UI unit tests | 12/12 PASS；10/10 findings resolved；PC splitter、mobile modes、44px targets、keyboard 正常 | P1 | 通过 |
| TC-15 | R15 Release metadata/docs | phase 5 task 03 | 完整 docs/workflows/manifests | 运行 release metadata tests与 Markdown relative-link scanner；核对 0.6.0/GPL/repository/deprecation/migration commands | metadata 同源，Actions pinned，文档 links/commands/window 一致 | P0 | 通过 |
| TC-16 | R16 Privacy/local boundary | phases 1–3；phase 5 tasks 01/02 | source/tests/package | 运行 privacy/event/log/spool/loopback tests，并扫描 tracked diff 的敏感文件模式 | 无 prompt/reasoning/tool IO/credential 落盘 contract；只允许 127.0.0.1；未写真实用户状态 | P0 | 通过 |
| TC-17 | R17 Artifact/worktree hygiene | phase 5 tasks 02/03 | 目标 worktree | 执行 `git diff --check`、ignored artifact 检查、database/transcript/secret path scan | release/VDR ignored；无 DB/WAL/真实 transcript/credential/临时文件进入 diff | P0 | 通过 |

## 状态说明

- `未执行`：尚未纳入本轮最终 fresh gate。
- `通过`：命令和/或可定位 evidence 满足预期。
- `失败`：实际结果违反 contract，必须转为新 Task。
- `阻塞`：环境或授权缺失使测试无法执行；P0 阻塞会阻止 release readiness。
