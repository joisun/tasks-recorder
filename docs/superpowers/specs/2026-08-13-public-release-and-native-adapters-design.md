# Tasks Recorder 公开发布与原生 Adapter 设计

日期：2026-08-13

## 目标

把 Tasks Recorder 作为独立的 macOS local service 发布，并为 Codex 与 Claude Code 分别提供符合各自原生规范的 plugin adapter。用户可以通过 `install.sh` 安装或升级 service，再按所用 harness 单独安装 adapter。

本轮同时交付：

- 公开 GitHub repository：`joisun/tasks-recorder`
- 基于 GitHub Release 的可校验安装器
- CI 与 tag release GitHub Actions
- Codex 与 Claude Code 的独立 plugin adapter
- 面向公开用户的 README，包含完整的 **How it works**
- GPL-2.0-only 项目许可

## First Principles

### Goal

用户不需要 clone repository 或理解源码目录，就能安装一个持续运行、可实时查看的 tasks service，并在 Codex 或 Claude Code 中自动记录任务。

### Facts

- `taskd` 是唯一 SQLite writer，并通过 localhost HTTP API 与 SSE 提供数据和实时更新。
- 用户数据位于 `~/.config/tasks-recorder`，不能随程序升级被覆盖。
- 当前 service 只支持 macOS `launchd`。
- Codex 与 Claude Code 都支持 plugin、hooks、skills 和 MCP，但 manifest、marketplace 与 MCP 配置格式存在差异。
- DHTMLX Gantt Standard 9.1.0 以 GPL-2.0 分发，并被直接 bundle 到 Dashboard。
- Superpowers 针对不同 harness 分别维护安装入口与 metadata，只共享真正通用的内容。

### Assumptions

- 首个公开版本只承诺 macOS 与 Node.js 24+。
- GitHub Release 是程序文件的唯一安装来源，repository `main` 不作为稳定安装源。
- Codex/Claude adapter 与 service 使用相同 project version，但不要求共享源码目录。

### Constraints

- 不直接修改用户的 `~/.codex/config.toml` 或 Claude settings；adapter 通过各自官方 plugin marketplace 安装。
- `install.sh` 只管理 service，不隐式安装任何 AI harness plugin。
- adapter 不持有数据库，不写入 plugin cache，不依赖 source checkout。
- service 只监听 `127.0.0.1`；所有状态继续持久化到 `~/.config/tasks-recorder`。

### Success Criteria

- 一条 `curl ... | bash` 命令能从 Release 安装或升级 service，并保持现有数据库。
- 安装后的 `taskd` 能由 `launchd` 自动启动，Dashboard 可访问且实时更新。
- Codex 与 Claude Code 能分别从 repository marketplace 安装 adapter。
- 两个 adapter 都能调用 tasks MCP tools，并通过 hooks 写入 heartbeat/status。
- PR/push 会执行 build、syntax check、tests 与 packaging smoke test；`v*` tag 会发布带 SHA-256 checksum 的 artifacts。

## 架构

```text
Codex adapter ── hooks / stdio MCP ──┐
                                     ├── localhost HTTP API ── taskd ── SQLite
Claude adapter ─ hooks / stdio MCP ──┘                         └── Dashboard + SSE
```

### 1. Service

Service 是产品核心，负责：

- SQLite schema、transaction 与 task state
- localhost REST API
- Dashboard 静态页面
- SSE 实时更新
- `launchd` 生命周期

版本化程序安装到：

```text
~/.local/share/tasks-recorder/releases/<version>/
~/.local/share/tasks-recorder/current -> releases/<version>
```

用户状态保持在：

```text
~/.config/tasks-recorder/config.json
~/.config/tasks-recorder/tasks.sqlite
```

日志保持在：

```text
~/Library/Logs/tasks-recorder/
```

### 2. Codex adapter

`adapters/codex/tasks-recorder/` 是完整、独立的 Codex plugin root，包含：

- `.codex-plugin/plugin.json`
- Codex 原生 `.mcp.json`
- Codex 原生 `hooks/hooks.json`
- adapter 自己的 hook client 与预构建单文件 MCP client
- `skills/task-manager/SKILL.md`

Repository 根目录的 `.agents/plugins/marketplace.json` 将该目录发布为 Codex repo marketplace entry。

### 3. Claude Code adapter

`adapters/claude/tasks-recorder/` 是完整、独立的 Claude Code plugin root，包含：

- `.claude-plugin/plugin.json`
- Claude 原生 `.mcp.json`
- Claude 原生 `hooks/hooks.json`
- adapter 自己的 hook client 与预构建单文件 MCP client
- `skills/task-manager/SKILL.md`

