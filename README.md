# Tasks Recorder

Tasks Recorder 是运行在本机的 coding-agent 工作记录与自动化控制台。它记录“发生了什么、正在做什么”，把分散在 session、turn、subagent、branch 和 worktree 中的工作整理为 Project / Main Task / Subtask，并通过实时 Dashboard 提供可追踪的 Tree、Timeline 与执行历史。

它还支持由 Markdown 定义 Scheduled Task。到期后，常驻的 `taskd` 直接调用本机 code-agent CLI，并把 session ID、结果、文件变更和日志引用写入统一 Run ledger；对话正文仍由本机 agent CLI 持有。

当前状态：

- macOS service 与 Dashboard 可用；
- Recorder adapter 支持 Codex 和 Claude Code；
- Scheduled Task runtime 当前支持 Codex；
- runtime registry 已按 multi-CLI contract 设计，后续 runtime 只增加 adapter，不增加第二套调度链路；
- 所有数据都保存在本机，不需要 cloud account 或 auth token。

## Quick start

要求 macOS、Node.js 24+、`curl`、`tar` 与 `shasum`。

安装 latest GitHub Release：

```bash
curl -fsSL https://raw.githubusercontent.com/joisun/tasks-recorder/main/install.sh | bash
```

安装完成后打开 <http://127.0.0.1:43127>，或检查服务：

```bash
tasks-recorder status
```

普通安装不需要 clone repository、`npm install` 或 `npm ci`。更谨慎的固定版本安装方式：

```bash
version=v0.6.2
curl -fsSLO "https://raw.githubusercontent.com/joisun/tasks-recorder/${version}/install.sh"
less install.sh
bash install.sh --version "$version"
```

installer 会在解包前验证 Release 中的 `SHA256SUMS`，但不会探测、登录或配置任何 agent CLI。CLI availability 由运行时 registry 统一解析。

## Connect an agent

Service 与 agent adapter 独立安装。只安装你实际使用的 adapter。

### Codex

```bash
codex plugin marketplace add joisun/tasks-recorder
codex plugin add tasks-recorder@tasks-recorder
```

首次安装后在 Codex 中运行 `/hooks`，确认 Tasks Recorder hooks 已 trusted，再新开一个 conversation，使 MCP 与 hooks 全部生效。

### Claude Code

```bash
claude plugin marketplace add joisun/tasks-recorder
claude plugin install tasks-recorder@tasks-recorder
```

按 Claude Code 的提示 reload plugin；若出现 MCP approval，只批准 plugin cache 内的 `dist/mcp-server.mjs`。

两个 adapter 分别维护 manifest、hooks、MCP config 与 bundle，只共享 localhost HTTP contract：

```text
adapters/
├── codex/tasks-recorder/
└── claude/tasks-recorder/
```

## How it works

Tasks Recorder 只有一个长期运行的 service 和一个写入边界：

```text
Recording
Agent Hooks / MCP ──HTTP──▶ taskd ──▶ tasks.sqlite
                              │
                              └── snapshot + SSE ──▶ Dashboard

Automation
Schedule.md ──watch──▶ taskd Scheduler ──▶ Runtime Registry
                          │                       │
                          │                       └──▶ codex app-server
                          │                                  │
                          └──▶ scheduler.sqlite ◀── events / result / session
                                      │
                                      └── SSE ──▶ Dashboard
```

macOS `launchd` 只负责让 `taskd` 常驻。每个 Schedule 不再创建 LaunchAgent，也没有独立 runner、Unix socket、claim、heartbeat 或 completion spool。

### Recording model

- **事实层**：Observation、Source Session、Execution 与 Work Segment 记录宿主实际发生的 lifecycle，不保存 prompt、reasoning、tool input/output 或 transcript 正文。
- **语义层**：Project、Main Task 与 Subtask 表示用户认可的工作结构。
- **归属层**：Segment Attribution 是事实与 Task 之间可审计、可纠正的连接。

Hook 使用短超时、fail-open 投递。`taskd` 暂不可用时，事件写入 bounded local spool；service 恢复后重放。Dashboard 从 SQLite snapshot 读取状态，并通过 SSE revision/event 接收实时更新。

### Scheduled Run model

手动 `Run now` 与到期触发都进入同一个 `RunService.create()`：

