# Tasks Recorder

Tasks Recorder 是独立运行的本地 **Agent Task Control Plane**。`taskd` 由 macOS `launchd` 常驻管理并独占 SQLite；Agent integration 通过 MCP 与 Hook 写入，独立浏览器 Dashboard 通过 REST + SSE 实时观察任务。

Dashboard 地址：<http://127.0.0.1:43127>

## 目录边界

源码与用户状态严格分离：

```text
/Users/joi-com/Desktop/space/projects/tasks-recorder/  # 当前开发工作树
~/.config/tasks-recorder/
├── config.json                                       # 用户配置
├── tasks.sqlite                                      # canonical task state
└── auth-token                                        # 本地 Agent API 凭据，0600
```

日志位于 `~/Library/Logs/tasks-recorder/`。源码目录不保存数据库、token 或用户配置。

`config.json` 示例：

```json
{
  "output_dir": "/absolute/path/to/projections",
  "server_host": "127.0.0.1",
  "server_port": 43127
}
```

`output_dir` 只服务于旧版 `Tasks.md` / `History.md` projection；Dashboard 和任务数据库不依赖这些 Markdown 文件。

## 工作原理

```text
MCP / Hook ── authenticated HTTP ──▶ taskd ──▶ ~/.config/tasks-recorder/tasks.sqlite
                                          │ commit 后发布 changed
Browser ── GET snapshot + SSE events ─────┘
```

- `taskd` 是唯一 SQLite owner；MCP server 和 heartbeat Hook 都是 HTTP client。
- 页面建立一条 `EventSource` 长连接。每次写事务成功提交后，Server 发布轻量 `changed`，页面随后读取 authoritative snapshot。
- 没有固定间隔业务 polling。SSE keepalive 只维持连接，不查询数据库。
- `ui/dist/index.html` 是 immutable static build asset，不包含任务数据，运行时不会生成或改写 Dashboard 文件。
- SSE 断线时保留最后一次成功数据并自动重连；`ready` 事件触发全量校准。

## 本地开发与生命周期

开发环境要求 Node.js 24 或更高版本：

```bash
npm ci
npm run build
npm test
npm run check
```

安装本机常驻服务：

```bash
npm run taskd -- install
npm run taskd -- status
```

`install` 会固定当前 Node executable、生成或保留 `~/.config/tasks-recorder/auth-token`、写入 `~/Library/LaunchAgents/com.joi.tasks-recorder.taskd.plist`，并通过 `RunAtLoad + KeepAlive` 启动 Server。

可用命令：

```bash
npm run taskd -- start
npm run taskd -- stop
npm run taskd -- status
npm run taskd -- uninstall
```

`uninstall` 只卸载 LaunchAgent，不删除 `~/.config/tasks-recorder` 或日志。

## Agent integrations

仓库暂时保留以下 integration source：

- `mcp/`：STDIO MCP adapter。
- `hooks/`：UserPromptSubmit、PostToolUse heartbeat 与 Stop lifecycle hooks。
- `skills/`：任务管理指令。

它们不再通过 `.codex-plugin/plugin.json` 或本地 marketplace 自动安装。当前迁移阶段先移除旧 Codex plugin 注册；后续独立 installer 应把这些文件作为 thin integration 显式安装，并把 MCP command 指向独立项目或 release runtime。

## Lifecycle

- `UserPromptSubmit`：向 Agent 注入 session/workfolder/Agent context，要求所有具体工作不论时长都先完成 semantic matching 与 task upsert。
- `PostToolUse`：通过 taskd 对当前 session 最近绑定的未完成任务做节流 heartbeat；只更新 `last_seen_at`，不创建任务或推断状态。
- `Stop`：在 Agent 结束前要求语义收口当前任务状态。

Hook 失败会 fail-open，不阻断正常工具调用。taskd 不可用时，MCP 返回 `SERVICE_UNAVAILABLE`，不会降级为直接写 SQLite。

## Security

- Server 只监听 `127.0.0.1:43127`，不开放 LAN 或公网访问。
- Browser read API 校验 `Host/Origin`，不返回 CORS headers。
- Agent API 使用随机 Bearer token；token 文件权限为 `0600`，Dashboard 不读取 token。
- 请求体限制为 64 KiB；日志不主动记录 token 或任务正文。

## 数据与兼容性

持久化状态固定为 `planned | active | waiting | blocked | done`。`stale` 等仅由 Dashboard 根据 activity 计算；历史 session 没有 Agent 信息时显示 `Unknown`。

`agent_tasks_render` 与 `Tasks.md` / `History.md` 仅作为旧版本兼容 projection 保留。不要直接编辑 `tasks.sqlite` 或把 UI state 写入业务表。

## License

Dashboard bundle 包含 DHTMLX Gantt Standard 9.1.0，按 GPL-2.0 分发，详情见 `ui/THIRD_PARTY_NOTICES.md`。公开分发前仍需对完整组合进行 GPL 兼容性审查。
