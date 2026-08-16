# Tasks Recorder Task Tree and Execution Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended for explicitly delegated work) or `superpowers:executing-plans` to execute this plan task by task. This plan defaults to single-agent inline execution unless the user explicitly authorizes delegation.

**Goal:** 将 Tasks Recorder 升级为以一层 Task tree 为业务主模型、以 session/turn/subagent execution 为独立执行记录的本机控制面，并提供实时 Codex hooks、可编辑 Dashboard 和幂等历史 importer。

**Architecture:** SQLite 继续由 `taskd` 独占写入。`mcp/src/task-store.mjs` 保留兼容 façade，schema migration 与 execution repository 拆成独立模块；HTTP/MCP 只暴露 host-neutral contract。Codex adapter 自己解析 Codex hook/transcript metadata，历史 importer 在 CLI 侧读取 transcript，再把规范化 records 交给 `taskd` 单事务预览或写入。Dashboard 的 SSE snapshot 只传 Task 汇总与未绑定计数，Task events/executions 由 details sheet 按需查询。

**Tech Stack:** Node.js 24、ES modules、`node:sqlite`、Node test runner、MCP SDK、DHTMLX Gantt 9.1、vanilla DOM/CSS、Server-Sent Events、macOS `launchd`。

## Global Constraints

- 设计依据：`docs/superpowers/specs/2026-08-14-task-tree-lifecycle-design.md`。
- Task tree 首期只允许 `root -> child` 一层；execution 永远不是 Task node。
- SQLite 是 canonical store，运行期只有 `taskd` 可以写数据库；hook、MCP adapter、Dashboard 和 importer CLI 都必须经 HTTP API。
- 不保存 prompt、assistant message、tool response 正文或 token；`update_plan` 只保存结构化 plan observation。
- Codex 与 Claude adapter 继续分别维护；本轮只为 Codex 增加 native lifecycle hooks，不把 Codex transcript parser 放进 core 或 Claude adapter。
- 旧 `agent_tasks_*` tools、`task_sessions` 数据和 v0.3.x 调用继续可用。
- 所有 delete 都是 soft delete；不增加自动永久清理。
- 所有 mutation 都必须在成功 commit 后只发布一次 SSE；幂等 replay/no-op 不发布。
- 不修改真实的 `~/.config/tasks-recorder/tasks.sqlite`，直到临时数据库验证通过并取得真实数据迁移/导入授权。
- 不自动 `git commit`、tag、push 或 release。每个 phase 结束只展示证据；如用户希望 phase commit，再单独确认并按 Conventional Commits 提交本 phase 文件。
- 修改旧文件时只做局部格式化，尤其避免重排 `ui/src/dashboard.css`。

## Definition of Done

- schema v1 数据可无损迁移到 v2，`PRAGMA integrity_check` 与 `foreign_key_check` 通过。
- 同一 turn 的 `A -> B -> A` 产生三个 execution 区间；重复 hook/import 不重复记录。
- root/child 的 rename、description、status、move、reorder、cancel、archive、delete/restore 都有 event 与 revision 保护。
- root 显示 `未完成 remaining / total` progress ring；所有 child done 后仍需显式完成 root。
- Codex 七类 hooks 能 fail-open 地驱动 lifecycle；无法证明 Task 归属的 execution 进入未绑定 inbox。
- `tasks-recorder import codex --session ... --dry-run` 可预览，apply 幂等。
- Dashboard 可查看/编辑 Task，查看 activity/executions，复制 Session ID，并分配/标记 `non_work` execution。
- focused tests、全量 tests、syntax check、build、release packaging 和 headless browser 验证全部通过。

---

## Phase 1 — Task tree correctness

### Task 1: Schema v2 and non-destructive migration

**Files:**

- Create: `mcp/src/task-schema.mjs`
- Create: `test/schema-migration.test.mjs`
- Modify: `mcp/src/task-store.mjs`
- Modify: `scripts/package-release.mjs`
- Modify: `package.json`

- [x] **Step 1: Write failing schema and migration tests**

  在 `test/schema-migration.test.mjs` 建立真实临时 SQLite fixture，覆盖：

  - 空数据库初始化为 `PRAGMA user_version = 2`。
  - `tasks` 新增 `description`、`agent_key`、`sort_order`、`revision`、`archived_at`、`deleted_at`，status 接受 `canceled`。
  - 新建 `task_executions`、`task_events`、`plan_observations` 及查询所需 indexes。
  - schema-v1 fixture 带已有 Task 和 `task_sessions.agent`/无 `agent` 两种情况，迁移后 row、session 和时间戳原样保留。
  - v2 reopen 幂等；高于 v2 的版本返回 `SCHEMA_VERSION_UNSUPPORTED`。
  - 迁移后 `PRAGMA integrity_check = ok` 且 `foreign_key_check` 为空。

