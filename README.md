# Tasks Recorder

Tasks Recorder 是面向 coding agent 的本机工作记录员。它先把 Codex 或 Claude Code 实际发生的工作记录到 SQLite，再把可验证的工作片段组织为 Project / Main Task / Subtask，并提供实时更新的 Tree + Timeline Dashboard。

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
version=v0.6.1
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

Tasks Recorder 把事实记录与用户语义分开：

- **事实层**：Observation、Source Session、Execution 与 Work Segment 记录宿主实际发生了什么，不把 prompt、reasoning、tool input/output 写入数据库。
- **语义层**：Project、Main Task 与 Subtask 表示用户认可的工作结构。Task ID 跨 session、turn、branch 和 worktree 保持稳定；Segment Attribution 是事实与 Task 之间唯一可审计、可纠正的桥梁。

实时链路如下：

1. Native adapter 把 `SessionStart`、`UserPromptSubmit`、`PostToolUse`、subagent lifecycle、`Stop` 与 `SessionEnd` 映射为 host-neutral Event Envelope，经短超时投递到 `POST /api/v1/events`；taskd 暂不可达时进入 bounded spool，Hook 始终 fail-open。taskd 启动 replay 时，临时 transport/storage 错误保留事件等待下次重试；确定不可重试的 Event contract/identity 冲突进入本机 `.invalid` 隔离文件，后续事件继续 replay，避免一个 poison event 永久阻塞队列。
2. `UserPromptSubmit` 提供稳定的 `execution_id`。Agent 对 concrete work 先调用 `agent_work_context`；只有真实 focus 变化、里程碑或 Task 结构变化时才调用 `agent_work_focus`、`agent_work_checkpoint`、`agent_tasks_mutate` 或 `agent_tasks_sync_structure`。
3. `PostToolUse` 只刷新 execution fact activity，不读取 context、不同步整棵 Task tree，也不保存 tool input/output。普通对话可以保持未归属，或在 Dashboard 标记为 `non_work`。
4. child execution 只有在 spawn 前通过 `agent_work_intent` 声明了宿主可观测的 exact agent key 时才自动 Attribution；否则进入 Inbox，不按时间邻近、agent type 或 prompt 相似度猜测。
5. `Stop` 只尽力提交 execution end fact，立即返回且永不要求 continuation；`SessionEnd` 收口该 source session 的执行事实。两者都不会自动完成 Task，宿主被直接关闭造成的状态缺口由 recovery 与 Dashboard correction 处理。
6. `taskd` 是唯一 SQLite owner。写事务 commit 后发布轻量 SSE `changed` event；Dashboard 再读取 authoritative snapshot，因此页面不需要定时 polling，也不会生成一个带静态数据的 `dashboard.html`。
7. Dashboard 的一级节点是 Project，下面依次是 Main Task 与 Subtask；Project 是只读 projection，不会伪装成可编辑 Task。Tree/Grid 与 Timeline 读取同一份 canonical v3 snapshot。UI 使用 MIT 许可的 SVAR React Gantt 作为 virtualized renderer，并维护筛选、SSE refresh、视图状态恢复、可访问的 splitter、当前时间 marker 与详情交互。默认 Grid 保留任务、状态/进度、执行上下文、Session ID 与活动五个决策字段；工作目录、Worktree 与 Branch 合并展示，Session ID 紧凑显示但复制完整值。
8. Timeline 把 Planned 与 Actual 分开表达：叶子 Task 保留 A → B → A 这样的真实 split Segment，Main Task 与 Project 使用覆盖全部 descendants 的 actual envelope，因此父级 scope 不会与子级交叉。默认 `Auto` 会按当前 Project 的 planned/actual extent 在 hour、day、week、quarter 之间自适应并保留水平留白；也可手动切换日、周、月粒度。
9. “Project Inbox”处理尚未确认属于哪个 Project 的 Source Session；“任务待归属”处理 Project 已知但 Task 未知的 Work Segment。两者分开呈现，分配必须由明确选择或确定性证据驱动，不按 branch、标题相似或时间邻近猜测。选中 Task 可打开 details Sheet，编辑 Summary、查看 Executions 与 Activity，并执行 archive、soft delete、restore 等操作；所有编辑使用 revision/compare-and-set，避免覆盖较新的 Agent 或浏览器更新。

这是一种本机 C/S 架构：plugin adapter 是 client，`taskd` 是 server，Dashboard 是另一个 browser client。adapter 没有 service 时会报告 `SERVICE_UNAVAILABLE`；service 没有 adapter 时仍可以运行并查看已有数据。

### Legacy compatibility window

`agent_tasks_*` legacy MCP/API 仍在整个 `0.6.x` release line 中提供 compatibility wrapper，但返回 `deprecated: true`、replacement 和 lossy warning；单值 execution `task_id` 无法完整表达多个 Work Segment。新 adapter/skill 只使用 `agent_work_*`、`agent_tasks_mutate` 与 `agent_tasks_sync_structure`。legacy wrapper 最早在 `0.7.0` 移除；升级自定义 client 前应先按返回的 replacement 完成迁移。

## Files and data