```text
queued → running → succeeded | failed | timed_out | canceled | interrupted
```

流程只有一条：

1. 读取 Markdown definition，并生成 immutable execution snapshot；
2. 先在 `scheduler.sqlite` 创建 durable `queued` Run；
3. taskd 创建一个共享 Runtime Environment，从显式 override、process `PATH`、Homebrew、fnm/nvm/mise 等 user toolchain 与 platform candidates 中解析 executable；
4. runtime status、model discovery 和 Run 都复用该环境；`taskd` 使用 argv array、`shell: false` 和同源 child `PATH` 直接启动 CLI；
5. Codex active Run 使用独立的 `codex app-server --listen stdio://`；runtime adapter 把 protocol notification 转为统一、bounded event；
6. `RunService` 在执行边界同时做 bounded、in-memory Workspace snapshot，与 runtime file-change evidence 合并；这样 nested tool 写文件但 app-server 未发 `fileChange` item 时也不会漏掉产出；
7. Run ledger 保存 terminal state、session ID、final message、Workspace-relative file changes 与 bounded log path；
8. Dashboard 通过 Run-specific SSE 更新；active Turn 可以追加指令或停止；terminal Run 的历史对话由 runtime adapter 使用可信 Run ID 和 session ID 从 CLI-owned session 按需读取；
9. 需要继续工作时，terminal Run 可以从可信 snapshot 召回 session。

一个 runtime 不可用不会让 Recorder 或其他 runtime 下线。登录或 provider 错误由实际 Run 记录为 typed failure，不会阻塞 service 启动与 runtime 列表加载。

### Live Session control

打开一个正在运行的 Codex Run，Run Review 会显示 Live Session：assistant message delta 与安全的 activity 摘要按发生顺序更新。输入追加指令后，Dashboard 只提交 Run ID、`expected_turn_revision` 和最多 16 KiB 的 text；`taskd` 使用私有 `turnId` 调用 `turn/steer`。Stop 同样只提交 Run ID 与 revision，并映射到 `turn/interrupt`。

Live Session 只干预当前 active Turn，不在 Dashboard 内创建第二轮对话。Run 结束后，页面会重新读取 authoritative terminal Run，并通过 Codex `thread/read` 从本机 Codex-owned session 临时取得 user/assistant messages；Tasks Recorder 不复制或持久化这份 transcript。需要继续多轮对话时使用 Terminal Resume。

实时 message、guidance、reasoning 与 tool payload 不写入 SQLite 或普通日志。历史读取只向 loopback browser 返回可展示的 `userMessage` / `agentMessage`，不返回 reasoning、tool arguments/results 或 command output；本机 Codex session 被删除后，页面明确回退到 Run `final_message`。Run ledger 只保留既有 terminal facts；browser 不接触 runtime `turnId`、executable、argv 或 shell command。Run SSE 是 bounded memory replay，缓冲过期时页面明确 reset，并仍可读取 terminal facts。

## Scheduled Tasks

Schedule definition 是 source of truth；SQLite 只记录 Run facts。默认目录为 `~/.config/tasks-recorder/schedules`。

```markdown
---
type: tasks-recorder/schedule
id: 8b4a8b25-3d1e-4e43-8f5f-9cbef95b9275
title: Daily repository review
enabled: true
workspace: /Users/me/projects/example
agent: codex
schedule:
  kind: daily
  at: "09:30"
sandbox: read-only
model: null
reasoning: null
timeout: 2h
---

Review the repository health and summarize actionable risks.
```

支持 `once`、`hourly`、`daily`、`weekly` 与 `monthly` cadence。Dashboard 的 Create/Edit/Pause/Resume 会 atomic rewrite Markdown，并用 SHA-256 `etag` 做 compare-and-set；Delete 把 definition 移到 `.trash/`。行级一次性 Run action 在执行期间会切换为 Stop；它与只控制周期调度的 Schedule pause/resume 是两套独立操作。

filesystem watcher 提供低延迟刷新，周期性 rescan 保证最终收敛。修改 Definitions directory 时，现有 definitions 会在同一个操作中安全迁移并切换 watcher，不需要重启 `taskd`。

Runtime 与 model 由以下 API 动态获取：