- [x] **Step 2: Run the focused test and verify RED**

  Run: `node --test test/schema-migration.test.mjs`

  Expected: FAIL，因为当前 schema version 是 1，且新表/字段不存在。

- [x] **Step 3: Extract schema ownership and implement v1 -> v2 migration**

  在 `mcp/src/task-schema.mjs` 导出：

  ```js
  export const SCHEMA_VERSION = 2
  export function initializeTaskSchema(db) {}
  ```

  要求：

  - 新库直接创建 v2。
  - v1 rebuild `tasks` 以更新 status CHECK，同时复制旧 row；迁移在单事务内完成。
  - 保留 `task_sessions` 作为 compatibility projection，不从它猜造 execution 时间段。
  - `task_executions.classification` 使用 `unknown | work | non_work`；新 turn 默认 `unknown`。
  - migration failure 必须 rollback，不能留下半迁移 schema。

  更新 `task-store.mjs` 改为调用 `initializeTaskSchema(db)`，删除旧的内嵌 schema 初始化。

- [x] **Step 4: Include the new runtime module in checks and packages**

  - 把 `mcp/src/task-schema.mjs` 加入 `package.json#scripts.check`。
  - 把它加入 `scripts/package-release.mjs` runtime copy list。

- [x] **Step 5: Verify GREEN and compatibility**

  Run: `node --test test/schema-migration.test.mjs test/task-store.test.mjs`

  Expected: PASS，旧 store tests 无回归。

### Task 2: Task mutations, revision semantics, events, and progress

**Files:**

- Create: `mcp/src/task-tree.mjs`
- Create: `test/task-tree.test.mjs`
- Modify: `mcp/src/task-store.mjs`
- Modify: `test/task-store.test.mjs`
- Modify: `mcp/src/task-service.mjs`
- Modify: `scripts/package-release.mjs`
- Modify: `package.json`

- [x] **Step 1: Write failing domain tests**

  覆盖以下可观察行为：

  - `TASK_STATUSES` 包含 `canceled`。
  - child 不能再有 child，parent/child 必须同 project，禁止 self/cycle。
  - progress 只统计 `deleted_at IS NULL AND status != canceled` 的 child；archived child 仍计入。
  - root 有未完成 child 时不能 done；所有 child done 后仍不会自动 done。
  - done child reopen 会原子 reopen done root。
  - node 真 mutation 增加自身 revision；child mutation 也增加 root tree revision。
  - no-op 不增加 revision、updated_at 或 event。
  - rename/description/status/move/reorder/cancel/archive/delete/restore 记录最小 before/after metadata。
  - soft-deleted Task 默认不出现在 list/snapshot，但可用显式 `deleted=true` 查询。

- [x] **Step 2: Run the focused test and verify RED**

  Run: `node --test test/task-tree.test.mjs test/task-store.test.mjs`

  Expected: FAIL，缺少 v2 mutation 和 progress 行为。

- [x] **Step 3: Add pure Task tree helpers**

  在 `mcp/src/task-tree.mjs` 导出并单测：

  ```js
  export const TASK_STATUSES
  export function taskProgress(root, children) {}
  export function validateTaskHierarchy(task, lookup) {}
  export function taskMetadata(task) {}
  export function taskDiff(before, after) {}
  ```

  `taskDiff` 只返回语义字段变化，避免事件 JSON 包含 session 或 transcript 内容。

- [x] **Step 4: Add store mutation/read interfaces**

  在 `createTaskStore()` façade 新增：

  ```js
  tree(rootId)
  updateTask(input)
  archiveTask(input)
  deleteTask(input)
  restoreTask(input)
  taskEvents({ task_id, root_id, limit, before })
  ```

  `updateTask` 接收 `expected_revision` 和 patch；archive/delete/restore 也比较 revision。所有 root revision、child revision 和 event 写入在一个 transaction 内完成。

- [x] **Step 5: Preserve legacy upsert/complete behavior on v2**

  - `upsert` 支持新可选字段，但旧 input 不受影响。
  - `complete`/`updateStatus` 使用 revision-aware internals，同时继续接受现有 `expected_updated_at` contract。
  - `show` 返回 parent、children、sessions、progress、revision 和 events summary。

- [x] **Step 6: Wire service mutation notifications**

  在 `task-service.mjs` 为 update/archive/delete/restore 统一使用一个 `mutateTask` wrapper；只有 store 返回 `changed: true` 时调用一次 `onChange`。

- [x] **Step 7: Verify GREEN**

  Run: `node --test test/task-tree.test.mjs test/task-store.test.mjs test/task-service.test.mjs`

  Expected: PASS。

### Task 3: Execution lifecycle repository and plan observations

**Files:**

