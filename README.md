# Tasks Recorder

Tasks Recorder 是面向 coding agent 的本地 Task Control Plane。它把 Codex 或 Claude Code 的工作记录到本机 SQLite，并提供可实时更新的 Tree + Timeline Dashboard。

- `taskd` 是唯一 SQLite writer，由 macOS `launchd` 常驻管理。
- Dashboard 访问地址：<http://127.0.0.1:43127>。
- Codex 与 Claude Code adapter 分别维护、分别安装，参考 Superpowers 的 multi-harness 做法。
- 所有数据保存在本机，不需要 cloud account 或 auth token。

## Requirements

- macOS
- Node.js 24 或更高版本
- `curl` 与系统自带的 `tar`、`shasum`

普通安装不需要 Git、clone repository、`npm install` 或 `npm ci`。`npm ci` 只用于源码开发。

## Install the service

一行安装 latest GitHub Release：

```bash
curl -fsSL https://raw.githubusercontent.com/joisun/tasks-recorder/main/install.sh | bash
```

`curl | bash` 方便但会直接执行远端脚本。更审慎的方式是固定版本、先查看 installer，再执行；installer 会在解包前使用 Release 中的 `SHA256SUMS` 校验 runtime artifact：

```bash
version=v0.4.0
curl -fsSLO "https://raw.githubusercontent.com/joisun/tasks-recorder/${version}/install.sh"
less install.sh
bash install.sh --version "$version"
```

安装完成后打开 <http://127.0.0.1:43127>。若 `~/.local/bin` 已在 `PATH` 中，也可以运行：

```bash
tasks-recorder status
tasks-recorder stop
tasks-recorder start
```

Service 可以独立运行；下一步只安装你实际使用的 agent adapter。

## Install the Codex adapter

```bash
codex plugin marketplace add joisun/tasks-recorder
codex plugin add tasks-recorder@tasks-recorder
```

安装或启用 plugin 不会自动信任 bundled hooks。首次使用时在 Codex 中运行 `/hooks`，确认 Tasks Recorder 的 `SessionStart`、`UserPromptSubmit`、`PostToolUse`、`SubagentStart`、`SubagentStop`、`SessionEnd` 和 `Stop` hooks 都显示为 trusted，然后新开一个 conversation 使 MCP 与 hooks 全部生效。只信任其中一部分时，Task 仍可通过 MCP 写入，但 execution lifecycle 会出现缺口。

## Install the Claude Code adapter

```bash
claude plugin marketplace add joisun/tasks-recorder
claude plugin install tasks-recorder@tasks-recorder
```

安装后重启 Claude Code，或按 Claude Code 当前版本的提示 reload plugins。若出现 MCP approval，请确认其 command 只启动安装在 plugin cache 内的 `dist/mcp-server.mjs`，并连接 `127.0.0.1` 上的 Tasks Recorder service。

Codex 和 Claude Code 的 adapter 是两个独立 plugin root：

```text
adapters/
├── codex/tasks-recorder/
└── claude/tasks-recorder/
```

它们各自维护 manifest、marketplace metadata、hooks、MCP config 与 MCP bundle；不会通过兼容层强行复用。两者只共享同一个 localhost HTTP API contract。

## How it works

```text
Codex hooks + MCP ──┐
                    ├── HTTP 127.0.0.1 ──▶ taskd ──▶ SQLite
Claude hooks + MCP ─┘                         │
                                             ├── REST snapshot
Browser Dashboard ◀──────────── SSE changed ─┘
```

Tasks Recorder 把两个容易混淆的对象分开：

- **Task** 表示要交付的目标，ID 跨 session、turn、branch 和 worktree 保持稳定。一个 root Task 可有一层 direct child；同一 conversation 先做 A、再做 B 时，应记录两个独立 Task，而不是把整个 conversation 当成一个 Task。
- **Execution** 表示某个 session、turn 或 subagent 的一次执行区间。一个 Task 可对应多个 executions，一个 execution 也可以先保持未绑定，等待用户或 Agent 归类。

实时链路如下：