```text
GET  /api/v1/runtimes
POST /api/v1/runtimes/refresh
GET  /api/v1/runtimes/:id/models
```

当前 Codex adapter 使用同一个解析结果执行 `codex --version`、`codex debug models` 与真实 Run。model probe 失败时 Editor 显示 adapter-owned fallback，而不是无限 loading 或让 route 消失。

## Data and configuration

```text
~/.local/share/tasks-recorder/
├── current -> releases/<version>
└── releases/<version>/                 # immutable program files

~/.local/bin/tasks-recorder             # management CLI

~/.config/tasks-recorder/
├── config.json
├── tasks.sqlite                        # Recorder facts and task model
├── scheduler.sqlite                    # unified Run ledger
├── spool/                              # bounded Hook event fallback
├── schedules/
│   ├── *.md                            # Schedule source of truth
│   ├── .trash/                         # recoverable delete/migration backup
│   └── logs/                           # bounded per-Run stdout/stderr
└── logs/tasks-recorder.ndjson           # privacy-bounded service log

~/Library/Logs/tasks-recorder/
├── taskd.stdout.log
└── taskd.stderr.log
```

Recorder canonical database 是 `~/.config/tasks-recorder/tasks.sqlite`；Scheduled Run ledger 是 `~/.config/tasks-recorder/scheduler.sqlite`。

默认配置：

```json
{
  "output_dir": ".",
  "resume_terminal": "terminal",
  "schedule_definitions_dir": "schedules",
  "server_host": "127.0.0.1",
  "server_port": 43127
}
```

`codex_path` 是可选的用户 override，不是 capability flag。未配置时 registry 从 `CODEX_BIN`、process `PATH`、Homebrew、fnm/nvm/mise 等常见 user toolchain 和受支持的 platform candidates 中解析 executable；只有通过 executable validation 的候选才消耗 bounded version-probe budget。taskd 的单一 Runtime Environment 同时生成 resolver candidates 与 child `PATH`，避免 GUI/launchd 精简 PATH 下出现“能够探测但无法执行”。一次 unavailable 不会进入长期 cache，下一次读取可直接恢复；installer 不写入 `codex_path`。

Settings 可以选择 Session Resume terminal，以及修改 Definitions directory。当前 terminal adapter 支持 Terminal.app、Otty 与 Ghostty；browser 永远不能提交 shell command。Resume 只提交可信的 Task ID 或 Run ID；Live Session 另可提交 bounded guidance text 与 public Turn revision。

## Migrate a schema v2 database

Recorder `tasks.sqlite` 当前使用 schema v3。升级 schema v2 数据库前，先停止唯一 writer 并预览：

```bash
tasks-recorder stop
tasks-recorder migrate --dry-run
```

确认 report 后，指定一个尚不存在且不同于 source database 的 backup path：

```bash
tasks-recorder migrate --apply \
  --backup "$HOME/.config/tasks-recorder/backups/tasks-v2-before-v3.sqlite"
tasks-recorder start
```

dry-run 不写入数据库；apply 会先 checkpoint WAL、创建权限为 `0600` 的 verified backup，再在一个 transaction 中迁移。任一验证失败都会 rollback。不要让旧 runtime 打开 v3 database，也不要让新 runtime 写入恢复后的 v2 backup。

### Legacy API window

`agent_tasks_*` MCP/API 在整个 `0.6.x` release line 中保留 compatibility wrapper，并返回 migration metadata。新 adapter 使用 `agent_work_*`、`agent_tasks_mutate` 与 `agent_tasks_sync_structure`。legacy wrapper 最早在 `0.7.0` 移除。

## Import historical Codex sessions

先用 dry-run 查看某个 Codex Session 会产生哪些记录：

```bash
tasks-recorder import codex --session <session-id> --dry-run
```

确认后再写入 Recorder database：

```bash
tasks-recorder import codex --session <session-id>
```

导入只保留任务结构与 execution facts，不保存对话正文；相同 Session 重复导入是 idempotent。无法可靠归属到 Task 的 execution 会留在 inbox，等待后续分配。

## Operations

```bash
tasks-recorder status
tasks-recorder stop
tasks-recorder start
tasks-recorder scheduler status
```

更新 latest Release：

