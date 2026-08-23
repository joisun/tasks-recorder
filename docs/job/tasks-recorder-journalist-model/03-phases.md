---
job: tasks-recorder-journalist-model
status: done
current_phase: completed
current_task: null
blocked_reason: null
created: 2026-08-19
last_updated: 2026-08-23
---

# tasks-recorder-journalist-model 阶段总览 / 状态面板

> 这是本任务的唯一入口。任何新会话先读取本文件，再按索引追溯设计与执行证据。

## 现在在哪

phase 1–5、v0.6.0 schema-v3 rollout 与 v0.6.1 spool replay hotfix 全部完成。main CI、两次 GitHub Release、正式 checksums、真实 schema v2→v3 migration、verified backup、本机 service/adapters 更新和安装态 Playwright smoke 均已验证；真实 active spool 已从 1 清零，永久 conflict 以 `0600` `.invalid` 证据隔离。

## 下一步

产品实施已收口。后续属于运营数据治理：在 Project Inbox 核对 20 个 ambiguous Project，并仅在取得 inactive-session evidence 或用户显式决策后处理 82 条 stale execution；不能为消除 `degraded` 指标而自动伪造结束事实。

## 阶段列表

- [x] [phase-1-data-foundation](./phases/phase-1-log.md) — schema v3、migration、Project/Work stores 与独立 domain façade。
- [x] [phase-2-ingestion-reliability](./phases/phase-2-log.md) — Event ingest、spool、recovery 与 logs。
- [x] [phase-3-semantic-control](./phases/phase-3-log.md) — compact MCP commands、compatibility 与 adapters。
- [x] [phase-4-project-dashboard](./phases/phase-4-log.md) — 三层 Project UI、双 Inbox、planned/actual Timeline 与双端 VDR。
- [x] [phase-5-rollout-documentation](./phases/phase-5-log.md) — migration CLI/rehearsal、发布回归与文档。

## 文档索引

| 文件 | 用途 | 状态 |
| --- | --- | --- |
| [00-discussion.md](./00-discussion.md) | 讨论、方案选择与范围确认 | 已确认 |
| [目标架构 spec](../../superpowers/specs/2026-08-19-project-journalist-lifecycle-design.md) | authoritative 产品与技术设计 | 已确认 |
| [可编辑流程图](../../superpowers/specs/2026-08-19-project-journalist-lifecycle.drawio) | 领域、触发与 Timeline 图 | validator 已通过 |
| [01-plan.md](./01-plan.md) | 实施计划与全局约束 | 已确认 |
| [02-tasks.md](./02-tasks.md) | Task 级执行清单 | 全部完成 |
| [phases/](./phases/) | Phase 追加式执行日志 | phase 1–5 与 v0.6.1 hotfix rollout 完成 |
| [tasks/](./tasks/) | 不可变 Task 详情 | phase 1–4 已物化 |
| [04-test-plan.md](./04-test-plan.md) | 测试策略 | 已完成 |
| [05-test-cases.md](./05-test-cases.md) | 测试用例矩阵 | 17/17 通过 |
| [06-test-report.md](./06-test-report.md) | 测试结果 | v0.6.1 CI/Release/checksums/本机 smoke 全部通过 |

## 变更记录

