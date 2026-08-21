# 测试计划

> 目的：验证 Project Journalist schema v3 从事实采集、语义归属、Dashboard 到安装发布的完整 contract，同时证明迁移与安装不会触碰未经授权的真实用户数据。

## 一致性前置检查

- [`01-plan.md`](./01-plan.md) 的五个 Phase 均已有实现与验证证据。
- [`02-tasks.md`](./02-tasks.md) 的 20 个 Task 均为 `[x]`；执行偏差记录在 append-only phase logs。
- 公开行为以 [`README.md`](../../../README.md) 与 [authoritative v3 spec](../../superpowers/specs/2026-08-19-project-journalist-lifecycle-design.md) 为准。
- 未执行的真实数据库迁移、commit/merge、tag/release 和本地更新不计入实现完成度，也不得在测试结论中写成已完成。

## 测试范围

- schema v3 DDL、v2 inventory/dry-run/backup/apply/rollback 与 runtime schema gate。
- Observation / Source Session / Execution / Work Segment / Attribution 事实层及 Project / Main Task / Subtask 语义层。
- Event Envelope、bounded spool、startup recovery、structured diagnostics 与 hook fail-open。
- compact semantic MCP/API、legacy compatibility wrapper、native Codex/Claude adapters。
- Project-first Dashboard、双 Inbox、planned/actual Timeline、SSE state restoration、responsive/accessibility。
- installer update preservation、release archive allowlist、packaged runtime、metadata、license 与 CI/release workflow。
- README/spec/job docs、Markdown links、ignored artifacts、credential/privacy boundary 与 worktree cleanliness。

## 回归点清单

### 直接影响

- **R01 Migration safety**：v2→v3 改变 canonical schema；必须证明 dry-run 零写、apply 前 verified backup、失败回滚、数据计数守恒。
- **R02 Domain invariants**：新增 Project 和双平面实体；必须拒绝跨 Project parent、多 open Segment、多 accepted Attribution。
- **R03 Lifecycle separation**：Hook end 与 Task status 解耦；execution 结束或 stale 不能自动完成 Task。
- **R04 Semantic attribution**：Execution 可 A→B→A；必须保留三个 Segment，用户修正不可被 heartbeat 覆盖。
- **R05 Project resolution / Inbox**：branch、remote 或相似标题不能单独决定 Project/Task，歧义必须进入正确 Inbox。
- **R06 Semantic control surface**：新 `agent_work_*` / Task mutation contract 必须 compact、revision guarded；structure sync 不能用于 heartbeat。
- **R07 Dashboard hierarchy and time**：Project→Main Task→Subtask、planned/actual 与 parent summary envelope 必须读取同一 canonical snapshot。

### 间接影响（依赖方 / 调用方）

- **R08 Legacy compatibility**：`0.6.x` legacy client 仍可调用，但必须返回 `deprecated` / replacement / lossy 信息，不能伪装为完整历史。
- **R09 Native adapters**：Codex/Claude 独立 bundles 必须具备一致 Event Envelope、MCP 与 fail-open contract，且不依赖 source tree。
- **R10 Realtime UI state**：SSE revision refresh 不得破坏展开、筛选、selection、zoom、splitter、label 或 focus。
- **R11 Install/update/package**：release install 不运行 npm；reinstall 不覆盖 config/database；tampered archive 必须在切换前失败。
- **R12 Operations/diagnostics**：health/status、spool/recovery/logger 能区分 ready/degraded，日志不得包含 payload 或 credential。

### 边界情况

- **R13 Failure and replay boundaries**：taskd unavailable、spool full/corrupt/stale claim、重复/identity-drift event、active taskd migration apply 都必须 fail safely。
- **R14 Timeline density/responsiveness**：从小时到季度的 auto scale、split segments、desktop splitter、mobile Task/Timeline 模式与 44px targets 都要保持可用。
- **R15 Release metadata/docs**：version/license/repository、pinned Actions、artifact contract、migration/rollback/deprecation 文案与 Markdown links 必须一致。

### 非功能性（性能 / 安全 / 兼容性）

- **R16 Privacy and local boundary**：只监听 loopback；Event/log/spool 使用 allowlist；不保存 prompt/reasoning/tool IO/token/credential；测试与构建不写真实 HOME/DB/LaunchAgent。
- **R17 Artifact/worktree hygiene**：release、VDR 和临时产物保持 ignored；不得把 database/WAL、真实 transcript、credential 或无关文件纳入 diff。

## 不测试的部分（及原因）

- 真实 `~/.config/tasks-recorder/tasks.sqlite` migration：destructive state transition，需要独立用户授权。
- main branch merge、commit、tag、push、GitHub Release 与本机 reinstall：属于外部可见动作，需要独立用户授权。
- 任意深度 Task tree、cloud sync、LAN/public access、多用户鉴权：明确不在 v3 scope。
- 真实 iOS/Android device finger friction 与 safe-area：当前仅有 Chromium mobile viewport；保留为非阻塞 device smoke unknown。
- 全量历史 Codex import apply：本次架构不改变“精确 session、先 dry-run、显式 apply”的授权边界。

## 测试环境 / 前置条件

- macOS，Node.js 24，repository worktree：`.worktree/feature-journalist-model-v3`。
- 自动化使用 Node test runner、临时 SQLite、临时 HOME/config/port；package smoke 从 archives 解压运行。
- UI evidence 使用 `playwright-headless`，PC `1440×900`、Mobile `375×812`；证据位于 ignored `.vdr-log/`。
- release artifacts 位于 ignored `release/`，SHA-256 用系统 `shasum -a 256` 计算。

## Release gate

- P0 用例全部通过。
- `npm test`、`npm run check`、UI/adapters/release builds、archive readability、`git diff --check` 全部 exit 0。
- README/spec/metadata/link/privacy/worktree 审计无阻断项。
- gate 只表示 release candidate 可进入授权阶段，不代表真实数据库、Git 或本机安装已经改变。
