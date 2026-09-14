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
11. **Per-Run context policy**：Schedule 的 Skills/integrations policy 必须进入 immutable Run snapshot，并只通过该 Run 的 runtime argv/protocol 生效；不得修改全局 CLI config 或共享 profile。

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

Run store 的 one-active-per-Schedule 约束是 UI action availability 的事实来源：空闲时行级 action 提供一次性 Run now；已有 `running` Run 时同一位置切换为 Stop，并与负责周期调度的 Schedule pause/resume action 使用不同图标和语义。`queued`、`claimed` 等尚不能安全停止的阶段会禁用 Run now；409 只保留为并发安全网，不能成为正常交互反馈。

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
- app-server 单帧上限为 16 MiB（包括历史对话响应），按分片累积，完整帧只合并一次，避免大消息反复复制。超限仍以 `RUNTIME_PROTOCOL_FRAME_TOO_LARGE` 收口，不能无限分配内存。
- protocol request、frame、Run timeout 与 process shutdown 都有上限；`SIGINT` 无效时升级为 `SIGKILL`。

### Context capability isolation

Schedule 可分别把 `skills` 与 `integrations` 设为 `inherit` 或 `disabled`。旧 Markdown 缺省时保持 `inherit / inherit`；Dashboard/API 新建时默认 `disabled / disabled`。`integrations` 只包含 MCP servers、plugin MCP 与 Apps/Connectors，不包含 Web Search 或 Codex core tools；Sandbox 仍独立决定文件系统与网络权限。

Codex adapter 在 spawn 前用同一 executable、cwd 与 child environment 执行 bounded `codex mcp list --json`，再通过本 Run 的 app-server argv 明确禁用 plugins、Apps 和枚举到的 MCP identities。`skills: disabled` 时，adapter 在 `thread/start` 前调用 `skills/list`，为该 Workspace 的每个 Skill path 写入 thread-local disabled config，同时关闭 Skill search 与 Skill MCP dependency install。任何 discovery 失败都在创建 Thread 前 fail closed，返回 typed Run error；不得以“部分禁用”继续执行。

## Terminal conversation read

Completed Run history does not create a Tasks Recorder transcript store:

```text
Dashboard ──GET /runs/:id/conversation──▶ RunService
                                               │ trusted Run facts
                                               ▼
                                     Runtime adapter readConversation
                                               │ thread/items/list
                                               ▼
                                      CLI-owned local session
```

- browser 只能提交 Run ID；`RunService` 从 ledger 取得 runtime ID、session ID 与 immutable Workspace snapshot；
- Codex adapter 启动 bounded app-server client，优先使用 `thread/items/list` 分页读取，旧 CLI 明确不支持该方法时才回退 `thread/read({ threadId, includeTurns: true })`；
- response 只规范化 `userMessage` 与 `agentMessage`，丢弃 reasoning、command、MCP/tool payload 与其他内部 item；
- normalized messages 仅存在于 request/React query memory，不写 SQLite、Run logs、localStorage 或 persistent cache；
- 本机 CLI session 缺失或协议不可用时返回 typed unavailable，UI 可回退到已经存在的 bounded `final_message`；
- 该路径只读历史；completed Run 的继续对话仍通过 Terminal Resume，不从 Dashboard 创建 follow-up Turn。

## Run output files

React Run detail 使用 `POST /api/v1/runs/:id/files/open`，JSON body 只允许 `{ path }`。接口沿用 loopback Host、same-Origin 与 JSON 请求保护。RunService 从 ledger 读取 immutable snapshot 和 file_changes；客户端不得传 workspace、command 或 application。

file opener 要求 path 精确匹配该 Run 的非删除文件记录，相对路径以 snapshot.workspace 解析；路径规范化及 realpath 后均须处于该 workspace 内，且目标必须为普通文件。macOS 通过 argv array、`shell: false` 调用 `/usr/bin/open`，参数为编码后的本地 file URL，使用系统默认应用。未记录、已删除、缺失、越界、非普通文件、非 macOS 或 opener 失败均返回可展示的 typed error；不回写 Run，也不执行 shell 拼接命令。

## Schedule clock

`scheduler-clock` 在 `taskd` 内根据 wall clock 和 durable occurrence key 计算到期任务。filesystem watcher 负责低延迟 definition change，周期 rescan 提供最终一致性。sleep/wake 可产生 bounded catch-up，但同一个 occurrence key 不能创建两次 Run。

Definitions directory 切换是一个受控迁移：验证目标、迁移/合并、切换 repository、替换 watcher、持久化 config；任一步失败都恢复旧 repository 和 watcher。

## Dashboard Tree / Timeline rendering

Production `taskd` 明确读取自包含的 `ui/dist/react.html`。`ui/dist/index.html` 继续随 release 打包，仅用于回滚和迁移对照，不参与默认路由；source preview 与 installed runtime 因此使用同一 React entry 和同一 API contract。

