# 测试报告

> **Historical / superseded (2026-08-27)**：这是早期 Scheduler 测试报告，不是当前 release readiness 结论。现行架构见 [`README.md`](../../../README.md) 与 [`Runtime Agent Registry 设计`](../../superpowers/specs/2026-08-27-runtime-agent-registry-design.md)。

**日期**：2026-08-27
**状态**：实现、自动化与 VDR 已完成；真实 OS gate 尚未执行，不是最终 release report。

## 当前结论

Phase 1 domain、Phase 2 native runner、Phase 3 API/CLI/install/package 与 Phase 4 Dashboard 已有 fresh green evidence。file-native redesign 已完成：Markdown 是 current Schedule definition 的唯一 source of truth，SQLite v3 仅保留 Run ledger、durable dispatch attempts、immutable execution evidence 与可重建 sync state。

Task12 曾发现的 completion receipt P0 failure 已修复并以原样跨进程 restart E2E 复验：Run 只完成一次，receipt/evidence/spool 均收敛，privacy-preserving replay 不持久化 raw final message。runner `SIGKILL` 后的 dead-lock recovery 已直接收口为 `lost`；fixture 也以真实 Host Hook envelope 证明 Scheduled Run thread 与 Recorder Source Session/Execution 使用同一 external session identity。完整 VDR、full suite、build、adapter build 与 isolated package audit 已通过；真实 macOS launchd/Codex 和 sleep/wake 仍无直接 evidence，因此仍不宣称最终 release readiness。

2026-08-26 execution observability 增量修复了 `Run now` 的假成功问题：backend trigger 未接受时，pending dispatch 会持久化 attempt/error 并显示为启动失败；再次点击 retry 同一 intent。runner claim/running/complete 通过 SSE 发布 revision，Schedule list 与 Run ledger 均直接读取 SQLite execution state。Codex completed `file_change` 以 bounded、Workspace-relative evidence 写入 Run，页面可查看产出文件、复制 Session，并仅用 authoritative Run ID 请求 Terminal Resume。正常流程不再依赖 toast、alert、`ACTIVE/已同步` 标签或绿色 card rail。

同日 Model selector 改为读取本机 Codex CLI 的真实 catalog。taskd 以 canonical executable 执行 `codex debug models`，使用 shell-free argv、5 秒 timeout、2 MiB output cap 与 5 分钟成功缓存，只公开 visible bounded metadata。Editor 的 Reasoning 选项随所选 Model 收窄；Markdown 与 immutable Run snapshot 不再复制易过期枚举，显式选择才在 mutation/resume preflight 验证当前 compatibility。隔离 `43133` API 直接返回 7 个 visible models；Playwright 证明 Sol 提供 `low…ultra`，Luna 只到 `max`，hidden entries 与旧 hardcode 均未出现。

2026-08-27 Live Session 增量把 active Codex Run 接到 native `codex app-server`：Run-specific SSE 按序呈现 assistant delta 与 privacy-bounded activity，typed API 使用 public Turn revision 提交 steer/Stop，runtime `turnId` 始终留在 taskd。首轮 PC VDR 发现 Send 未随 input enable、Stop 后 row/detail 与 terminal facts 不一致两个 High defect；修复后 rerun-2 证明 mouse steer 202、Stop 202、terminal authoritative GET 200，Session/final message/logs/Resume 一致。focused screenshots 与报告位于 ignored `.vdr-log/2026-08-27-live-session-dashboard-rerun-2/`。

同日真实 `codex update report` Run 暴露了 app-server evidence gap：nested `apply_patch` 已写入 Workspace，但没有对应 `fileChange` item，导致 ledger 产出为空。修复后 `RunService` 将 runtime evidence 与 bounded Workspace 前后 snapshot 合并；第二次真实 Run 使用 `gpt-5.6-sol` / `low` 成功完成，SQLite/API/Run Review 均记录 `codex-daily-update-report.md (update)`，Session 可复制和 Terminal Resume。`npm test` 501/501 通过，1440×900 fresh Playwright context 为 0 error / 0 warning；证据位于 ignored `.vdr-log/2026-08-27-real-cron-run-now/`。

## 已验证证据