- Create: `mcp/src/task-execution-store.mjs`
- Create: `test/task-execution-store.test.mjs`
- Modify: `mcp/src/task-store.mjs`
- Modify: `scripts/package-release.mjs`
- Modify: `package.json`

- [x] **Step 1: Write failing execution lifecycle tests**

  覆盖：

  - `sessionStart`/`turnStart` replay 以 `external_key` 幂等。
  - main execution 初始 `task_id = null`、`classification = unknown`。
  - `focusExecution` 的 `A -> B -> A` 结束前一 segment，并产生三段不重叠 execution。
  - `subagentStart`/`subagentStop` 维护 kind、root/child session、agent metadata、parent execution 和 interrupted/completed 状态。
  - `sessionEnd` 关闭该 root session 尚未结束的 execution。
  - heartbeat 只更新对应 active execution；重复/过期 heartbeat 不倒退时间。
  - `update_plan` observation 以 tool use external key 幂等，支持 pending/reconciled。
  - assignment 使用 `expected_task_id` 防并发覆盖；绑定后 classification 变为 `work` 并写 `execution_bound` event。
  - `non_work` 不进入未绑定计数和 Task activity；可从 `non_work` 明确恢复为 `unknown`。

- [x] **Step 2: Run the focused test and verify RED**

  Run: `node --test test/task-execution-store.test.mjs`

  Expected: FAIL，因为 execution repository 尚不存在。

- [x] **Step 3: Implement the repository**

  `createTaskExecutionStore({ db, clock, transact })` 提供：

  ```js
  sessionStart(input)
  turnStart(input)
  toolUse(input)
  subagentStart(input)
  subagentStop(input)
  sessionEnd(input)
  focusExecution(input)
  listExecutions(filters)
  assignExecution(input)
  classifyExecution(input)
  sessionContext(sessionId)
  importExecutions(input)
  ```

  所有 public write 返回 `{ changed, execution, ... }`；内部提供可由 `syncTree` 同事务调用的 non-nesting helpers。

- [x] **Step 4: Compose it behind the existing store façade**

  `task-store.mjs` 继续作为唯一 `createTaskStore()` 入口，负责 DB lifecycle，并将 execution methods 透出。`snapshot()` 只增加 Dashboard 所需聚合，不默认复制全部 event/execution row。

- [x] **Step 5: Verify GREEN**

  Run: `node --test test/task-execution-store.test.mjs test/task-store.test.mjs`

  Expected: PASS。

### Task 4: Atomic `sync_tree` and stable Task identity

**Files:**

- Create: `test/task-tree-sync.test.mjs`
- Modify: `mcp/src/task-store.mjs`
- Modify: `mcp/src/task-tree.mjs`
- Modify: `mcp/src/task-service.mjs`

- [x] **Step 1: Write failing `syncTree` transaction tests**

  覆盖设计 contract：

  - 创建 root + ordered children，缺省 child ID 生成稳定、合法、无冲突 ID 并返回。
  - 后续 rename/description/status 更新复用 ID。
  - snapshot 缺失 existing child 不取消、不删除。
  - explicit `canceled` 才从 progress denominator 移除。
  - `expected_revision` 冲突时整个 transaction rollback，并返回最新 tree details。
  - `focus_task_id` 只能是本 root/child；成功时绑定当前 main execution。
  - 同一 payload replay 是 no-op，不新增 event/SSE revision。
  - sync 成功 reconcile 当前 turn pending observations。

- [x] **Step 2: Run the focused test and verify RED**

  Run: `node --test test/task-tree-sync.test.mjs`

  Expected: FAIL，缺少 `syncTree`。

- [x] **Step 3: Implement one atomic store operation**

  新增 `store.syncTree(input)`，在一次 `BEGIN IMMEDIATE` 中完成 validation、ID allocation、Task mutations/events、root tree revision、focus binding 和 observation reconcile。不得通过 title similarity 复用 existing child。

- [x] **Step 4: Expose it through service without duplicate notifications**

  `service.syncTree(input)` 先 enrichment Git context，再调用 store；只有结果 `changed` 或 execution binding changed 时发布一次 `tasks.changed`。

- [x] **Step 5: Verify GREEN and rollback guarantees**

  Run: `node --test test/task-tree-sync.test.mjs test/task-tree.test.mjs test/task-service.test.mjs`

  Expected: PASS。

### Task 5: HTTP, generic clients, and MCP contracts

**Files:**

- Modify: `server/src/api-server.mjs`
- Modify: `mcp/src/task-client.mjs`
- Modify: `mcp/src/tools.mjs`
- Modify: `mcp/server.mjs`
- Modify: `adapters/codex/tasks-recorder/mcp/server.mjs`
- Modify: `adapters/claude/tasks-recorder/mcp/server.mjs`
- Modify: `test/api-server.test.mjs`
- Modify: `test/task-client.test.mjs`
- Modify: `test/server-integration.test.mjs`
- Modify: `test/plugin-adapters.test.mjs`