1. `SessionStart` 注册或恢复 root session；`UserPromptSubmit` 为新的 main turn 创建幂等 execution，并把 `session_id`、`turn_id` 与 working directory 注入 Agent context。
2. Agent 先调用 `agent_tasks_context`，再通过 `agent_tasks_sync_tree` 同步 root 与完整的一层 children，并用 `focus_task_id` 把当前 main execution 绑定到正在执行的 Task。旧的 `agent_tasks_upsert` / `agent_tasks_complete` contract 继续兼容。
3. `PostToolUse` 更新 execution heartbeat；遇到 `update_plan` 时只记录结构化 plan observation，等待 Agent 明确同步 Task tree，不按 prompt 或文本相似度猜造 Task。
4. `SubagentStart` / `SubagentStop` 记录 child execution。只有 `agent_key` 在当前 root tree 中唯一匹配时才自动绑定；否则进入 Dashboard 的未绑定 inbox。subagent 结束不等于 child Task 自动完成。
5. `SessionEnd` 关闭仍 active 的 execution；`Stop` 仅在存在待同步 plan、未绑定 work execution 或需收口的 Task 时要求 Agent 处理。宿主被直接关闭造成的状态缺口可在 Dashboard 中修正。
6. `taskd` 是唯一 SQLite owner。写事务 commit 后发布轻量 SSE `changed` event；Dashboard 再读取 authoritative snapshot，因此页面不需要定时 polling，也不会生成一个带静态数据的 `dashboard.html`。
7. Dashboard 的 Tree/Grid 与 Timeline 读取同一份 snapshot。Grid 展示 progress、active agents、execution count、完整 Session ID、工作目录、Worktree 与 Branch；Session ID 可复制，root 可折叠，Grid/Timeline 分隔线可拖动。
8. 选中 Task 可打开 details Sheet，编辑 Summary、查看 Executions 与 Activity，并执行 archive、soft delete、restore 等操作。所有编辑使用 revision/compare-and-set，避免覆盖较新的 Agent 或浏览器更新。工具栏的未绑定 inbox 支持筛选、批量分配 Task 或标记 `non_work`。

这是一种本机 C/S 架构：plugin adapter 是 client，`taskd` 是 server，Dashboard 是另一个 browser client。adapter 没有 service 时会报告 `SERVICE_UNAVAILABLE`；service 没有 adapter 时仍可以运行并查看已有数据。

## Files and data

```text
~/.local/share/tasks-recorder/
├── current -> releases/<version>
└── releases/<version>/                 # immutable program files

~/.local/bin/tasks-recorder             # service management and import CLI

~/.config/tasks-recorder/
├── config.json                         # user configuration
└── tasks.sqlite                        # canonical data

~/Library/Logs/tasks-recorder/
├── taskd.stdout.log
└── taskd.stderr.log
```

`tasks.sqlite-wal` 与 `tasks.sqlite-shm` 可能在 service 运行时出现在数据库旁边，这是 SQLite WAL 的正常 sidecar。
Canonical database 的完整路径是 `~/.config/tasks-recorder/tasks.sqlite`。

默认配置：

```json
{
  "output_dir": ".",
  "server_host": "127.0.0.1",
  "server_port": 43127
}
```

`output_dir` 只用于兼容旧版 `Tasks.md` / `History.md` projection；Dashboard 不依赖这些 Markdown files。

数据库使用 schema v2。首次由新版 `taskd` 打开 schema v1 数据库时，会在单事务中保留原有 `tasks` / `task_sessions` 并增加 Task tree、execution、event 和 plan observation 表；失败会 rollback。旧版 runtime 无法打开已经迁移到 v2 的数据库，如需可回退能力，应在首次启动新版 service 前停止 `taskd` 并备份 `tasks.sqlite`，回退时同时恢复该备份。

## Import historical Codex sessions

历史记录不会在后台自动扫描或导入。先对一个精确 root Session ID 做 dry-run：

```bash
tasks-recorder import codex --session <session-id> --dry-run
```

CLI 会在 `~/.codex/sessions` 中用 exact ID 解析 root，读取各 transcript 的 bounded `session_meta` 以发现 direct child，然后只从该 root 与 direct child transcripts 投影 lifecycle metadata。输出包括 root turns、subagent executions、`would_create` / `would_update` / `skipped`、未绑定数量与 warnings；dry-run 对 SQLite 零写入。

确认预览后，去掉 `--dry-run` 才会 apply：

```bash
tasks-recorder import codex --session <session-id>
```

Apply 通过 localhost API 由 `taskd` 在一个事务中写入，并使用 immutable host IDs 生成的 external keys 保证重复执行幂等。Importer 不修改 Task title/status，也不会按时间范围把 execution 强制分给 Task；只有 existing session binding 能唯一证明归属时才绑定，其余进入未绑定 inbox。

若使用非默认 Codex home，可显式传入：

```bash
tasks-recorder import codex --session <session-id> --dry-run --codex-home /path/to/.codex
```

## Update and uninstall