| 范围 | 结果 |
| --- | --- |
| Task 8 CLI/install/package focused | 24/24 passed |
| Scheduler phase backend gate | 145/145 passed |
| Scheduled execution observability focused gate | 23/23 passed；覆盖 durable dispatch failure/retry、output files、Session copy、authoritative Run-ID Resume 与无假成功提示 |
| Task 12 cross-process E2E | 6/6 passed；约 70 秒，含 Hook correlation、runner crash→lost、restart replay 与 process-tree timeout |
| Runtime/spool recovery focused | 24/24 passed；额外 rereview baseline 64/64 passed |
| Run ledger desktop 1440×900 | 960px Sheet；State/Started/Duration/Trigger/Outputs/Session/Action 表格、展开 result/file changes/log 均可用 |
| Run ledger mobile 375×812 | labeled grid；document/table/row 均严格 375px；horizontal overflow 0；交互控件 ≥44px |
| File-native focused regression | 41/41 passed；含 relocation transaction、exclusive mutation、watcher handoff buffer、Settings atomic persistence 与 UI copy |
| Definitions root hot relocation | isolated `43133`：同一 ID/etag 迁移、旧 root recoverable archive、新 watcher 外部编辑收敛、迁移后 Create 仅写新 root；Settings desktop/mobile 无 overflow；fresh browser console 0 error / 0 warning |
| Full automated suite | 539/539 passed；0 failed；75.0 秒 |
| Build / syntax | `npm run build` passed；`npm run check` 检查 120 个 source files；`git diff --check` passed |
| Codex Model catalog | 本机 `codex debug models` → isolated taskd API 7 visible models；Sol reasoning 含 `ultra`，Luna 不含；390×844 Editor 无 horizontal overflow，Model/Reasoning control 326px；Playwright browser console fresh 0 error / 0 warning |
| Adapter / release package | `npm run build:adapters` 与 isolated `npm run package:release` passed；3 个 archive 无 DB/log/spool/lock/credential-like path |
| VDR desktop/mobile | 1440×900 与 390×844；3 个 Medium finding 已修复：mobile touch target、Settings hidden-tab trap、invalid-field label clipping |
| VDR focused regression | mobile inspected controls 均 ≥44px；Terminal→field→Save→Close Tab 顺序正确；validation 后 Title label 可见 |
| Live Session focused + E2E | app-server JSON-RPC、256 KiB frame cap、10s request timeout、Run timeout、Abort、SIGINT→SIGKILL、ordered event、steer/Stop、terminal refresh 全绿；PC 1440×900 rerun-2 无 remaining finding |
| Real Codex Run now | `codex update report` 两次真实执行成功；第二次 1m 12s，Session `01a04281…8ac949`，产出 `codex-daily-update-report.md (update)`；Workspace fallback test、API、SQLite、Run Review 与 fresh PC VDR 全绿 |
| Latest full automated suite | 499/499 passed；`npm run check` 检查 129 个 source files；0 failed |

最终 full suite 的首次 fresh run 暴露了一处 test-harness race：offline replay case 在 lock bind 后、`markRunning` 前关闭 taskd，偶发令 runner 正确返回 failed。production 顺序未改；fixture 改为显式 Codex gate，并在确认 trace 与 `running` ledger state 后再关闭 taskd。该 case 连续 5/5 通过；Definitions root hot relocation 加入后，最终 full suite 516/516 通过。

## 失败 / 阻塞

- **TC-15/TC-16 未执行**：真实 launchd/Codex 与 sleep/wake evidence 尚未开始。
- VDR 的 browser full-page screenshot 在 isolated composition 中出现黑图，报告保留该 evidence gap；DOM snapshot、viewport screenshot、focus/尺寸测量与 console evidence 可用。

## 授权边界

本报告中的 preview、fake Codex、SQLite、logs 与 spool 均位于 isolated temp state。未执行 commit、merge、push、GitHub Release、正式安装更新、真实用户数据库 mutation 或数据删除。

## 下一步

1. 在单独授权与受控环境下执行真实 read-only macOS launchd/Codex Run，并记录 sleep/wake evidence。
2. 只有剩余 P0 gate 全绿后，更新本报告为 final，再分别进入 commit/release/local-update 授权 checkpoint。
