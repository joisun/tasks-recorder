# Tasks Recorder Standalone Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move Tasks Recorder out of the Codex plugin tree, relocate all canonical user state to `~/.config/tasks-recorder`, and cut over the live macOS service without losing SQLite WAL data.

**Architecture:** The source tree lives at `/Users/joi-com/Desktop/space/projects/tasks-recorder`; runtime config, token, and SQLite live at `~/.config/tasks-recorder`. `taskd` remains the single database owner, while MCP/Hook stay HTTP clients and are retained only as inactive integration source after the current plugin installation is removed.

**Tech Stack:** Node.js 24+ ESM, `node:sqlite`, Node test runner, macOS `launchd`, REST + SSE, Codex CLI plugin management.

## Global Constraints

- Preserve every tracked and untracked source change currently under `.agents/plugins/tasks-recorder`.
- Do not copy `node_modules`, `tasks.sqlite*`, `.DS_Store`, tokens, logs, or other machine state into source control.
- Do not stop the old service until the new working tree passes focused tests and build.
- Migrate SQLite with a consistent backup after stopping every old writer; never copy only the WAL-mode main file.
- Delete only the `tasks-recorder` plugin entry/directory/cache; preserve all unrelated dotfiles and plugins.
- Do not create a Git commit, branch, push, or remote.

---

### Task 1: Create the standalone working tree and RED configuration tests

**Files:**
- Copy into project: all source files except runtime state and dependencies
- Modify: `test/config.test.mjs`
- Modify: `test/control.test.mjs`

**Interfaces:**
- Produces desired API `resolveAppConfig({ projectRoot, env, homeDirectory })`.
- Produces defaults `<home>/.config/tasks-recorder/{config.json,tasks.sqlite,auth-token}`.

- [ ] Copy the source tree with `rsync -a`, excluding `node_modules/`, `tasks.sqlite*`, `.DS_Store`, and the two new migration docs already present at the target.
- [ ] Install development dependencies with `npm ci` in the new project.
- [ ] Change configuration tests to create `<temp-home>/.config/tasks-recorder/config.json` and assert the database/token defaults use that directory.
- [ ] Change controller tests from `pluginRoot` to `projectRoot` and assert the generated plist points to the standalone project.
- [ ] Run `node --test test/config.test.mjs test/control.test.mjs` and confirm failure because `resolveAppConfig` and standalone defaults do not exist.

### Task 2: Implement standalone paths and remove active plugin metadata

**Files:**
- Modify: `mcp/src/config.mjs`
- Modify: `mcp/server.mjs`
- Modify: `server/taskd.mjs`
- Modify: `server/control.mjs`
- Modify: `test/plugin-metadata.test.mjs`
- Modify: `.gitignore`
- Modify: `README.md`
- Delete: `.codex-plugin/plugin.json`
- Delete: `.mcp.json`

**Interfaces:**
- Produces `resolveAppConfig({ projectRoot, env, homeDirectory })` returning `projectRoot`, `dataDirectory`, `configPath`, `databasePath`, `tokenPath`, `outputDir`, and Server values.
- Keeps existing `AGENT_TASKS_*` override names and HTTP contract.

- [ ] Implement `resolveAppConfig`; resolve config, default database and default token from `~/.config/tasks-recorder`.
- [ ] Update MCP, taskd, and controller callers to use `projectRoot` and `resolveAppConfig`.
- [ ] Replace the plugin metadata test with a standalone project metadata/readme assertion.
- [ ] Delete active plugin manifests while retaining inactive integration source directories.
- [ ] Update README setup, lifecycle, data layout, migration and Codex integration status.
- [ ] Run focused config/controller/metadata tests and confirm GREEN.
- [ ] Run `npm run build && npm test && npm run check` before live cutover.

### Task 3: Stop old writers and migrate user state consistently

**Files:**
- Create runtime state: `~/.config/tasks-recorder/config.json`
- Create runtime state: `~/.config/tasks-recorder/tasks.sqlite`
- Create runtime state: `~/.config/tasks-recorder/auth-token`

**Interfaces:**
- Consumes the old WAL-mode database and token.
- Produces one checked SQLite database and `0600` token in the new state root.

- [ ] Record pre-cutover task/session/status counts and old source/process identifiers.
- [ ] `launchctl bootout` the old LaunchAgent and terminate only MCP processes whose command references the old plugin/local-MCP tasks-recorder paths.
- [ ] Create `~/.config/tasks-recorder` with mode `0700`.
- [ ] Use SQLite `.backup` from the old database to a temporary file in the new state directory, then atomically rename it to `tasks.sqlite`.
- [ ] Copy the current config and token to temporary files, set safe modes, and atomically rename them.
- [ ] Verify `quick_check`, foreign keys, schema, task/session/status counts, file ownership and modes.