```text
~/.local/share/tasks-recorder/
├── current -> releases/<version>
└── releases/<version>/                 # immutable program files

~/.local/bin/tasks-recorder             # service management and import CLI

~/.config/tasks-recorder/
├── config.json                         # user configuration
├── tasks.sqlite                        # canonical data
├── spool/                              # bounded Event Envelope；*.invalid 为不可重试事件隔离证据
└── logs/
    └── tasks-recorder.ndjson           # privacy-bounded structured events

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

当前 runtime 使用 schema v3。空数据库会直接初始化为 v3；已有 schema v1/v2 数据库不会被静默升级，`taskd` 会以 `SCHEMA_MIGRATION_REQUIRED` 拒绝启动。旧 runtime 也不能打开 v3 数据库，因此升级现有安装时必须显式执行下述 migration。

## Migrate a schema v2 database

先停止唯一的 SQLite writer，再运行 read-only preview：

```bash
tasks-recorder stop
tasks-recorder migrate --dry-run
```

dry-run 只读打开 `~/.config/tasks-recorder/tasks.sqlite`，不会创建 backup、修改 `user_version` 或写入业务数据。JSON report 只包含 legacy counts、计划生成的 Project 数、ambiguity code 汇总，不回显 Task title、Session ID 或 repository path。ambiguity 不会被猜测合并；apply 后仍可在 Project Inbox 中显式处理。

确认 report 后，选择一个**尚不存在**且不同于 source database 的 backup path，再显式 apply：

```bash
tasks-recorder migrate --apply \
  --backup "$HOME/.config/tasks-recorder/backups/tasks-v2-before-v3.sqlite"
```

apply 会先 checkpoint WAL，创建权限为 `0600` 的 verified schema-v2 backup，校验 SHA-256 与 SQLite integrity，然后在一个 transaction 中迁移；任何 transform 或 invariant failure 都会 rollback source database。若 taskd 仍可访问、backup 已存在、source 不是 schema v2，或 backup 与 source 指向同一路径，命令会 fail closed。

迁移成功后启动并检查 service：

```bash
tasks-recorder start
tasks-recorder status
```

需要演练非默认副本时，可对两个命令都加 `--database /absolute/path/to/tasks.sqlite`。这不会改变默认配置。

若 migration 后需要 rollback：先 `tasks-recorder stop`，把当前 v3 database 及其 `-wal` / `-shm` sidecars 移到独立恢复目录，再把 verified backup 复制回 canonical path，并用 installer 的 `--version <previous-v2-tag>` 切回迁移前 runtime；不要让 v2 runtime 打开 v3 database，也不要让 v3 runtime 打开恢复后的 v2 backup。

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

Apply 通过 localhost API 由 `taskd` 在一个事务中写入，并使用 immutable host IDs 生成的 external keys 保证重复执行幂等。Importer 不修改 Task title/status，也不会按时间范围把 execution 强制分给 Task；只有 existing session binding 能唯一证明归属时才绑定，其余进入对应的 Project Inbox 或任务待归属。

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
tail -n 100 ~/.config/tasks-recorder/logs/tasks-recorder.ndjson
curl -fsS http://127.0.0.1:43127/health/ready
curl -fsS http://127.0.0.1:43127/api/v1/status
```

常见情况：

- `SERVICE_UNAVAILABLE`：先确认 service 已安装且 `health/ready` 返回成功。
- Dashboard 无法打开：检查 `server_port` 是否被占用，以及 stderr log。
- `health/ready` 可访问但状态为 degraded：查看 `/api/v1/status` 中的 schema、spool、logger 与 recovery 摘要；该接口不会返回 Event payload 或凭据。
- `spool.last_replay_error` 为 `SPOOL_REPLAY_SEND_FAILED`：升级到最新 patch release 并重启 service；临时错误会保留重试，确定不可重试的 identity/contract conflict 会以 `0600` `.invalid` 文件隔离并继续 replay，不需要手动删除 active spool。
- Dashboard 正常但没有自动记录：确认 adapter 已启用、重启宿主，并完成 hook trust/MCP approval。
- 历史 import 返回 `CODEX_SESSION_NOT_FOUND`：确认使用完整、精确的 root Session ID；非默认 Codex 数据目录需要传 `--codex-home`。
- 历史 import 后仍有未归属记录：这是无法唯一证明归属时的预期行为；先在 Project Inbox 确认 Project，再在“任务待归属”中分配 Task 或标记 `non_work`。
- 历史 import route 不存在：service runtime 版本早于 importer，请先升级 service；只升级 adapter 不会更新 `taskd`。
- Codex 仍显示 `Stop hook (blocked)`：当前 adapter 的 Stop 不会阻断或请求 continuation，这表示仍在使用旧 adapter。运行 `codex mcp get tasks-recorder`，正常配置应显示 `args: dist/mcp-server.mjs` 和 `cwd: .`；若仍显示 `${PLUGIN_ROOT}`，请升级或重新安装 adapter，并新开 conversation。
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

Dashboard bundle 使用 MIT 许可的 SVAR React Gantt、React 与 React DOM，详情见 [Third-Party Notices](ui/THIRD_PARTY_NOTICES.md)。这段说明不是法律意见。