Repository 根目录的 `.claude-plugin/marketplace.json` 将该目录发布为 Claude Code marketplace entry。

### 4. Adapter 边界

两个 adapter 允许少量重复。它们只依赖以下稳定 contract：

- service endpoint：`http://127.0.0.1:<configured-port>`
- config location：`~/.config/tasks-recorder/config.json`
- REST API request/response schema

每个 adapter 将自己的 MCP client bundle 成不需要 `npm install` 的单文件，并从自身 plugin root 启动。hooks 也保留在各自 adapter 内，以便分别适配宿主事件格式。MCP 与 hooks 都只通过 localhost HTTP API 连接 service；adapter 未检测到 service 时返回可操作的安装提示，而不是尝试自行安装依赖。

不引入：

- Codex/Claude 双 manifest 兼容层
- 运行时生成另一套 adapter
- plugin install 时执行 `npm install`
- adapter 对 source repository 或 project `node_modules` 的引用

## 安装与升级

`install.sh`：

1. 检查 macOS、Node.js 24+、`curl`、`tar` 与 checksum 工具。
2. 从 GitHub Release 下载指定版本或 latest runtime artifact 与 checksums。
3. 在临时目录验证 SHA-256 后解压到新的 version directory。
4. 验证 Release 中预构建 Dashboard；service 只使用 Node.js built-ins，不执行 `npm install` 或 `npm ci`。
5. 原子更新 `current` symlink。
6. 首次安装时创建 default config；升级时绝不覆盖现有 config/database。
7. 安装或更新 `launchd` plist，启动 service，并等待 readiness check。
8. 输出 Dashboard URL 与 Codex/Claude adapter 的独立安装命令。

失败时不切换 `current`，现有 service 与数据保持不变。

## GitHub Actions

### CI

在 pull request 与 push 上：

- 使用 Node.js 24 执行 `npm ci`
- build Dashboard
- syntax check
- unit/integration tests
- validate 两套 plugin manifest/marketplace JSON
- build runtime package
- 对 `install.sh` 做 shell syntax 与 local artifact smoke test

### Release

在 `v*` tag 上：

- 重复完整验证
- 确认 tag version 与 `package.json`/plugin manifests 一致
- 生成 macOS runtime tarball
- 生成 Codex 与 Claude adapter archives
- 生成 `SHA256SUMS`
- 使用 GitHub CLI 创建 GitHub Release 并上传 artifacts

## README 信息架构

README 面向第一次访问 repository 的用户，依次说明：

1. 项目解决什么问题
2. 一分钟安装 service
3. Codex adapter 安装
4. Claude Code adapter 安装
5. 打开 Dashboard 与常用管理命令
6. **How it works**：hooks → adapter → taskd → SQLite → SSE Dashboard
7. 文件位置、升级、卸载与数据保留规则
8. 从源码开发与测试
9. 安全模型与 GPL-2.0-only 许可

## 许可

本版本整体采用 GPL-2.0-only，以匹配被直接 bundle 的 DHTMLX Gantt Standard 9.1.0。后续在独立 branch 替换为宽松许可 Timeline/Gantt component，并与本版进行视觉和交互对比；该工作不阻塞本轮公开发布链路。

## Johari Review

### Open Area

- service / adapter 边界、用户数据位置、macOS-only 范围和 GitHub Release 安装源已明确。
- 用户已确认参考 Superpowers，按 harness 分别维护 adapter。
- 用户已确认当前项目使用 GPL-2.0。

### Hidden Area

- 用户是否最终要提交 Codex/Claude 官方 marketplace 尚未决定；本轮只提供可安装的 repo marketplace，不假定官方审核通过。
- GitHub Release 是否立即发布取决于首个 commit 与 tag；当前 repository 尚无 commit，因此本轮只创建并配置公开 remote，不代替用户 commit/tag。

### Blind Spot

- `curl | bash` 有 supply-chain 风险，因此 README 同时提供下载、检查、再执行的方式；Release artifact 必须校验 SHA-256。
- plugin hooks 在 Codex 中需要用户显式 trust；README 必须说明，否则安装成功也可能没有自动记录。
- adapter 与 service version 可能短暂不一致；API error 需清楚报告，不能静默丢数据。

### Unknown Area

- Codex 与 Claude Code 的 plugin behavior 会随版本演进。CI 能验证静态格式，本地 smoke test 需要用当前已安装 CLI 验证 marketplace/plugin discovery。
- GPL 是否覆盖所有未来分发方式是法律问题；当前工程措施只能确保源码、license 与 notices 一并发布。
