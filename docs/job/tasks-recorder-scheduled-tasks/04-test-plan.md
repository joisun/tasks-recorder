# 测试计划

> **Historical / superseded (2026-08-27)**：这是早期 per-Schedule `launchd` / runner 测试计划。现行验证边界见 [`README.md`](../../../README.md) 与 [`Runtime Agent Registry 设计`](../../superpowers/specs/2026-08-27-runtime-agent-registry-design.md)。

> 目的：证明 Scheduled Tasks 不是只会保存 cron-like definition 的 UI，而是一条可恢复、可诊断、不会泄漏 Prompt 的本机 automation plane，并且不会破坏 Tasks Recorder 的 journalist plane。

## 测试范围

- structured cadence、system timezone、DST、missed occurrence 与 once semantics。
- Markdown codec/repository/monitor、etag CAS、invalid/duplicate fail-closed 与 v1→v2 migration。
- `scheduler.sqlite` Run/dispatch ledger、immutable definition snapshot、Review 与 health invariants；不得保留 current definition table。
- owned launchd plist reconciliation、generation ordering、trigger、uninstall ownership verification。
- 0600 Unix socket、two-phase lock、Codex stdin/JSONL、bounded logs、process-group timeout 与 no-overlap。
- completion evidence/spool/ack、taskd restart、stale recovery 与 diagnostics degradation。
- loopback Schedule/Run API、Host/Origin guard、SSE invalidation、typed errors 与 Resume validation。
- CLI `scheduler status|reconcile`、installer Codex path、update preservation、package runtime 与 owned uninstall。
- Tasks/Scheduled navigation、list/review inbox、Editor、Run Review、logs、Mark reviewed、Resume、responsive/accessibility。
- active Codex Live Session 的 app-server handshake、Run SSE、ordered message/activity、steer、Stop、terminal reconciliation 与 privacy boundary。
- fake cross-layer E2E、真实 macOS launchd/Codex run、Recorder Hook correlation、sleep/wake evidence。
- README、architecture/spec、test evidence、release artifacts、privacy 与 worktree hygiene。

## 回归点

### 直接影响

- **S01 Cadence correctness**：five cadence kinds 必须由同一 structured contract 生成 next occurrence、summary 与 launchd calendars；system timezone/DST 不得在 browser 重算。
- **S02 Definition/Ledger invariants**：Markdown 是 current definition source of truth；每个 Schedule 最多一个 claimed/running Run；active Run 固化 definition etag/spec；terminal evidence 单调且 Review 只允许 `null → timestamp`。
- **S03 Native ownership**：只创建/更新/删除 canonical owned Schedule plist；foreign/symlink/unsafe-mode artifact 必须 fail closed。
- **S04 Prompt/privacy boundary**：Prompt 不得进入 plist、argv、HTTP list、ordinary logs、completion spool 或 release artifact；只经 private socket 与 stdin。
- **S05 Process safety**：Run now 与 OS trigger 共用 lock/claim/supervisor；重叠只记录 `skipped_overlap`；timeout 必须结束完整 process group。
- **S06 Crash recovery**：runner/taskd 在 evidence、spool、DB completion、ack cleanup 任一边界崩溃后都必须最终收敛或给出 bounded degraded fact，不能重复 completion 或永久卡死。
- **S07 Control plane**：Schedule etag、Run idempotency、explicit Review、bounded log tail、Run-authoritative Resume、Run-specific SSE、public Turn revision 与 steer/stop typed errors 必须准确。

### 间接影响

- **S08 Recorder isolation/correlation**：Scheduler degradation 不拖垮 Recorder health；正常 Codex Hook 最终用 thread ID 关联 Source Session/Execution，但不自动创建或完成 semantic Task。
- **S09 Install/update/uninstall**：release install 不需要 npm；reinstall 保留 config/DB/log；uninstall 只移除 verified owned units 并保留 user data。
- **S10 Dashboard product state**：Scheduled list 展示 active/unread/last result，unread 优先；Editor/Review 多状态、Live Session mouse/keyboard steer、Stop terminal refresh、stale request、focus、responsive 与 settings/resume 必须可用。
- **S11 Operations/docs**：status/reconcile、files/logs、timezone、missed-run/no-retry、permissions、troubleshooting 与 Automation/Recorder separation 必须对用户可复现。

### 边界与非功能

- **S12 Security**：HTTP 仅 loopback，Host/Origin guard 不回归；路径、nonce、raw spec/stderr、runtime `turnId`、guidance 与 tool payload 不出 public response/persistence。
- **S13 Capacity**：socket/request/log/spool/catch-up 有明确 cap；poison/replacement/hardlink/inode drift 不得突破 ownership proof。
- **S14 Visual/accessibility**：1440×900、窄屏、keyboard、focus trap、reduced motion、overflow 和 console 均有证据。
- **S15 Artifact hygiene**：测试只使用临时 HOME/DB/port；不把 Prompt、SQLite、WAL、locks、logs、transcript 或 credential 纳入 Git/release。

## 不在本次范围

- Windows/Linux scheduler backend、cloud scheduler、remote execution、multi-user auth。
- automatic retry Agent work、dependency graph、Dashboard-native completed-Run multi-turn thread。
- 自动把 Schedule/Run 映射成 Project/Main Task/Subtask。
- 未经单独授权的 commit、merge、push、GitHub Release、正式安装更新或用户数据删除。

## 测试环境

- macOS、Node.js 24+、worktree `.worktree/feature-scheduled-tasks`。
- 自动化使用 Node test runner、临时 SQLite/HOME/socket/port、fake launchctl 与 fake Codex。
- UI 使用 `playwright-headless`；source preview 与正式 `43127` 数据隔离。
- 真实 OS gate 使用 read-only harmless Prompt，禁止 `danger-full-access`。

## Release gate

- 所有 P0 用例通过；restart/replay/timeout/no-overlap 不允许以“单元测试通过”替代失败的跨进程 E2E。
- `npm test`、`npm run check`、`npm run build`、`npm run build:adapters`、isolated release package 与 `git diff --check` 全部 exit 0。
- VDR、真实 launchd/Codex Run、README/docs scan 与 package audit 有可定位 evidence。
- gate 只表示可以进入 commit/release/install 授权阶段，不代表这些外部动作已发生。
