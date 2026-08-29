# Architecture

本文描述 Tasks Recorder 当前必须保持的系统边界。面向用户的安装、使用与排障入口见 [`README.md`](../README.md)。历史 specs 和 job logs 记录决策过程，不代表现行 runtime contract。

## System shape

```text
Agent adapters ──HTTP──▶ taskd ──▶ tasks.sqlite
                           │
Schedule Markdown ────────▶│──▶ scheduler.sqlite
                           │
Dashboard ◀──HTTP + SSE───▶│──▶ Runtime Registry ──▶ local agent CLI
```

macOS `launchd` 只管理一个 KeepAlive service：`taskd`。`taskd` 是唯一 SQLite writer、唯一 HTTP/SSE server、唯一 scheduler 和唯一 Run supervisor。

## Non-negotiable invariants

1. **One daemon**：不得为单个 Schedule 创建 LaunchAgent、长期 runner 或第二个 control plane。
2. **One execution path**：manual 与 scheduled trigger 都调用 `RunService.create()`。
3. **Durable before spawn**：Run 必须先以 `queued` 写入 SQLite，提交后才能解析或启动 runtime。
4. **One Runtime Environment**：taskd 创建一个运行时环境实例，runtime status、model discovery、真实 Run 与 child PATH 都从这里获得 executable context。
5. **File-native definitions**：Schedule Markdown 是 definition source of truth；SQLite 不复制一份可编辑 definition。
6. **Taskd-owned facts**：只有 `taskd` 写 Run state、session、file changes 与 log references。
7. **No browser commands**：browser 只发送 semantic ID 和 typed fields，不能提交 executable、argv、Workspace 或 shell text。
8. **Failure isolation**：runtime 缺失、model probe 失败或 Run 失败不能让 Recorder database 和 Dashboard 下线。
9. **Bounded operations**：probe、output、logs、events、shutdown 与 cancellation 都必须有明确上限。
10. **Privacy by construction**：Recorder 不持久化 prompt、reasoning、tool payload、streaming assistant delta 或 transcript content；Scheduled ledger 只保留既有 terminal final message。

## Runtime registry

Registry 保存 immutable runtime definitions，不动态加载用户代码。每个 definition 只描述 runtime-specific behavior：

```js
{
  id,
  displayName,
  launch,
  versionProbe,
  fallbackModels,
  capabilities,
  fetchModels,
  buildInvocation,
  parseEvent,
  createInteractiveSession,
  readConversation,
}
```

Shared infrastructure 负责 executable candidate ordering、canonicalization、version probe、cache、child PATH repair、process supervision、timeout/cancel、Run persistence 和 SSE。只有已 canonicalize 为 executable file 的候选才消耗 bounded probe budget；不存在的 PATH entry 不得遮蔽后面的健康 CLI。Runtime Environment 动态枚举 process PATH、Homebrew、fnm/nvm/mise 等已安装 toolchain，并同时为 resolver 与 child process 生成一致路径。成功解析可 bounded cache；失败解析立即失效，以允许 CLI 安装或环境恢复后的下一次请求自愈。Adapter 不得导入 HTTP、SQLite、cadence 或 UI 模块。

Run store 的 one-active-per-Schedule 约束是 UI action availability 的事实来源：`queued`、`claimed` 或 `running` execution 必须同时在 renderer 与 click boundary 禁用 Run now；409 只保留为并发安全网，不能成为正常交互反馈。

当前只注册 `codex`。增加 runtime 的最小范围应是：

1. 新增一个 definition；
2. 新增该 CLI 的 stream parser；
3. 添加 resolver、model、invocation 与 parser tests；
4. 把 definition 加入 composition root；
5. 验证现有 Scheduler、Run store 和 Dashboard 无需 runtime-specific branch。

如果新增 runtime 需要修改 Run lifecycle、再建 daemon、再建数据库或让 browser 构造 command，说明 adapter boundary 设计错误，应先停止扩张。

Registry list 只验证 executable availability，不探测登录态。登录态是易变的 provider execution state；真实 Run 才是权威证据。Model discovery 是独立、bounded、可 fallback 的 capability。

## Run lifecycle

```text
queued
  ├── running
  │     ├── succeeded
  │     ├── failed
  │     ├── timed_out
  │     ├── canceled
  │     └── interrupted
  ├── failed
  └── canceled
```