- [x] **Step 1: Write failing route/client/MCP tests**

  覆盖以下 endpoints：

  ```text
  POST  /api/v1/tasks/sync-tree
  PATCH /api/v1/tasks/:id
  POST  /api/v1/tasks/:id/archive
  POST  /api/v1/tasks/:id/delete
  POST  /api/v1/tasks/:id/restore
  GET   /api/v1/tasks/:id/events
  GET   /api/v1/executions
  PATCH /api/v1/executions/:id/task
  PATCH /api/v1/executions/:id/classification
  GET   /api/v1/sessions/:id/context
  POST  /api/v1/lifecycle/session-start
  POST  /api/v1/lifecycle/turn-start
  POST  /api/v1/lifecycle/tool-use
  POST  /api/v1/lifecycle/subagent-start
  POST  /api/v1/lifecycle/subagent-stop
  POST  /api/v1/lifecycle/session-end
  ```

  同时断言 malformed JSON、unknown status、revision/assignment conflict 的 HTTP status 与 error code。

- [x] **Step 2: Run focused tests and verify RED**

  Run: `node --test test/api-server.test.mjs test/task-client.test.mjs test/plugin-adapters.test.mjs`

  Expected: FAIL，routes/tools 尚不存在。

- [x] **Step 3: Add service lifecycle wrapper and API routes**

  lifecycle write 经 service 统一调用 store，并保证 replay/no-op 不发布 SSE。API 继续强制 loopback Host/Origin，不增加 auth token。

- [x] **Step 4: Add host-neutral task client methods**

  `createTaskClient()` 增加 `syncTree`、Task mutations、events、execution list/assign/classify、session context 与 lifecycle methods。

- [x] **Step 5: Add MCP tools to core and both adapter clients**

  新增：

  ```text
  agent_tasks_sync_tree
  agent_tasks_update
  agent_tasks_archive
  agent_tasks_restore
  agent_task_executions_list
  agent_task_execution_assign
  agent_task_execution_classify
  ```

  delete 只提供 Dashboard HTTP action；不提供给 Agent 的默认 MCP tool。Codex/Claude MCP clients 各自维护 source，但暴露相同 host-neutral tools。

- [x] **Step 6: Verify GREEN and adapter bundles**

  Run: `node --test test/api-server.test.mjs test/task-client.test.mjs test/server-integration.test.mjs test/plugin-adapters.test.mjs`

  Run: `npm run build:adapters`

  Expected: tests PASS，两个 bundle 均通过 initialize/tools list。

### Task 6: Dashboard Task tree aggregates and progress presentation

**Files:**

- Modify: `mcp/src/dashboard-data.mjs`
- Modify: `ui/src/dashboard-state.mjs`
- Modify: `ui/src/dashboard.mjs`
- Modify: `ui/src/dashboard.css`
- Modify: `test/dashboard-data.test.mjs`
- Modify: `test/dashboard-ui-state.test.mjs`

- [x] **Step 1: Write failing pure data/UI-state tests**

  覆盖：progress `{ remaining,total,completed,ratio }`、active agent count、execution count、最近 execution context、`canceled`/archived/deleted filter、no-child root 无 `0/0`、历史 tab 和 disclosure state。

- [x] **Step 2: Run focused tests and verify RED**

  Run: `node --test test/dashboard-data.test.mjs test/dashboard-ui-state.test.mjs`

  Expected: FAIL，snapshot/filters 尚不认识 v2 汇总。

- [x] **Step 3: Extend the snapshot without embedding full histories**

  `createDashboardSnapshot()` 输出 Task metadata、progress、active agent/execution counts 和 recent context；只返回 `unassigned_execution_count`，不在 snapshot 内嵌完整 `task_events`/`task_executions`。

- [x] **Step 4: Render an accessible progress cell**

  root 有 child 时使用 progress ring + `未完成 N / T`；child/no-child root 使用文字状态。ring 必须包含可读 `aria-label`，不能只靠颜色。

- [x] **Step 5: Preserve existing Timeline and context behavior**

  确认 disclosure、Timeline toggle、grid/timeline splitter、列拖拽、workspace/worktree/branch 垂直居中与完整内容 popover、Session ID copy 均未回归。

- [x] **Step 6: Verify GREEN and build**

  Run: `node --test test/dashboard-data.test.mjs test/dashboard-ui-state.test.mjs`

  Run: `npm run build`

  Expected: PASS，`ui/dist/index.html` 成功生成。

### Phase 1 Checkpoint

- [x] Run: `npm test`
- [x] Run: `npm run check`
- [x] Run: `git diff --check`
- [x] 展示 schema/tree/API/Dashboard focused evidence 与 changed files。
- [x] Phase commit 未获授权；保持未提交并继续后续实现。

---