### Task 4: Remove Codex plugin registration and update dotfiles docs

**Files:**
- Modify: `/Users/joi-com/.dotfiles/dot.configs/ai/.agents/plugins/marketplace.json`
- Modify: `/Users/joi-com/.dotfiles/dot.configs/ai/codex/config.toml`
- Modify: `/Users/joi-com/.dotfiles/dot.configs/ai/codex/api/config.toml`
- Modify: `/Users/joi-com/.dotfiles/dot.configs/ai/codex/README.md`
- Remove through CLI: installed tasks-recorder plugin cache for default and API Codex homes

**Interfaces:**
- Removes `tasks-recorder@joi-local-plugins` from both Codex homes without affecting `superpowers` or unrelated configuration.

- [ ] Run `codex plugin remove tasks-recorder --marketplace joi-local-plugins` for default and API Codex homes, using the CLI syntax shown by local help.
- [ ] Remove the tasks-recorder marketplace entry; keep the marketplace JSON structurally valid.
- [ ] Remove stale trusted hook states and plugin tables from both TOML files.
- [ ] Rewrite the dotfiles README section as an external standalone project pointer with the new source/state paths.
- [ ] Verify `codex plugin list --json` contains no installed tasks-recorder in either home.

### Task 5: Install the standalone service and complete cutover

**Files:**
- Replace: `~/Library/LaunchAgents/com.joi.tasks-recorder.taskd.plist`
- Remove: `/Users/joi-com/.dotfiles/dot.configs/ai/.agents/plugins/tasks-recorder`

**Interfaces:**
- Produces a running `taskd` sourced from the new project and state root.

- [ ] Run `npm run taskd -- install` in the standalone project.
- [ ] Confirm launchd plist, process args, cwd, health, snapshot and listening address use the new project and `127.0.0.1`.
- [ ] Execute one authenticated API check and verify the database path remains `~/.config/tasks-recorder/tasks.sqlite`.
- [ ] Run full build/test/check again against the final files.
- [ ] Remove the old plugin source directory only after all prior checks pass.
- [ ] Scan both the standalone project docs and dotfiles docs for old source/database paths and plugin installation instructions; update active docs.
- [ ] Run `git diff --check`, scoped status/diffs, filesystem path checks, SQLite integrity/count checks, and Codex plugin list checks.

## Plan Self-Review

- **Spec coverage:** source migration, canonical data root, WAL-safe database migration, plugin removal, LaunchAgent cutover, tests and documentation all have explicit tasks.
- **Placeholder scan:** no TBD/TODO or deferred implementation remains.
- **Type consistency:** `projectRoot`, `dataDirectory`, `configPath`, `databasePath`, and `tokenPath` are consistent across tasks.
- **Risk check:** destructive deletion occurs only after a working copy, data backup and live service verification exist.

## Execution Record · 2026-08-12

- Tasks 1–5 已执行完成；未创建 Git branch、commit、push 或 remote。
- 新源码根目录为 `/Users/joi-com/Desktop/space/projects/tasks-recorder`；新状态根目录为 `~/.config/tasks-recorder`。
- 配置 contract 经过 RED→GREEN：默认 config/database/token 均从用户状态根目录解析，MCP、Hook、taskd 与 launchd controller 已切换到 standalone `projectRoot` 语义。
- 迁移前停止了旧 LaunchAgent 和所有明确引用旧 tasks-recorder 路径的 MCP processes；SQLite 使用 `.backup` 生成一致性新库，没有直接复制 WAL-mode 主文件。
- 迁移前后均为 27 tasks、28 sessions，状态分布为 active 1、done 23、waiting 3；新库 `quick_check=ok` 且无 foreign key violations。
- `~/.config/tasks-recorder` 为 `0700`；`config.json`、`tasks.sqlite`、`auth-token` 为 `0600`。
- 默认与 API Codex home 中的 `tasks-recorder@joi-local-plugins` 已通过 CLI 移除；local marketplace、trusted hook state、plugin tables 与 active docs 已清理。
- LaunchAgent `com.joi.tasks-recorder.taskd` 的 executable、taskd path 与 working directory 均指向新项目；只监听 `127.0.0.1:43127`，`/health/ready` 与 snapshot 成功。
- 首次紧跟 bootstrap 的 status 曾命中 startup race；使用 direct localhost 重试后稳定 ready，未修改业务代码。shell 环境存在 localhost proxy，验收命令使用 `curl --noproxy '*'`。
- 旧 plugin 目录与旧 `~/Library/Application Support/tasks-recorder` 已移入 Trash，可从 `tasks-recorder-plugin-backup-20260812` 与 `tasks-recorder-app-support-backup-20260812` 恢复；原 `.agents/plugins` 路径已移除。