```bash
curl -fsSL https://raw.githubusercontent.com/joisun/tasks-recorder/main/install.sh | bash
```

只卸载 LaunchAgent、保留程序和数据：

```bash
tasks-recorder uninstall
```

完整卸载程序但保留 `~/.config/tasks-recorder` 数据：

```bash
curl -fsSL https://raw.githubusercontent.com/joisun/tasks-recorder/main/install.sh | bash -s -- --uninstall
```

## Troubleshooting

```bash
curl -fsS http://127.0.0.1:43127/health/ready
curl -fsS http://127.0.0.1:43127/api/v1/status
curl -fsS http://127.0.0.1:43127/api/v1/runtimes
tail -n 100 ~/Library/Logs/tasks-recorder/taskd.stderr.log
tail -n 100 ~/.config/tasks-recorder/logs/tasks-recorder.ndjson
```

- `SERVICE_UNAVAILABLE`：先检查 `tasks-recorder status` 与 `/health/ready`。
- Dashboard 打不开：检查 `server_port` 是否被占用以及 `taskd.stderr.log`。
- Runtime 为 `unavailable`：运行对应 CLI 的 `--version` 后重新打开 editor 或调用 `POST /api/v1/runtimes/refresh`；失败结果不会被长期缓存。registry 会自动补充 Homebrew、fnm/nvm/mise 等 GUI-missing toolchain directories，也可显式配置 `CODEX_BIN` / `codex_path`。
- Model 使用 fallback：手动运行解析到的 `codex debug models`；fallback 不会阻止保存或 Run。
- Run 失败：在 Run Review 查看 stable error code、bounded stderr 与 final result。
- 历史对话不可用：确认对应 `thread_id` 仍存在于本机 Codex session inventory；Tasks Recorder 不保存第二份 transcript，因此 session 被 Codex 清理后只显示 Run `final_message`。
- Schedule definition 不可用：按页面给出的 source path 修复 YAML、duplicate UUID、unknown field、cadence 或 symlink 问题；watcher 会自动重试。
- Dashboard 正常但没有自动记录：确认 adapter 已启用，重新打开 agent conversation，并完成 hooks trust / MCP approval。
- Resume 不可用：Run 必须有本机 session transcript 与有效 Workspace，并且对应 terminal / CLI 仍可用。

## Develop from source

```bash
git clone https://github.com/joisun/tasks-recorder.git
cd tasks-recorder
npm ci
```

让已安装的 `taskd` 保持运行，再启动 source Dashboard：

```bash
npm run dev:ui:react
```

打开 <http://127.0.0.1:43128>。`ui/src` 变化会自动 rebuild/refresh，API 与真实本机数据仍来自 `43127`；不需要发布或重新安装。该页面的 mutation 会修改真实数据。

发布前验证：

```bash
npm run build
npm run build:adapters
npm run check
npm test
```

本地安装 source service：

```bash
npm run taskd -- install
npm run taskd -- status
```

构建 release artifacts：

```bash
npm run package:release
```

## Security and privacy

- `taskd` 只监听 `127.0.0.1`，并验证 `Host` 与 browser `Origin`；不要反向代理到 LAN 或公网。
- 威胁模型信任同一 OS user 下的本机 process，因此不使用 auth token。
- Runtime invocation 使用明确 executable、argv array、可信 Workspace 和 `shell: false`。
- SQLite 与 Tasks Recorder logs 不保存 prompt、reasoning、assistant message、tool output、token 或 transcript 正文；历史对话只从 CLI-owned session 按需读取并在页面内存中展示。
- Hooks fail open；Recorder 故障不会阻断 agent 工作，但可能少记一次 activity。
- Installer 在执行 runtime 前验证 artifact checksum，并拒绝 archive path traversal。
- Resume endpoint 不接受 browser 提交的 Session ID、Workspace 或任意 command。

## License

Tasks Recorder 采用 [GPL-2.0-only](LICENSE)。Dashboard bundle 使用 React、React DOM 与 SVAR React Gantt，第三方许可见 [ui/THIRD_PARTY_NOTICES.md](ui/THIRD_PARTY_NOTICES.md)；service bundle 见 [server/THIRD_PARTY_NOTICES.md](server/THIRD_PARTY_NOTICES.md)。