## Phase 2 — Real-time execution lifecycle and Dashboard control

### Task 7: Codex hook HTTP client and bounded transcript enrichment

**Files:**

- Create: `adapters/codex/tasks-recorder/hooks/src/codex-transcript.mjs`
- Create: `test/codex-transcript.test.mjs`
- Modify: `adapters/codex/tasks-recorder/hooks/src/taskd-client.mjs`
- Modify: `adapters/codex/tasks-recorder/hooks/src/hook-context.mjs`
- Modify: `test/plugin-adapters.test.mjs`

- [x] **Step 1: Write failing parser/client tests**

  使用 synthetic JSONL fixtures 覆盖 root/child `session_meta`、parent thread、agent path、malformed/truncated/missing file、超出允许 sessions root 的 path，以及 taskd unavailable。

- [x] **Step 2: Run focused tests and verify RED**

  Run: `node --test test/codex-transcript.test.mjs test/plugin-adapters.test.mjs`

  Expected: FAIL，parser 与 lifecycle client 不存在。

- [x] **Step 3: Implement bounded metadata-only parsing**

  `readCodexTranscriptMetadata(path, options)` 只读取足以取得首个 session metadata 的有界字节，不返回 prompt/response 正文；real path 必须落在 resolved Codex sessions root 内。解析失败返回 structured warning，不猜 parent。

- [x] **Step 4: Generalize the Codex taskd client**

  增加 `sendLifecycle(event, input)`、`fetchSessionContext(sessionId)`；继续限制 URL 为 `http://127.0.0.1` origin、使用短 timeout，并让 hook caller fail open。

- [x] **Step 5: Verify GREEN**

  Run: `node --test test/codex-transcript.test.mjs test/plugin-adapters.test.mjs`

  Expected: PASS。

### Task 8: Codex native lifecycle hooks

**Files:**

- Create: `adapters/codex/tasks-recorder/hooks/session-start.mjs`
- Create: `adapters/codex/tasks-recorder/hooks/subagent-start.mjs`
- Create: `adapters/codex/tasks-recorder/hooks/subagent-stop.mjs`
- Create: `adapters/codex/tasks-recorder/hooks/session-end.mjs`
- Modify: `adapters/codex/tasks-recorder/hooks/user-prompt-task-sync.mjs`
- Modify: `adapters/codex/tasks-recorder/hooks/task-heartbeat.mjs`
- Modify: `adapters/codex/tasks-recorder/hooks/stop-task-check.mjs`
- Modify: `adapters/codex/tasks-recorder/hooks/hooks.json`
- Modify: `adapters/codex/tasks-recorder/skills/task-manager/SKILL.md`
- Modify: `test/plugin-adapters.test.mjs`
- Modify: `package.json`

- [x] **Step 1: Write failing hook contract tests**

  为七类 hook 构造 stable payload 并用 loopback fake server 断言 endpoint/body：`SessionStart`、`UserPromptSubmit`、`PostToolUse`、`SubagentStart`、`SubagentStop`、`SessionEnd`、`Stop`。

  特别覆盖：

  - `PostToolUse(update_plan)` 记录 observation 并输出 sync reminder。
  - subagent enrichment 成功/失败都发送 lifecycle；失败保持未绑定。
  - network/parse failure 全部 exit 0，不破坏 Codex。
  - replay input 使用稳定 external key。

- [x] **Step 2: Run the focused hook test and verify RED**

  Run: `node --test test/plugin-adapters.test.mjs`

  Expected: FAIL，hooks/config 尚未覆盖 lifecycle。

- [x] **Step 3: Implement lifecycle scripts and native hook config**

  保持每个 hook script 单一职责；`hooks.json` 为实时 hook 设置合理 timeout/async，`UserPromptSubmit`/`Stop` 保留需要返回 context/decision 的同步模式。

- [x] **Step 4: Make Stop blocking state-aware**

  Stop 只在 taskd 可达且 session context 显示 pending observation、未绑定 concrete execution 或需收口 active Task 时 block 一次。taskd unavailable、普通聊天已标记 `non_work`、`stop_hook_active` 时 fail open。

- [x] **Step 5: Update Codex task-manager instructions**

  明确 Task identity、`sync_tree`、`agent_key`、subagent execution、explicit root completion 和 non-work classification；不修改 Claude skill 为伪 lifecycle parity。

- [x] **Step 6: Verify GREEN and syntax**

  Run: `node --test test/plugin-adapters.test.mjs`

  Run: `npm run check && npm run build:adapters`

  Expected: PASS。

### Task 9: Dashboard details sheet and optimistic Task editing

**Files:**

- Create: `ui/src/dashboard-api.mjs`
- Create: `ui/src/task-details-sheet.mjs`
- Create: `test/dashboard-details.test.mjs`
- Modify: `ui/src/index.html`
- Modify: `ui/src/dashboard.mjs`
- Modify: `ui/src/dashboard-state.mjs`
- Modify: `ui/src/dashboard.css`
- Modify: `ui/build.mjs`

