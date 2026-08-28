# Scheduled Execution Observability Design

> **Historical / partially superseded (2026-08-27)**：Run ledger 与 execution evidence 仍然有效，但本文中的 dispatch / runner execution path 已退役。当前架构见 [`README.md`](../../../README.md) 与 [`Runtime Agent Registry 设计`](./2026-08-27-runtime-agent-registry-design.md)。

## 目的

把 Scheduled Tasks 从“定义列表加若干操作按钮”重构为可观察的本地 automation control plane。用户点击 `Run now` 后，页面必须持续显示 durable dispatch、runner claim、运行中和终态；历史记录必须呈现产出文件、Session ID，并允许从可信 Run snapshot 直接在配置的 terminal 中 Resume。

## 已验证事实

- `POST /api/v1/schedules/:id/run` 会先写入 `scheduled_dispatches`，再调用 runner backend。
- backend 拒绝或不可用时，API 仍返回 HTTP 200 和 `dispatched: false`；当前 UI 忽略该字段并错误显示“已请求运行”。
- Schedule list 只聚合 `scheduled_runs`，不读取 pending dispatch，因此 durable intent 对用户不可见。
- 缺少 server-side pending 去重，重复点击会产生多条 pending dispatch。
- runner protocol 的 `claim`、`mark_running` 和 `complete` 不发布 Dashboard revision，SSE 无法实时刷新执行状态。
- `scheduled_runs` 已保存 `thread_id`、final result 和 stdout/stderr log path，但没有 file-change evidence。
- Codex `exec --json` 的 completed `file_change` item 提供 `{ path, kind }`，足以记录 bounded、Workspace-relative 的文件变更，不需要扫描 Workspace。

## 产品模型

一次 manual execution 分为两个连续事实：

1. **Dispatch**：用户已发出执行意图，状态为 queued、dispatch failed 或 dispatch stalled。launchd dispatch 发出后 60 秒仍没有 runner claim 时，read model 将其标记为 `dispatch_stalled / RUNNER_CLAIM_TIMEOUT`，停止 loading；pending intent 不被删除，允许用户 retry 同一 dispatch。
2. **Run**：runner 已 claim，状态为 claimed、running 或 terminal。

同一 Schedule 同时最多有一条 pending manual dispatch。再次点击 `Run now` retry 同一 dispatch；成功 claim 后 dispatch 被消费并由 Run 取代。页面不使用 toast 或 alert 表达正常执行流程，所有状态都来自 SQLite read model。

## 数据模型

### `scheduled_dispatches`

新增：

- `attempt_count INTEGER NOT NULL DEFAULT 0`
- `last_attempted_at TEXT`
- `last_error_code TEXT`

每次 backend trigger 都原子记录 attempt。accepted 时清空 error；失败时保留 typed error code。pending dispatch 在 list API 中被序列化为 execution intent。

### `scheduled_runs`

新增 `file_changes_json TEXT`。内容是最多 128 条、每条 path 最多 2048 bytes 的：

```json
[{ "path": "reports/daily.md", "kind": "add" }]
```

只接受 successful `item.completed` file-change event，path 必须落在 immutable Run Workspace 内，并转换为 relative path。绝对路径、Workspace 外路径、NUL、未知 kind 和超限值全部丢弃。Spool replay 同样携带 bounded file changes，确保 taskd 短暂不可用时证据不丢失。

## API Read Model

`GET /api/v1/schedules` 每个 job 返回：

- `current_execution`：active Run 优先，其次 pending dispatch，最后 recent terminal Run。
- `last_run`：最近 Run。
- `unread_run_count`。

`GET /api/v1/schedules/:id/runs` 返回 `runs` 和该 Schedule 的 pending `dispatches`。Run API 输出 `file_changes`，不输出内部 absolute log path。

## 实时更新

runner protocol server 在成功完成以下 mutation 后发布 revision：

- `claim`
- `reportOverlap`
- `mark_running`
- `complete`

heartbeat 不发布，避免固定频率刷新；running duration 由浏览器本地时钟更新。Run now API 仍发布 dispatch revision。SSE 断开时保留现有 reconnect 行为。

## UI 信息架构

### Scheduled 主列表

- 保留页面标题、search、All/Active/Paused 和 `New schedule`。
- Schedule 使用 compact table-like row，不使用左侧绿色 rail 或 card shadow。
- 默认不显示 `ACTIVE`、`已同步`；Paused 和 sync error 只在需要时表达。
- 行内展示 title、cadence、Workspace、next run、current/recent execution。
- 点击 execution summary 打开 Run ledger Sheet，不提供 `Runs` 按钮。
- 操作保留 `Run now`、Edit、Pause/Resume。Run 按钮在 HTTP pending 阶段显示 loading；之后由 read model 状态接管。

### Run ledger Sheet

以 table 展示：

| State | Started | Duration | Trigger | Outputs | Session | Action |
| --- | --- | --- | --- | --- | --- | --- |

- pending dispatch 作为 queued、dispatch failed 或 dispatch stalled 行显示；stalled 使用“启动超时 / Runner 未领取”，不能继续显示 spinner。
- running 行使用小型 inline spinner 和 elapsed duration。
- Outputs 显示 file-change count 和首个 filename，选择后在 detail 中展示完整 relative paths。
- Session 使用缩短 ID，支持 copy。
- 有可信 thread 的 Run 提供 terminal icon button，调用现有 `resumeScheduledRun(runId)`；浏览器不提交 workspace、thread 或 shell command。
- 选择历史行后，在 table 下方展开 result、file changes 和 bounded logs。
- Desktop 使用右侧 Sheet；Mobile 使用 full-width Sheet，table rows 变为 labeled grid，不产生横向页面滚动。

## 视觉语言

- Redesign mode：targeted overhaul，保留全局 dark theme、font 与 accent token。
- `DESIGN_VARIANCE: 4`、`MOTION_INTENSITY: 3`、`VISUAL_DENSITY: 8`。
- 使用 hairline、spacing 和 type weight 建立层级，不使用彩色 card rail、glow、decorative dot 或成功 alert。
- 色彩只承担语义：running、success、failure；同时使用文本或 icon，不靠颜色单独表达。
- interaction target 最小 44px；micro motion 150-220ms，并遵守 `prefers-reduced-motion`。

## 错误与边界

- backend trigger 失败不显示假成功；dispatch 保持 pending 并显示 typed failure，下一次 Run now retry 同一 dispatch。
- active Run 存在时仍由 no-overlap 约束决定结果，不绕过 runner。
- 无 Session、Session inventory 找不到、terminal 不可用时，Resume disabled 或显示该 action 的 contextual error，不改变 Run history。
- invalid Markdown definition 继续使用现有 contextual error region，不混入 execution ledger。
- terminal Run immutable；file changes 作为 completion evidence 一并固定。

## 验收标准

1. backend 拒绝时，页面显示 dispatch failed，不显示“已请求运行”。
2. 重复点击同一 Schedule 不增加第二条 pending dispatch，且会 retry backend。
3. backend accepted 后，页面依次看到 queued、running、success/failure，无手动刷新。
4. SQLite Run 记录包含 thread ID 和安全的 Workspace-relative file changes。
5. Sheet table 展示 execution history、output filename、Session copy 和 terminal Resume。
6. 页面不存在 `Runs` 按钮、绿色 row rail、`ACTIVE/已同步` 默认文案和 mutation success alert。
7. desktop 1440x900、mobile 375x812、keyboard、reduced-motion 均通过视觉与功能验证。
