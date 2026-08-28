# 计划

> **Historical plan (superseded 2026-08-27)**：本文记录最初的 per-Schedule `launchd` / runner 方案，不能作为当前运维或架构说明。现行实现是 `taskd → Runtime Registry → CLI` 的 single-daemon direct path，参见 [`README.md`](../../../README.md) 与 [`runtime-agent-registry design`](../../superpowers/specs/2026-08-27-runtime-agent-registry-design.md)。

> 2026-08-25 更新：Phase 1 的 SQLite Job definition 已被 file-native registry supersede。最新增量计划见 [`2026-08-25-file-native-scheduled-tasks.md`](../../superpowers/plans/2026-08-25-file-native-scheduled-tasks.md)。

**目标**：交付 macOS-first Scheduled Tasks：Dashboard 可切换到 Scheduled 视图，用户可以创建、暂停、编辑、手动运行并 Review 由 launchd 触发的 standalone Codex threads。
**依据**：[00-discussion.md](./00-discussion.md) 的范围确认与已批准的 [`2026-08-24-scheduled-tasks-design.md`](../../superpowers/specs/2026-08-24-scheduled-tasks-design.md)。

## 全局约束（Global Constraints）

- Node.js `>=24.0.0`、ESM、`node:sqlite`；不增加 scheduler runtime dependency。
- v1 backend 只实现并验证 macOS `launchd`，其他平台返回 typed `unsupported` capability。
- `taskd` 是 `tasks.sqlite`、Markdown Schedule registry 与 `scheduler.sqlite` Run ledger 的唯一 service-side writer；runner 不打开 SQLite。
- Prompt 只经 0600 Unix socket 和 stdin 进入 `codex exec`，不进入 plist、argv 或 ordinary structured logs。
- public HTTP 继续只监听 `127.0.0.1` 并保持 Host/Origin guard；internal runner mutation 只经 0600 Unix socket。
- 每个 Schedule 的默认 sandbox 为 `read-only`；`workspace-write` / `danger-full-access` 需要显式选择。
- 不使用 `--dangerously-bypass-approvals-and-sandbox` 或 `--dangerously-bypass-hook-trust`。
- `Run now` 与 scheduled trigger 使用完全相同的 OS lock、claim、timeout、logs 与 completion path。
- missed occurrences 最多 catch up 一次；不自动 retry Agent work。
- Schedule/Run 不自动创建、完成或归档 semantic Task；只通过正常 Hook 进入 Recorder plane。
- active Run 固化 Job revision/spec；Edit/Pause/Delete 只改变 future desired state。
- 不自动 commit。只有用户再次明确授权时，才按 task-doc workflow commit 规则提交本任务文件。

## Phase 划分

### phase-1-scheduler-domain

- **目标**：建立可独立测试的 cadence、scheduler schema/store 与 domain service。
- **产出**：结构化 cadence 能生成一致 summary/next occurrence/launchd calendars；当前 Markdown registry 支持 etag CAS definition mutations，独立 `scheduler.sqlite` 支持 Run ledger、Review 与 health。
- **依赖**：无。

### phase-2-native-runner

- **目标**：实现 launchd desired-state reconciliation、0600 runner protocol/spool 与 Codex process supervisor。
- **产出**：每个 Schedule 能安装 owned plist；scheduled/manual trigger 都通过同一 runner，具备 no-overlap、heartbeat、process-group timeout、JSONL/logs 与 completion recovery。
- **依赖**：phase-1 完成。

### phase-3-service-integration

- **目标**：把 Scheduler 组合进 taskd、public API、Session Resume、CLI/installer/release。
- **产出**：Dashboard client 可以通过 typed routes 完成 Schedule/Run 全生命周期；安装/更新后 stable runner path 与 Codex executable 可用；Recorder failure 与 Scheduler degradation 分离。
- **依赖**：phase-1、phase-2 完成。

### phase-4-scheduled-dashboard

- **目标**：实现 nav view switch、Scheduled review inbox、Editor 与 Run Review。
- **产出**：Tasks/Scheduled 可访问切换；用户可创建、筛选、暂停、Run now、编辑、soft delete、Review output/log 并 Resume thread。
- **依赖**：phase-3 public API contract 稳定。

### phase-5-validation-rollout

- **目标**：完成跨层 regression、真实 launchd/Codex run、视觉验证、文档与 package audit。
- **产出**：真实 2–3 分钟 Scheduled Run 产生 thread + Hook record + Review + Resume；automated/full/visual/package/docs gates 全绿，限制与故障诊断可公开复现。
- **依赖**：phase-1 至 phase-4 完成。

## 风险与未决问题

- launchd `StartCalendarInterval` 不接受 per-job timezone；v1 明确跟随 system timezone，并测试 DST/系统时区变化后的 next-run/reconcile。
- One-time plist 没有 Year key；domain 将限制未来 366 天、runner 按 absolute `at` 再校验并在 accepted claim 后 disable，避免错误年度触发。
- LaunchAgent 的 PATH 不可靠；Node 与 Codex 必须使用安装时验证的 absolute path，path 失效进入诊断而不是 shell fallback。
- runner 与 taskd 的跨进程 completion 不是数据库事务；run nonce + idempotent completion + bounded spool 是恢复依据。
- OS lock、PID 与 DB lease 可能产生 drift；任何 stale cleanup 都要求多证据，不仅按时间删除。
- `danger-full-access` 的 UI 风险提示和创建确认必须在 visual/accessibility gate 中验证。
- 真实 sleep/wake gate 可能不适合自动测试；若无法在执行窗口内完成，test report 必须记录替代证据和未验证项，不能宣称已覆盖。

---

## 计划确认

> 进入 Tasks 阶段前，本计划与详细 implementation plan 必须由用户确认。

**确认人**：
**确认日期**：2026-08-25
**确认结果**：用户选择“批准实施”，允许按五阶段、13 tasks 开始 TDD；不包含 commit、发布或正式安装更新授权。