- [x] **Step 1: Write failing sheet model/API tests**

  覆盖 Summary/Executions/Activity tabs、edit payload、expected revision conflict、archive/delete/restore action visibility、full Session ID copy、sheet keyboard close/focus restore。

- [x] **Step 2: Run focused tests and verify RED**

  Run: `node --test test/dashboard-details.test.mjs test/dashboard-ui-state.test.mjs`

  Expected: FAIL，sheet/API modules 尚不存在。

- [x] **Step 3: Extract browser API calls**

  `dashboard-api.mjs` 统一 snapshot、Task mutation、events、execution list/assign/classify；保留错误 code/details，供 UI 显示准确冲突提示。

- [x] **Step 4: Implement the right-side details sheet**

  - 点击 Task row 打开，root disclosure 点击不误触。
  - Summary 可编辑 title/description/status/next action/due date/parent/sort order。
  - Executions 按时间列出 kind、agent、path、session/turn、状态、时间和 Git context。
  - Activity 展示 Task events，不渲染 raw JSON。
  - Actions 提供 add child、cancel、archive、soft delete、restore。
  - 使用 expected revision；冲突时保留用户输入、刷新 server 最新数据并提示。

- [x] **Step 5: Preserve accessibility and responsive layout**

  使用 semantic dialog/sheet、focus trap、Escape close、screen-reader labels；窄屏 sheet 覆盖内容，宽屏不压坏 Gantt splitter。

- [x] **Step 6: Verify GREEN and build**

  Run: `node --test test/dashboard-details.test.mjs test/dashboard-ui-state.test.mjs`

  Run: `npm run build`

  Expected: PASS。

### Task 10: Unassigned execution inbox and assignment controls

**Files:**

- Create: `ui/src/execution-inbox.mjs`
- Create: `test/execution-inbox.test.mjs`
- Modify: `ui/src/dashboard.mjs`
- Modify: `ui/src/dashboard-api.mjs`
- Modify: `ui/src/dashboard.css`
- Modify: `test/api-server.test.mjs`

- [x] **Step 1: Write failing inbox tests**

  覆盖未绑定 count、root session/time/agent path filters、single/batch assignment、assignment conflict、mark non-work、SSE refresh 后 selection reconciliation。

- [x] **Step 2: Run focused tests and verify RED**

  Run: `node --test test/execution-inbox.test.mjs test/api-server.test.mjs`

  Expected: FAIL，inbox UI/batch route 尚不存在。

- [x] **Step 3: Add atomic batch assignment API**

  新增 `PATCH /api/v1/executions/tasks`，每项携带 execution id 与 expected task/classification；任一冲突时全批 rollback并返回 conflicts。

- [x] **Step 4: Implement inbox UI**

  工具栏显示 `未绑定 N`，打开列表后可过滤、选择、分配到 root/child 或标记 `non_work`。成功 mutation 只触发一次 SSE change。

- [x] **Step 5: Verify GREEN**

  Run: `node --test test/execution-inbox.test.mjs test/api-server.test.mjs test/dashboard-ui-state.test.mjs`

  Run: `npm run build`

  Expected: PASS。

### Phase 2 Checkpoint

- [x] Run: `npm test`
- [x] Run: `npm run check`
- [x] Run: `npm run build && npm run build:adapters`
- [x] 使用临时 config/database 启动 taskd，发送 synthetic hooks，确认 SSE、details 和 inbox 实时更新。
- [x] 使用 `playwright-headless` MCP 做 focused browser verification：progress ring、disclosure、sheet、inbox、Session ID copy、Timeline drag、keyboard flow。
- [x] 已汇总证据与 changed files；phase commit 未获授权，保持未提交。

---

## Phase 3 — Historical Codex import, documentation, and release readiness

### Task 11: Codex JSONL importer parser

**Files:**

- Create: `server/src/codex/transcript-reader.mjs`
- Create: `server/src/codex/importer.mjs`
- Create: `test/fixtures/codex/root-session.jsonl`
- Create: `test/fixtures/codex/child-session.jsonl`
- Create: `test/codex-importer.test.mjs`
- Modify: `scripts/package-release.mjs`
- Modify: `package.json`

- [x] **Step 1: Create minimal privacy-safe fixtures and failing parser tests**

  Fixtures 只保留 schema shape、synthetic IDs 和 metadata，不复制真实 prompt/assistant content。测试覆盖 root turns、successful/failed spawn、child start/stop、duplicate lines、missing child transcript、malformed tail 和 98 unique started children 的生成式 fixture。

- [x] **Step 2: Run parser tests and verify RED**

  Run: `node --test test/codex-importer.test.mjs`

  Expected: FAIL，importer 尚不存在。