- 2026-08-19 创建任务记录，完成方案选择，进入 written spec 复核门槛。
- 2026-08-19 完成 spec 自审与 draw.io 结构校验，等待用户复核。
- 2026-08-19 written spec 获批，完成五阶段实施计划，进入 plan checkpoint。
- 2026-08-19 创建隔离 worktree；baseline 183/183 tests 通过；开始 phase 1 task 01。
- 2026-08-19 phase 1 完成；full suite 208/208、`npm run check`、draw.io validator 与 `git diff --check` 全部通过。
- 2026-08-20 进入 phase 2 task 01；保持 v2 runtime 不变，先建立独立 v3 event ingest contract。
- 2026-08-20 phase 2 task 01 完成；10/10 focused tests、full suite 218/218、`npm run check` 与 `git diff --check` 通过。
- 2026-08-20 phase 2 task 02 完成；root/Codex/Claude 自包含 parity、9/9 spool tests 与 15/15 config/package focused regression 通过。
- 2026-08-20 phase 2 task 03 完成；session/subagent 收口、late heartbeat、fail-open delivery、explicit-evidence recovery 与 startup replay 10/10 focused 通过。
- 2026-08-20 phase 2 完成；stale replay claim recovery 补齐后 full suite 243/243、syntax checks 与 `git diff --check` 通过。
- 2026-08-20 进入 phase 3 task 01；从只读 compact context contract 开始，不提前切换 adapters。
- 2026-08-20 phase 3 task 01 完成；unresolved Project、同 Project isolation、candidate cap/order 与 guarded API 14/14 focused 通过。
- 2026-08-20 phase 3 task 02 完成；semantic commands、MCP discovery 与 HTTP mapping focused 15/15，full suite 254/254、`npm run check` 与 `git diff --check` 通过。
- 2026-08-20 phase 3 task 03 完成；v3 compatibility/runtime/package focused 与 full suite 259/259、`npm run check`、`git diff --check` 通过。
- 2026-08-20 phase 3 完成；native adapters、canonical hooks、spawn intent 与 semantic skill cutover 后 full suite 259/259、84-file syntax check、adapter builds 与文档扫描通过。
- 2026-08-20 进入 phase 4 task 01；确认 legacy v2 Dashboard projection 是信息丢失根因，并验证 SVAR 原生 split segments/baseline 能力。
- 2026-08-20 phase 4 tasks 01–03 完成；Project-first snapshot、Project/Task 双 Inbox、native split Segment、planned baseline、summary envelope 与 adaptive scale 已实现。
- 2026-08-20 phase 4 automated gate 272/272、85-file syntax check、UI/adapter builds 与 diff check 通过；Playwright MCP tools 未暴露，浏览器 gate 记录为 `VISUAL_SKIP`，task 04 保持进行中。
- 2026-08-20 Playwright tool exposure 通过 default/full-context reviewer 恢复；双 reviewer isolation gate 与 PC/Mobile 初审完成，发现 4 Major / 6 Minor。
- 2026-08-21 phase 4 修复与 focused visual regression 完成；12/12 checks PASS、10/10 findings resolved、fresh runtime clean，full suite 275/275 通过，进入 phase 5。
- 2026-08-21 phase 5 物化为 migration CLI/rehearsal、install/update/package smoke、docs/release checkpoint 三个 Task；真实 DB 和远端发布保持显式授权边界。
- 2026-08-21 phase 5 task 02 完成；12/12 focused package tests、280/280 full suite、85-file syntax check、UI/adapter/release builds、archive hash/readability 与 `git diff --check` 全部通过，进入 task 03。
- 2026-08-21 phase 5 task 03 完成 public contract 对齐；README 补齐 structured logs/spool、diagnostics 与 `0.6.x` compatibility window，v3 authoritative spec 和 v2 historical design 状态已校正，进入测试计划/用例/报告。
- 2026-08-21 测试计划、17 条用例与报告完成；P0 全绿、文档 links 0 missing、artifact/privacy/worktree 审计通过，进入真实 DB/Git/Release/本机更新授权 checkpoint。
- 2026-08-21 经用户授权完成真实数据库 read-only dry-run；schema 2→3 inventory 为 303 Tasks / 366 Executions / 295 bound / 71 unassigned，计划 26 Projects，其中 20 个因 6 组 `PROJECT_LOCATION_COLLISION` 保持 ambiguous；重复预检结果一致，service 仍 ready，数据库未写入。
- 2026-08-21 release audit 发现 remote `v0.5.0` 已发布，schema v3 release contract 由重复的 `0.5.0` 修正为 `0.6.0`；legacy compatibility window 同步为 `0.6.x`，最早 `0.7.0` 移除。
- 2026-08-21 v0.6.0 release-candidate gate 完成；installer/metadata/package focused 11/11、full suite 280/280、85-file syntax check、build/adapters/release archive 与 `git diff --check` 全绿，等待外部变更授权。
- 2026-08-21 用户授权完整发布升级；进入 fresh gate → commit/merge/push/release → verified backup/migration → 本机 service/adapters 更新与验证流程。
- 2026-08-21 main CI run `32473578515` 暴露 timezone-dependent Timeline test；根因是 UTC instant 与 local-calendar 断言混用，已改为 timezone-neutral fixture，等待 fresh UTC full gate 与 CI rerun。
- 2026-08-22 main CI run `32540691611` 与 Release run `32542405074` 全绿，`v0.6.0` 正式发布；真实数据库以 verified schema-v2 backup 完成 v2→v3 migration，本机 service、Codex adapter 与 Claude adapter 已更新到 0.6.0。
- 2026-08-23 安装态诊断确认数据库 schema/integrity/FK/invariants 健康；唯一 active spool 失败为永久 `OBSERVATION_IDENTITY_CONFLICT`，暴露 replay 对永久/临时错误未分类。hotfix 以 failing tests 复现后实现永久 rejection 隔离与后续 replay，准备 v0.6.1。
- 2026-08-23 v0.6.1 main CI `32615479571` 与 Release workflow `32615524175` 全绿，正式 assets checksums 全部通过；本机 runtime、Codex adapter 与 Claude adapter 已更新至 0.6.1。service 重启后 active spool 0、last replay error null、isolated 1，Playwright Dashboard smoke console 0 error/0 warning，任务收口。
