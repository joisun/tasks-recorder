---
job: tasks-recorder-scheduled-tasks
status: in_progress
current_phase: phase-5-validation-rollout
current_task: task-13-real-visual-docs
blocked_reason: null
created: 2026-08-24
last_updated: 2026-08-26
---

# tasks-recorder-scheduled-tasks 阶段总览 / 状态面板

> **Historical / superseded (2026-08-27)**：这是早期 Scheduler 交付状态，不是当前项目状态。当前架构见 [`README.md`](../../../README.md) 与 [`Runtime Agent Registry 设计`](../../superpowers/specs/2026-08-27-runtime-agent-registry-design.md)。

> 这是本任务的唯一入口。新会话先读本文件，再按文档索引追溯设计和执行证据。

## 现在在哪

首次 Scheduled Tasks 的 Phase 1–4 与 cross-process E2E 已完成。2026-08-25 的 file-native redesign 也已实现：Markdown 是 current definition source of truth，`scheduler.sqlite` v3 只保留 Run ledger、durable dispatch attempts、execution evidence 与可重建 sync state；codec/repository/monitor、migration、etag API、Settings、invalid-file UI、startup stale-unit cleanup 与 packaged YAML runtime 均已有 automated evidence。VDR、docs、full suite 与 package audit 已完成；当前只剩真实 macOS launchd/Codex 与 sleep/wake gate。

## 下一步

在单独授权的受控环境执行真实 read-only macOS launchd/Codex Run 与 sleep/wake 验证。未取得直接 evidence 前继续标记为未验证，不阻塞代码实现收口，但阻止宣称最终 release readiness。

## 阶段列表

- [x] [phase-1-scheduler-domain](./phases/phase-1-log.md) — cadence、scheduler schema/store 与 domain service。
- [x] `phase-2-native-runner` — launchd reconciliation、runner protocol/spool 与 Codex supervisor。
- [x] `phase-3-service-integration` — taskd/API/Resume/CLI/installer/release integration。
- [x] `phase-4-scheduled-dashboard` — nav switch、Scheduled inbox、Editor 与 Run Review。
- [~] `phase-5-validation-rollout` — integration、file-native migration、视觉、文档与 package audit。

## 文档索引

| 文件 | 用途 | 状态 |
| --- | --- | --- |
| [00-discussion.md](./00-discussion.md) | 调研、方案选择与范围确认 | in-chat 方向已确认 |
| [authoritative spec](../../superpowers/specs/2026-08-25-file-native-scheduled-tasks-design.md) | current definition architecture、安全、UI 与 migration contract | 已实施 |
| [execution observability spec](../../superpowers/specs/2026-08-26-scheduled-execution-observability-design.md) | durable dispatch、Run evidence 与 execution ledger UI | 已实施并完成 automated/VDR |
| [01-plan.md](./01-plan.md) | 分阶段实施计划 | 已批准 |
| [detailed implementation plan](../../superpowers/plans/2026-08-25-file-native-scheduled-tasks.md) | 文件、接口、TDD 与验证步骤 | automated/VDR 完成；real OS gate 待执行 |
| [02-tasks.md](./02-tasks.md) | Task 级合同索引 | task-13 进行中 |
| [phases/](./phases/) | 追加式执行日志 | phase 5 active |
| [tasks/](./tasks/) | 不可变 Task 详情 | 13/13 已物化 |
| [04-test-plan.md](./04-test-plan.md) | 测试计划 | 已同步 file-native contract |
| [05-test-cases.md](./05-test-cases.md) | 测试用例矩阵 | real OS gate 待收口 |
| [06-test-report.md](./06-test-report.md) | 测试报告 | automated/VDR 完成；不是 final release report |

## 变更记录

- 2026-08-24 完成附件、OpenAI 官方文档、本机 Codex/launchd contract、`opencode-scheduler@1.3.0` 源码与现有项目架构取证。
- 2026-08-24 完成独立架构审阅，补齐 Unix socket、absolute runtime path、lock/lease、process-group timeout、sandbox 与 Review queue 边界。
- 2026-08-24 用户批准 in-chat 设计方向；创建独立 worktree，baseline 317/317 tests 通过。
- 2026-08-24 写入 authoritative spec 与 workflow discussion/status，等待 written-spec review。
- 2026-08-24 用户批准 written spec；进入 implementation planning，建立五个 phase。
- 2026-08-25 用户批准 implementation plan；物化 13 份 task contracts，进入 phase 1 task 01。
- 2026-08-25 task 01 经两轮 focused 修复后通过独立 review；覆盖 strict local date、system timezone、DST gap/overlap 与 monthly gap，进入 task 02。
- 2026-08-25 task 02 经两轮 focused 修复后通过独立 review；scheduler.sqlite v1、Job/Run ledger、manual dispatch intents 与 monotonic completion evidence 已闭环，进入 task 03。
- 2026-08-25 task 03 经两轮 focused 修复后通过独立 review；durable Run now idempotency、generation-safe reconcile 与 bounded internal envelopes 已闭环，Phase 1 36/36，进入 Phase 2。
- 2026-08-25 task 04 经三轮 focused 修复后通过独立 review；真实 Task3→Task4 contract、once removal、generation serialization、canonical plist ownership、symlink 与 bounded command diagnostics 已闭环，进入 task 05。
- 2026-08-25 task 05 通过独立 review；private socket、bounded spool、single-delivery claim、identity-aware filesystem mutation 与 trusted replay boundary 已闭环，进入 task 06。
- 2026-08-25 task 06 通过独立 review；真实 runner entry、markRunning、bounded logs/JSONL、process-group timeout、append-only lock/evidence 与 fail-closed delivery 已闭环，Phase 2 结束，进入 Phase 3。
- 2026-08-25 完成首次 Scheduler API/UI/package 与 6 组 cross-process E2E；随后按用户要求将 current definitions 从 SQLite 迁移为自定义目录中的 marked Markdown。
- 2026-08-25 完成 file-native codec/repository/monitor、SQLite v2 migration、etag CAS、Settings root、invalid-file UI、old owned-unit cleanup 与 self-contained YAML vendor；进入最终 VDR/docs/package audit。
- 2026-08-25 完成 VDR、full suite 505/505、build/check、adapter/release package 与文档树同步；真实 OS/Codex/sleep-wake 仍待直接验证。
- 2026-08-26 重构 execution observability：`Run now` 显示 durable dispatch/Run 真实状态，重复点击 retry 同一 pending intent；Run ledger Sheet 以表格呈现 output files、Session copy 与 Terminal Resume，移除 `Runs` 按钮、绿色 rail、同步标签和假成功提示。full suite 526/526，desktop 1440×900 与 mobile 375×812 VDR 通过；真实 OS/Codex/sleep-wake gate 不变。
- 2026-08-26 移除 Model/Reasoning 四处过期硬编码：taskd 以 bounded、cached、shell-free `codex debug models` 作为 visible catalog 唯一来源，Editor 按所选 Model 动态限制 reasoning；Markdown/Run snapshot 只持久化安全 identifier shape。真实本机 catalog API 返回 7 个 visible models，Playwright 验证 Sol 含 `ultra`、Luna 不含 `ultra`；full suite 539/539，syntax 120 files，真实 OS/sleep-wake gate 不变。