- [x] **Step 3: Implement explicit session resolution**

  `resolveCodexSession({ sessionId, codexHome })` 必须 exact-match session ID；多个/零个候选返回明确错误，不按最近时间猜测。

- [x] **Step 4: Normalize transcript events without Task guessing**

  输出 normalized session/turn/subagent lifecycle records 与 warnings。仅在已有 exact Task/session binding 可证明时关联；否则 `task_id = null`、`classification = unknown`。

- [x] **Step 5: Verify parser idempotency model**

  external key 必须由 immutable host IDs/event type 构造，不使用当前时间或数组序号；重复 parse 得到 byte-for-byte equivalent normalized records。

- [x] **Step 6: Verify GREEN**

  Run: `node --test test/codex-importer.test.mjs`

  Expected: PASS，包括 98 unique started child executions。

### Task 12: Import preview/apply API and `tasks-recorder import codex` CLI

**Files:**

- Create: `server/cli.mjs`
- Create: `test/cli-import.test.mjs`
- Modify: `server/control.mjs`
- Modify: `server/src/api-server.mjs`
- Modify: `mcp/src/task-service.mjs`
- Modify: `mcp/src/task-store.mjs`
- Modify: `install.sh`
- Modify: `scripts/package-release.mjs`
- Modify: `test/control.test.mjs`
- Modify: `test/api-server.test.mjs`
- Modify: `test/install-script.test.mjs`
- Modify: `package.json`

- [x] **Step 1: Write failing CLI and import transaction tests**

  覆盖：argument parsing、missing service、exact session resolution、dry-run zero writes、apply one transaction、replay all skipped、partial conflict rollback、exit codes，以及 installer wrapper 透传全部 args。

- [x] **Step 2: Run focused tests and verify RED**

  Run: `node --test test/cli-import.test.mjs test/control.test.mjs test/api-server.test.mjs test/install-script.test.mjs`

  Expected: FAIL，CLI/import route 尚不存在，wrapper 当前只透传第一个参数。

- [x] **Step 3: Add a CLI dispatcher without changing `npm run taskd`**

  - `server/cli.mjs` 无参数默认 `status`。
  - service commands 委托 `control.mjs` 导出的 command runner。
  - `import codex --session <id> [--dry-run] [--codex-home <path>]` 调用 Codex parser，再把 normalized batch 发给 taskd。
  - `install.sh` wrapper 使用 `"$@"` 透传，不丢 `--session`/`--dry-run`。

- [x] **Step 4: Add host-neutral normalized import endpoint**

  新增 `POST /api/v1/import/executions`，body 包含 `source`、`dry_run`、normalized records。taskd 校验 payload 并在 apply 时单事务调用 `store.importExecutions()`；API 不读取 Codex filesystem。

- [x] **Step 5: Return an auditable summary**

  CLI JSON 输出至少包含：session ID、root turns、subagent executions、would_create/created、would_update/updated、skipped、unassigned、warnings、dry_run。

- [x] **Step 6: Verify GREEN**

  Run: `node --test test/cli-import.test.mjs test/codex-importer.test.mjs test/control.test.mjs test/api-server.test.mjs test/install-script.test.mjs`

  Expected: PASS。

### Task 13: Documentation and public contract synchronization

**Files:**

- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-08-14-task-tree-lifecycle-design.md`
- Modify: directly matching architecture/overview docs found by the scan

- [x] **Step 1: Inventory changed files and the complete docs tree**

  Run: `git diff --name-only HEAD`

  Run: `find . -name "*.md" -not -path "*/node_modules/*" -not -path "*/.git/*"`

- [x] **Step 2: Scan every doc for changed modules, paths, commands, and behavior**

  至少搜索：`task-store`、`task_sessions`、`heartbeat`、`hooks.json`、`Dashboard`、`tasks-recorder status`、`install.sh`、`schema version`、`agent_tasks_upsert`、`completed/history`。

- [x] **Step 3: Update README How it works and operations**

  解释 Task vs execution、root/child、实时 hooks、SSE Dashboard、未绑定 inbox、details sheet、CLI dry-run/apply、数据位置、隐私边界、adapter 独立维护、故障排查和升级兼容性。

- [x] **Step 4: Mark the design implementation status accurately**

  只有相应 phase 验证完成后，才把 spec 状态从“等待 implementation plan”更新为实际完成状态；保留未实现限制。

- [x] **Step 5: Report doc scan outcome**

  若完整扫描没有其他文档需更新，交付中明确写“扫描了文档树，无需同步”；若有，则列出同步文件。

  扫描结果：已同步 `README.md`、本设计 spec、root/Claude task-manager skill；其他 dated plans/specs 是历史决策记录，不回写为当前 runtime contract。

### Task 14: End-to-end verification and release readiness

**Files:**

- Modify only files required by failures discovered in this verification

- [x] **Step 1: Run all automated checks from a clean process**

  Run: `npm test`

  Run: `npm run check`

  Run: `npm run build`

  Run: `npm run build:adapters`

  Run: `npm run package:release`

  Run: `git diff --check`

  Expected: all exit 0。

- [x] **Step 2: Verify packaged artifacts, not source-only paths**

  在 temporary directory 解压 service/Codex/Claude archives，确认：新 core modules、Codex hooks、CLI、built Dashboard、adapter bundles 均存在；从解压目录运行 syntax/MCP handshake tests。

- [x] **Step 3: Run a temporary end-to-end lifecycle scenario**

  使用 temporary HOME/config/port 启动 packaged taskd，执行：session start -> turn start -> sync root/children -> spawn start/stop -> A/B/A focus -> session end -> Dashboard snapshot。断言 execution、progress、events、unassigned count 和 SSE revision。

- [x] **Step 4: Run focused browser verification with Playwright MCP**

  默认使用 `playwright-headless`：验证 desktop 和 narrow viewport 的 Task disclosure、progress text/ring、sheet、inbox、status mutation、Session ID copy、Timeline splitter、live SSE refresh 和 keyboard navigation。仅保存与断言相关的 screenshot/evidence 到 `.tmp/`，完成后清理。

- [x] **Step 5: Audit the real historical session in dry-run mode only**

  Run: `tasks-recorder import codex --session 019fa297-4567-7bf0-a69a-84fd23b3aaab --dry-run`

  Expected: exact root session，识别 98 个 unique started child executions，保留现有 3 个 root Task，不强制 Task assignment，真实 DB 零写入。

- [x] **Step 6: Inspect final worktree state**

  Run: `git status --short`

  Run: `git diff --stat`

  Run: `git diff --name-only HEAD`

  确认没有 release archives、temporary fixtures、真实 transcript、database/WAL、credentials 或无关用户改动进入 diff。

### Phase 3 Checkpoint

- [x] 汇总自动测试、packaged runtime、browser、真实 session dry-run 和文档扫描证据。
- [x] 列出仍需单独授权的外部动作：真实数据库 migration/import、phase/final commits、version bump、tag、GitHub release、本地 reinstall。
- [x] 已按授权创建并推送 `1d8de59 feat: add task tree and execution lifecycle`，没有混入 release archives、真实 transcript 或数据库文件。
- [x] 已发布 `v0.4.0`，并将本机 service、Codex adapter 与 Claude adapter 更新到 0.4.0；真实历史 import 仍只执行 dry-run，未 apply。

验证结果（2026-08-16）：

- `npm test`：163/163 passed；`npm run check`、`npm run build`、`npm run build:adapters`、`npm run package:release`、`git diff --check` 均 exit 0。
- packaged runtime test 从 release archives 解压运行 syntax check、Codex/Claude MCP handshake、temporary taskd lifecycle、Dashboard snapshot 和 packaged CLI dry-run，未依赖 source-tree runtime。
- browser 验证覆盖 desktop/narrow viewport、Task disclosure、progress、Details Sheet、Inbox、status mutation、Session ID copy、Timeline splitter、SSE refresh 和 keyboard focus；证据目录被 gitignore，未进入 diff。
- 真实 session 的 packaged CLI dry-run 识别 180 root turns、98 direct child executions、278 unique records 和 7 个 failed-spawn warnings；用于验证关联歧义的 temporary DB 中 3 个 synthetic root Tasks 完全不变，execution rows 保持 0；真实数据库未打开、未写入，也未执行 apply。
- 最终 review 修复并覆盖跨 root parent、nested subagent parent 和 main-with-parent 三类非法 import；reviewer 复核 cleared，focused tests 8/8 与全量 tests 163/163 均通过。
- 完整文档树已扫描并同步 README、design spec、implementation plan 及 root/Codex/Claude task-manager skills；dated historical documents 保留原始决策语境。
- worktree 审计确认 release archives 位于 ignored `release/`，仅 synthetic JSONL fixtures 进入变更；没有 database/WAL、真实 transcript、credentials 或临时产物进入 diff。
- 发布结果：GitHub CI 与 Release workflow 均通过；`v0.4.0` 为 latest Release，assets 的 `SHA256SUMS` 全部验证成功。
- 本机升级结果：schema v1 -> v2 migration 成功，`integrity_check=ok`，原有 33 个 Tasks 保留；service、Codex adapter、Claude adapter 均为 0.4.0。
- 真实 session 的 installed CLI dry-run 仍为 180 root turns、98 direct child executions、278 would-create、7 warnings；`persisted=false`，数据库保持 33 Tasks / 0 executions。
- 尚未执行：真实历史 import apply。升级前的 schema v1 SQLite/config 备份已验证并保留。
