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
version=v0.3.0
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

安装或启用 plugin 不会自动信任 bundled hooks。首次使用时请在 Codex 的 trust review 中检查并允许 Tasks Recorder hooks，然后新开一个 conversation 使 MCP 与 hooks 全部生效。

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

1. `UserPromptSubmit` hook 把 `session_id`、当前 working directory 与 host identity 注入 agent context，提示 agent 先用 `agent_tasks_context` 查找语义匹配的任务。
2. Agent 通过 plugin 自带的 stdio MCP client 调用 `agent_tasks_upsert`、`agent_tasks_complete` 等 tools。MCP client 不读取数据库，只把请求发到 localhost `taskd`。
3. `PostToolUse` hook 发送节流 heartbeat，更新当前 session 已绑定任务的 `last_seen_at`；它不会猜测或创建任务。
4. `Stop` hook 在 conversation 结束前要求 agent 收口任务状态。若宿主被直接关闭、hook 没有触发，可以在 Dashboard 中手动修正 status。
5. `taskd` 是唯一 SQLite owner。写事务 commit 后发布轻量 SSE `changed` event；Dashboard 再读取 authoritative snapshot，因此页面不需要定时 polling，也不会生成一个带静态数据的 `dashboard.html`。
6. Dashboard 的 Tree/Grid 与 Timeline 读取同一份 snapshot。Timeline 可折叠，Grid/Timeline 分隔线可拖动，状态修改使用 optimistic concurrency 防止覆盖较新的 agent 更新。

这是一种本机 C/S 架构：plugin adapter 是 client，`taskd` 是 server，Dashboard 是另一个 browser client。adapter 没有 service 时会报告 `SERVICE_UNAVAILABLE`；service 没有 adapter 时仍可以运行并查看已有数据。

## Files and data

```text
~/.local/share/tasks-recorder/
├── current -> releases/<version>
└── releases/<version>/                 # immutable program files

~/.local/bin/tasks-recorder             # service management command

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
- Installer 在解包或执行 runtime 前校验 SHA-256，并拒绝 archive path traversal。

## License

Tasks Recorder 采用 [GPL-2.0-only](LICENSE)。你可以使用、修改、商用和再分发，但对外分发本项目或其修改版时，需要提供对应源码并继续按 GPL-2.0 授权。

Dashboard bundle 包含 GPL-2.0 的 DHTMLX Gantt Standard 9.1.0，详情见 [Third-Party Notices](ui/THIRD_PARTY_NOTICES.md)。这段说明不是法律意见。