- `queued` 包含 executable resolution 与 spawn preparation；不存在另一套 dispatch state。
- service restart 把遗留 open Run 收口为 `interrupted`，不自动假设 CLI 仍可安全接管。
- cancel 与 shutdown 必须能打断 resolution 和 child process，不能无限等待第三方 CLI。
- session ID、final message 与 usage 只能来自 normalized runtime events。file changes 优先消费 runtime evidence，并与 `RunService` 执行前后的 bounded Workspace snapshot 合并；snapshot 只在内存保留 metadata，忽略 `.git` / `node_modules`，超出 100,000 files 时 fail open，不阻塞 Run。
- SQLite 只保存最多 128 条已经 containment 检查的 Workspace-relative change paths，不保存 Workspace snapshot 或文件内容。
- log file path 由 taskd 构造；API 不读取 Run ledger 之外的任意 path。

## Active Live Session

Codex 的 active Run 使用 one-process-per-Run `codex app-server --listen stdio://`。这不是第二个 daemon：process lifecycle、timeout、cancel、terminal persistence 与 Run status 仍由 `RunService` 独占管理。

```text
Dashboard ──GET Run SSE──────────────▶ taskd Run Event Hub
Dashboard ──POST steer/stop──────────▶ RunService
                                            │
                                            └── private turnId ──▶ Codex app-server
```

- browser authority 只有 Run ID 与 taskd-generated `turn_revision`；Codex `turnId` 不出 driver。
- `turn/steer` 只接受 bounded guidance text；`turn/interrupt` 不接受 browser command。
- assistant delta、activity summary 与 intervention acknowledgement 只存在于 bounded memory SSE replay，不写 SQLite 或普通 logs。
- activity normalization 只公开 command label、file count、MCP server/tool 等安全摘要，不公开 arguments、results 或 reasoning。
- terminal SSE 到达后，Dashboard 必须关闭 Live stream 并重新读取 authoritative Run，避免 row/detail/session/summary 分裂。
- completed Run 不在 Dashboard 内继续 multi-turn；后续操作使用已有 Terminal Resume boundary。
- protocol request、frame、Run timeout 与 process shutdown 都有上限；`SIGINT` 无效时升级为 `SIGKILL`。

## Terminal conversation read

Completed Run history does not create a Tasks Recorder transcript store:

```text
Dashboard ──GET /runs/:id/conversation──▶ RunService
                                               │ trusted Run facts
                                               ▼
                                     Runtime adapter readConversation
                                               │ thread/read
                                               ▼
                                      CLI-owned local session
```

- browser 只能提交 Run ID；`RunService` 从 ledger 取得 runtime ID、session ID 与 immutable Workspace snapshot；
- Codex adapter 启动 bounded app-server client，并调用 `thread/read({ threadId, includeTurns: true })`；
- response 只规范化 `userMessage` 与 `agentMessage`，丢弃 reasoning、command、MCP/tool payload 与其他内部 item；
- normalized messages 仅存在于 request/React query memory，不写 SQLite、Run logs、localStorage 或 persistent cache；
- 本机 CLI session 缺失或协议不可用时返回 typed unavailable，UI 可回退到已经存在的 bounded `final_message`；
- 该路径只读历史；completed Run 的继续对话仍通过 Terminal Resume，不从 Dashboard 创建 follow-up Turn。

## Schedule clock

`scheduler-clock` 在 `taskd` 内根据 wall clock 和 durable occurrence key 计算到期任务。filesystem watcher 负责低延迟 definition change，周期 rescan 提供最终一致性。sleep/wake 可产生 bounded catch-up，但同一个 occurrence key 不能创建两次 Run。

Definitions directory 切换是一个受控迁移：验证目标、迁移/合并、切换 repository、替换 watcher、持久化 config；任一步失败都恢复旧 repository 和 watcher。

## Compatibility and migrations

Scheduler schema v4 是当前 unified Run ledger。v1–v3 tables 只保留在 migration code 中用于升级已有数据库，不得重新成为 active execution path。

安装或卸载时可以清理由 Tasks Recorder 明确拥有的旧 per-Schedule LaunchAgents；cleanup 必须验证 owner、mode、symlink 和 canonical program path，无法确认的文件 fail closed。

## Verification gates

```bash
npm run build
npm run build:adapters
npm run check
npm test
git diff --check
```

架构变更还必须证明：

- Markdown → due occurrence → queued Run → CLI → terminal Run 的 integration test；
- runtime resolution 卡住时 cancel/shutdown 能及时完成；
- missing runtime/model catalog 返回 typed state，不返回 missing route；
- release artifact 包含 registry、adapter、Run service 与 migration，且不包含 legacy scheduled runner；
- source Dashboard 与 taskd API version/capability 不兼容时显式失败。
- fake app-server E2E 必须覆盖 Run-specific SSE、mouse steer、Stop、terminal authoritative refresh 与 CLI-owned conversation read；runtime `turnId` 和 guidance 不得进入 Run response、SQLite 或 logs。
