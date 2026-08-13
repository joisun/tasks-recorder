# Tasks Recorder Standalone Migration Design

> 日期：2026-08-12（Asia/Shanghai）  
> 状态：用户已确认  
> 上游设计：`2026-08-12-tasks-recorder-local-cs-design.md`

## 目标

把 `tasks-recorder` 从 dotfiles 内的 Codex plugin 源目录迁移为独立本地应用：

- 源码根目录：`/Users/joi-com/Desktop/space/projects/tasks-recorder`
- 用户状态根目录：`~/.config/tasks-recorder`
- SQLite：`~/.config/tasks-recorder/tasks.sqlite`
- 配置：`~/.config/tasks-recorder/config.json`
- Bearer token：`~/.config/tasks-recorder/auth-token`
- Dashboard：`http://127.0.0.1:43127`

`taskd` 继续作为唯一 SQLite owner；浏览器继续使用 REST + SSE。此次迁移不改变任务模型、HTTP contract、Dashboard 行为或 MCP tool contract。

## 边界

独立项目保留 `mcp/`、`hooks/` 和 `skills/` 源码，作为未注册的 Agent integration code；删除 `.codex-plugin/` 与 `.mcp.json`，并从本机 Codex 配置、cache 和本地 marketplace 中移除现有 plugin。后续 installer 可以重新安装 thin integration，但不属于本次迁移。

`~/Library/Logs/tasks-recorder` 继续保存运行日志。日志不是 canonical state；数据库、token 和用户配置统一进入 `~/.config/tasks-recorder`。

## 配置解析

配置解析函数改为 standalone 语义：

```js
resolveAppConfig({ projectRoot, env, homeDirectory })
```

默认从 `<homeDirectory>/.config/tasks-recorder/config.json` 读取用户配置。`AGENT_TASKS_DATABASE_PATH` 与 `AGENT_TASKS_TOKEN_PATH` 仍可覆盖默认路径；相对 override 以用户状态根目录为基准。默认 database/token 都位于该状态根目录。

`output_dir` 继续保留，用于 legacy Markdown projection；相对路径同样以用户状态根目录为基准。Server host 仍只允许 `127.0.0.1`，默认端口仍为 `43127`。

## 数据迁移与回滚

由于 SQLite 使用 WAL，不能只复制主文件。切换流程：

1. 复制源码工作树到新项目，但排除 `node_modules`、SQLite sidecar 和 Finder 临时文件。
2. 在新项目通过测试和 build 后停止旧 LaunchAgent，并终止仍指向旧路径的 MCP processes。
3. 使用 SQLite `.backup` 生成新目录中的一致性数据库，再执行 `quick_check`、foreign key check、task/session counts。
4. 复制现有 config 与 token；token 保持 mode `0600`，状态目录 mode `0700`。
5. 从新项目重新安装 LaunchAgent；确认 plist、health 和进程 cwd 都指向新路径，snapshot 记录数一致。
6. 移除 Codex plugin 配置、cache、marketplace entry 与旧源码目录。

在第 6 步之前，旧源码和原数据库仍是回滚副本。第 6 步只在新服务验证后执行。

## 成功标准

- `npm run build && npm test && npm run check` 在新项目通过。
- 新库 `PRAGMA quick_check` 为 `ok`，foreign key violations 为 0，task/session counts 与迁移前一致。
- LaunchAgent 的 `ProgramArguments` 与 `WorkingDirectory` 指向新项目。
- `/health/ready` 成功，Dashboard snapshot 可读取。
- `~/.config/tasks-recorder` 权限正确且包含 config、database、token。
- 默认与 API Codex home 均不再安装/启用 `tasks-recorder@joi-local-plugins`。
- dotfiles marketplace、Codex config 和 README 不再把 tasks-recorder 描述为本地 plugin。
- `/Users/joi-com/.dotfiles/dot.configs/ai/.agents/plugins/tasks-recorder` 不再存在，其他 plugin/dotfiles 内容保持不变。

## Johari 自审

- **Open Area**：目标代码目录、状态目录、数据库迁移和移除旧 plugin 已由用户明确指定。
- **Hidden Area**：没有要求保留独立 Git history，因此本次不初始化、不提交新 Git repository；只保留完整工作树内容。
- **Blind Spot**：WAL、残留 MCP process、LaunchAgent 绝对路径和 Codex plugin cache 都可能维持旧写入，已纳入切换检查。
- **Unknown Area**：切换时数据库是否仍有活跃写入，只能通过停止旧进程后执行一致性 backup 和前后计数验证确认。