React Tasks 使用单一原生 overflow 容器承载 Tree 与 Timeline，每个任务的两侧内容共享同一条 30px 行。任务列通过 sticky 固定在左侧；独立横向 scrollbar 仅通过 CSS 变量同步任务列位移。纵向滚动及 Timeline 横向滚动不得写入 React state 或触发数据投影、组件初始化。表头固定在顶部；列宽与分栏宽度独立调整。Workspace 列以用户设置宽度为下限，吸收左侧面板的剩余空间；其他列保持设置宽度，总列宽超出面板时横向滚动。键盘焦点进入被裁剪的任务列时统一调整列窗口，不允许单行独立横向位移。

Dashboard snapshot、状态筛选与展开状态共同约束实际挂载行数；折叠子树不挂载，滚动不回收可见树的行节点。时间坐标与刻度由有界纯函数生成，每层至多 500 个刻度，按本地日历边界覆盖完整时间范围。计划基线、实际执行分段和短条外置标签使用同一坐标系。未来若任务规模超出完整行 DOM 的预算，须以真实数据测量后引入共享行窗口的 virtualization，并保持 Tree / Timeline 同行对齐。

任务筛选与 Timeline projection 按 `tasks` 引用缓存；当任务无需 snapshot 时间 fallback 时，仅 revision、Inbox 或生成时间变化不得重建行投影。缺少自身 activity / update timestamp 的任务仍允许以 `generated_at` 作为时间范围 fallback。Grid cell 必须使用稳定的 React 组件类型，操作回调与 pending 状态通过 Context 更新，不得动态创建 cell component 触发 remount。

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
- Schedule capability E2E 必须覆盖 Markdown/REST policy、immutable Run snapshot、integration argv overrides、Skill thread config、mixed policies与 Web Search 不受影响。

### Schedule Fast mode

Schedule Markdown 与 CRUD API 的可选 `fast_mode` 为 boolean 或 null，仅 Codex 支持显式 boolean。省略/null 继承运行时默认，true 开启，false 使用普通速度；旧 definition 无需迁移。Run 沿用完整不可变 snapshot 保存选择。Codex interactive adapter 将显式值映射为 `turn/start.serviceTier` 的 `fast` / `default`；CLI invocation 对应 `-c service_tier="fast"` / `"default"`，继承时不传覆盖值。不要用降低 reasoning effort 实现 Fast mode，也不要修改用户的全局 Codex 配置。

### Codex 连接关闭

App-server client 的 `onClose` 是一次性生命周期通知，覆盖无 pending RPC 时的进程退出、pipe error 与主动关闭；晚订阅者立即收到已保存的关闭结果。启动未完成时关闭也必须拒绝 `started`，不能留下无限等待。Interactive session 在启动请求前订阅，完成时退订，异常关闭立即 settle 为 failed，保留数字 exit code、已有 session ID 和已确认 file changes；不把原始 stderr、RPC payload 或未完成回复写入错误字段。主动取消与正常 Turn 完成先 settle 再关连接，避免被错误覆盖。RunService 沿用 terminal persistence 与 SSE 更新界面。


### Schedule network access and recovery

可选 `network_access` 为 boolean/null，仅 Codex 支持；缺省继承。Markdown、CRUD、Run snapshot 与两个编辑器必须保持 true/false/null 的语义。Interactive adapter 在 `thread/start.config` 传递 `sandbox_workspace_write.network_access`，CLI 路径传递对应 `-c`；不改变审批策略、全局配置或其他任务。该原生键仅影响 workspace-write 的 shell 网络策略。

`RunService` 在 normalized `session` 事件到达时立即调用 `RunStore.recordSession`，而不是等待终态。完成、取消、超时与异常分支保留已知 session；restart recovery 仍将 open Run 标为 interrupted，不自动接管进程。UI 仅终态允许 Terminal Resume。

Dashboard SSE 的 changed/open 必须使 schedules（含运行历史）和 runs（含详情）查询失效，并沿用 2 秒合并窗口。Live SSE 重连保留 cursor 和草稿，reset 后清除旧 cursor；连接丢失或恢复时补读 authoritative Run，使遗漏终态也能关闭 stream。客户端最多保留 500 条实时条目；完整对话仍由 Codex-owned session 提供。

Cadence 输入校验错误返回 `SCHEDULE_INPUT_INVALID`，不能暴露为泛化 500 错误。

已到期的一次性定义仍须可读取、编辑与查看运行历史，不能因时间流逝变为 invalid。读写 codec 允许过去的 once 时间；新建或明确修改 cadence 的 API 仍要求未来时间，调度防重由持久化 occurrence 负责。

历史对话优先使用原生 `thread/items/list`（倒序分页，每页 8 条，最多 128 页），仅保留 user/assistant messages 后按时间正序展示。字符总量仍限制为 1 MiB，达到页数或容量上限必须标记 truncated；不落盘工具输出。仅旧 CLI 明确返回 method-not-found 时退回有 16 MiB 上限的 `thread/read`。

Run SSE 每 15 秒发送 comment 保活，关闭 response 时同时清理 timer 与订阅。开发代理必须立即转发响应头，不能等下一条事件才让浏览器进入 connected。全局变更只刷新 Run 元数据，避免反复启动 CLI 重读终态对话。