升级 latest version 只需重新运行 installer。它先验证新 artifact，再原子切换 `current` symlink，不覆盖 `config.json` 或数据库：

```bash
curl -fsSL https://raw.githubusercontent.com/joisun/tasks-recorder/main/install.sh | bash
```

只卸载 LaunchAgent、保留已安装程序：

```bash
tasks-recorder uninstall
```

卸载 LaunchAgent 与所有 program releases，同时保留数据库、配置和日志：

```bash
curl -fsSL https://raw.githubusercontent.com/joisun/tasks-recorder/main/install.sh | bash -s -- --uninstall
```

数据删除是独立的 destructive action；installer 不会自动删除 `~/.config/tasks-recorder`。

Plugin adapter 通过对应宿主管理：

```bash
codex plugin remove tasks-recorder@tasks-recorder
claude plugin uninstall tasks-recorder@tasks-recorder
```

## Troubleshooting

查看 service 状态与日志：

```bash
tasks-recorder status
tail -n 100 ~/Library/Logs/tasks-recorder/taskd.stderr.log
curl -fsS http://127.0.0.1:43127/health/ready
```

常见情况：

- `SERVICE_UNAVAILABLE`：先确认 service 已安装且 `health/ready` 返回成功。
- Dashboard 无法打开：检查 `server_port` 是否被占用，以及 stderr log。
- Dashboard 正常但没有自动记录：确认 adapter 已启用、重启宿主，并完成 hook trust/MCP approval。
- 历史 import 返回 `CODEX_SESSION_NOT_FOUND`：确认使用完整、精确的 root Session ID；非默认 Codex 数据目录需要传 `--codex-home`。
- 历史 import 后 execution 仍未绑定：这是无法唯一证明 Task 归属时的预期行为，请在 Dashboard 未绑定 inbox 中分配或标记 `non_work`。
- 历史 import route 不存在：service runtime 版本早于 importer，请先升级 service；只升级 adapter 不会更新 `taskd`。
- Codex 显示 `Stop hook (blocked)`：这通常表示 hook 已成功要求 agent 收口状态，不代表 hook 自身崩溃；若随后提示 `agent_tasks_context` unavailable，运行 `codex mcp get tasks-recorder`，正常配置应显示 `args: dist/mcp-server.mjs` 和 `cwd: .`。若仍显示 `${PLUGIN_ROOT}`，请升级或重新安装 Codex adapter。
- 更新 plugin 后旧 conversation 没变化：新开 conversation，避免复用已经建立的 MCP process。
- `~/.local/bin/tasks-recorder: command not found`：把 `~/.local/bin` 加入 shell `PATH`，或直接在浏览器访问 Dashboard。

## Develop from source

```bash
git clone https://github.com/joisun/tasks-recorder.git
cd tasks-recorder
npm ci
npm run build
npm run build:adapters
npm run check
npm test
```

本地安装 source checkout 的 service：

```bash
npm run taskd -- install
npm run taskd -- status
```

构建 Release artifacts：

```bash
npm run package:release
```

输出位于 `release/`：service runtime、Codex adapter 与 Claude Code adapter 各自一个 archive。GitHub Actions 在 pull request/push 上执行完整验证，在 `v*` tag 上校验 tag 与 `package.json` version 一致并创建带 `SHA256SUMS` 的 GitHub Release。

## Security

- `taskd` 只监听 `127.0.0.1`，不会暴露给 LAN 或公网。
- HTTP routes 校验 `Host`；browser request 带 `Origin` 时必须等于实际 loopback origin。
- 设计信任同一 OS user 下运行的本机 process，因此不使用 auth token，也不隔离同一用户身份的其他程序。
- 不要把 service 反向代理到 LAN/公网。
- Hooks fail open：Tasks Recorder 故障不会阻断正常 tool call，但可能造成一次 activity/status 未记录。
- SQLite 只保存 Task metadata、plan observation 和 lifecycle fields。Importer 不写入 prompt、reasoning、assistant message、tool output、token 或 transcript 正文；只保留本机 `transcript_path` 便于审计定位。
- Installer 在解包或执行 runtime 前校验 SHA-256，并拒绝 archive path traversal。

## License

Tasks Recorder 采用 [GPL-2.0-only](LICENSE)。你可以使用、修改、商用和再分发，但对外分发本项目或其修改版时，需要提供对应源码并继续按 GPL-2.0 授权。

Dashboard bundle 包含 GPL-2.0 的 DHTMLX Gantt Standard 9.1.0，详情见 [Third-Party Notices](ui/THIRD_PARTY_NOTICES.md)。这段说明不是法律意见。
