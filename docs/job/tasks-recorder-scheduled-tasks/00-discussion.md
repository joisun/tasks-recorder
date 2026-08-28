# 讨论与分析

> **Historical / superseded (2026-08-27)**：本目录是早期 Scheduler 建设记录，其中的 per-Schedule `launchd` / runner 链路已退役。现行架构以 [`README.md`](../../../README.md) 和 [`Runtime Agent Registry 设计`](../../superpowers/specs/2026-08-27-runtime-agent-registry-design.md) 为准。

> 2026-08-25 更新：本文件记录首次 Scheduler 方案的决策过程。当前 canonical Schedule definition 已从 `scheduler.sqlite` 迁移为 Markdown；现行设计见 [`2026-08-25-file-native-scheduled-tasks-design.md`](../../superpowers/specs/2026-08-25-file-native-scheduled-tasks-design.md)。

## 背景 / 动机

Tasks Recorder 已能记录 Agent 发生了什么、正在做什么，但不能主动在指定时间唤醒 Codex。用户需要一个类似 Codex Desktop Scheduled Tasks 的本机入口：在 Dashboard nav 最左侧切换到 Scheduled 视图，配置重复工作，查看运行结果并继续对应会话。

如果只增加静态页面或 taskd timer，产品仍无法在睡眠、重启、并发触发和执行失败时提供可信的周期掌控感。

## 现状

- Dashboard 是单页 C/S client，Tasks 视图使用 SVAR Gantt；nav 由 `ui/src/dashboard.mjs` 渲染。
- `taskd` 由 macOS launchd KeepAlive，监听 loopback HTTP，是 journal SQLite 唯一 writer。
- release 通过 `~/.local/share/tasks-recorder/current` stable symlink 切换版本。
- Session Resume 已能基于 canonical facts 和本机 transcript 验证，通过 allowlisted terminal 执行 `codex resume`。
- `codex exec --json` 是本机可用的 non-interactive runner，并提供 `thread.started.thread_id`。
- 记者模型明确区分 Fact plane 与 Semantic plane，Schedule 不应伪装成 Task。

## 待澄清的问题

- [x] 是否照搬 `opencode-scheduler`？ → 结论：只借鉴 OS-native wake-up、supervisor、lock、timeout 与日志分离；不复制 JSON source-of-truth、monolith、manual-run bypass 和 best-effort rollback。
- [x] Scheduler 是否进入 Task tree？ → 结论：不进入。作为并列 Automation plane，Run 产生的 Codex Session 再由 Recorder plane 正常记录。
- [x] v1 是否跨平台？ → 结论：不。当前 installer/runtime 本身是 macOS-only，v1 只实现并真实验证 launchd。
- [x] 每次 Run 是新 Thread 还是 resume？ → 结论：v1 每次创建 standalone new Thread；thread-attached heartbeat/resume 后续独立设计。
- [x] 是否自动 Git worktree？ → 结论：v1 不做；只允许显式 Workspace，并由 sandbox 限制权限。
- [x] 谁保存 canonical state？ → 初版由 taskd 写 `scheduler.sqlite`；2026-08-25 起，taskd 管理 Markdown definitions，SQLite 只保存 Run ledger，runner 仍不打开 SQLite。
- [x] 是否允许任意 shell command？ → 结论：不允许，只构造 allowlisted `codex exec` args，Prompt 走 stdin。
- [x] 方案是否获准进入 written spec？ → 结论：用户于 2026-08-24 选择“批准实施”，并确认架构是否参考 `opencode-scheduler`；已说明“参考核心架构，但不照搬缺陷”。

## 方案探讨

### 方案 A：复用 Codex Desktop 内部 Automation

依赖私有 API/storage，版本和 capability registration 不稳定，Tasks Recorder 无法独立安装与发布。不采用。

### 方案 B：taskd 内部 timer

实现成本低，但 durable scheduling、sleep/restart、独立 process supervision 与 drift recovery 较弱。不采用。

### 方案 C：launchd + taskd control plane + scheduled-runner

launchd 负责 durable wake-up；taskd 保存 desired state 与 run facts；runner 负责 lock、Codex process、timeout、logs、completion。采用。

详细设计见 [`2026-08-24-scheduled-tasks-design.md`](../../superpowers/specs/2026-08-24-scheduled-tasks-design.md)。

## 明确排除的范围（Out of Scope）

- 同一 Codex thread 的周期性 heartbeat/resume。
- event/webhook/cloud triggers。
- systemd、Windows Task Scheduler、cron backend。
- 自动 Git worktree lifecycle。
- arbitrary shell command、environment/secret snapshot。
- 自动 retry Agent work。
- 系统原生通知。

---

## 范围确认

> 进入 Plan 阶段前，written spec 仍需用户复核；本区块记录 in-chat 设计批准，不替代 written-spec review。

**确认人**：用户
**确认日期**：2026-08-24
**确认内容摘要**：批准 macOS launchd + taskd Automation control plane + standalone Codex threads 的 v1 方向；要求借鉴 `opencode-scheduler` 架构，但不强行复用其缺陷。
