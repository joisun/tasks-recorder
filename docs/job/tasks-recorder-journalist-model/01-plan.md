# Tasks Recorder 记者模型实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 本项目不启用 subagent dispatch；每个 phase 在当前 session 内按 TDD 执行并设置人工 checkpoint。

**目标**：把 Tasks Recorder 从 v2 的 Task–Execution 直接绑定升级为 schema v3 的双平面本机工作日志，交付 Project → Main Task → Subtask、Work Segment Attribution、fail-open ingestion 与真实 planned/actual Timeline。

**依据**：[讨论与范围确认](./00-discussion.md)、[authoritative spec](../../superpowers/specs/2026-08-19-project-journalist-lifecycle-design.md)

**Architecture**：Fact plane 以 Observation、Source Session、Execution、Work Segment 保存事实；Semantic plane 以 Project、Main Task、Subtask 保存用户目标；Segment Attribution 是唯一桥梁。taskd 继续作为 SQLite 唯一 writer，Hook 只归一化和投递 host-neutral Event Envelope，失败时写 bounded spool 并 fail-open。Dashboard 从 v3 projection 读取三层业务树、双 Inbox 和 planned/actual timeline，不读取数据库文件。

**Tech Stack**：Node.js 24 ESM、`node:sqlite`、HTTP + SSE、MCP SDK 1.30、React 19、SVAR React Gantt 2.7、Node test runner、esbuild。

---

## 全局约束（Global Constraints）

1. SQLite canonical database 保持 `~/.config/tasks-recorder/tasks.db`；只有 taskd runtime / maintenance mode 可写数据库。
2. Schema 目标版本固定为 3；v2 → v3 必须先 dry-run/report，再 backup + 单事务 apply。任何歧义只进入 provisional / Inbox，不能猜测合并。
3. 不保存 prompt、reasoning、assistant message、tool input/output、token、cookie、credential；Event Envelope 在 adapter 端使用 allowlist 构造。
4. Hook lifecycle 必须 fail-open，单次 HTTP 请求超时不超过 1.5 秒；spool 失败也不能阻断 Agent。
5. branch 只用于展示与过滤，不得单独参与 Project resolution 或 Task candidate matching。
6. Task lifecycle 存储值只允许 `planned | in_progress | waiting | blocked | done | canceled`；兼容入口接受 `active` 并归一化为 `in_progress`。
7. Execution 不再直接拥有 canonical `task_id`；legacy API 中的 `task_id` 只能是 accepted Segment Attribution 的 compatibility projection。
8. 同一 Execution 同时最多一个 open Work Segment；同一 Segment 同时最多一个 accepted Attribution。
9. 旧 MCP/API 在一个 release window 内保留 compatibility wrapper，并明确返回 `deprecated` / replacement 信息；新 Hook/skill 不再调用 `list + full sync_tree`。
10. 不新增 runtime dependency。若 SVAR 无法表达 spec 中的 summary/planned/actual，则先完成 capability spike，再提出 renderer 替换决策，不做 CSS hack。
11. 所有 code task 遵循 red → green → focused regression；不运行与阶段无关的 formatter，不引入 file-wide churn。
12. 未经用户确认不创建 commit。每个 phase 结束只提供可提交文件清单、验证证据与建议 Conventional Commit message。
13. 每个 phase 完成后扫描 Markdown 文档树；只有 public contract 已实际改变时才更新 README / skills，避免提前把 v3 目标写成当前行为。

## 文件结构与责任边界

### Schema 与 domain stores

| 路径 | 动作 | 单一责任 |
| --- | --- | --- |
| `mcp/src/task-schema.mjs` | Modify | schema 初始化入口、版本 gate；不承载完整 DDL 与业务 migration policy |
| `mcp/src/schema-v3.mjs` | Create | v3 tables、indexes、constraints 的建表函数 |
| `mcp/src/schema-migration.mjs` | Create | v2 inventory、dry-run report、backup/apply orchestration 与 invariant checks |
| `mcp/src/config.mjs` | Modify | database/log/spool/retention/recovery 的本机配置路径与默认值 |
| `mcp/src/git-context.mjs` | Modify | 增加 credential-free remote 与 git common dir discovery |
| `mcp/src/project-store.mjs` | Create | Project / ProjectLocation CRUD、revision 与精确 location resolution |
| `mcp/src/work-store.mjs` | Create | Observation、Source Session、Execution、Work Segment、Attribution、Intent lifecycle |
| `mcp/src/v3-task-store.mjs` | Create | v3 Task semantic CRUD、lifecycle、tree revision 与 Task Event |
| `mcp/src/journal-store.mjs` | Create | 组合 Project/Task/Work stores 的 v3 façade；runtime cutover 前可独立验证 |
| `mcp/src/task-store.mjs` | Modify | v3 Task 语义 CRUD/tree；作为 store façade 组合 project/work stores |
| `mcp/src/task-execution-store.mjs` | Modify | v2 execution API compatibility adapter；不再保存 canonical direct task binding |
| `mcp/src/task-tree.mjs` | Modify | 新 lifecycle、progress 与三层约束的纯函数 |
| `mcp/src/event-envelope.mjs` | Create | host-neutral envelope allowlist、normalize、redact、dedupe key validation |

### Service、API、CLI 与 recovery

| 路径 | 动作 | 单一责任 |
| --- | --- | --- |
| `mcp/src/task-service.mjs` | Modify | command/query orchestration 与 SSE change type；不写 SQL |
| `mcp/src/task-client.mjs` | Modify | event ingest、work context/focus、Project/Attribution/migration client contract |
| `mcp/src/tools.mjs` | Modify | 新 semantic MCP tools 与 legacy wrapper metadata |
| `server/src/api-server.mjs` | Modify | v3 routes、input size/content-type/loopback enforcement |
| `server/src/taskd-runtime.mjs` | Modify | store/service composition、startup consistency scan、spool replay lifecycle |
| `server/src/recovery.mjs` | Create | stale detection 与有证据的 interrupted recovery decision |
| `server/src/structured-logger.mjs` | Create | allowlist JSONL logs、rotation 与隐私测试入口 |
| `server/cli.mjs` | Modify | `migrate --dry-run|--apply|--report`、status diagnostics |
| `server/control.mjs` | Modify | logs/spool path 与 health details；安装/更新不碰 DB |

### Adapters 与 reliability

| 路径 | 动作 | 单一责任 |
| --- | --- | --- |
| `hooks/src/event-spool.mjs` | Create | root/Claude adapter 共用的 bounded spool 实现 |
| `hooks/src/taskd-client.mjs` | Modify | Event Envelope 投递、短超时、spool fallback |
| `adapters/codex/tasks-recorder/hooks/src/event-spool.mjs` | Create | Codex package 内自包含 spool runtime |
| `adapters/codex/tasks-recorder/hooks/src/taskd-client.mjs` | Modify | Codex lifecycle → `/api/v1/events` |
| `adapters/codex/tasks-recorder/hooks/*.mjs` | Modify | 只发 mechanical events；Stop 不再 block 等待 tree sync |
| `adapters/claude/tasks-recorder/hooks/src/event-spool.mjs` | Create | Claude package 内自包含 spool runtime |
| `adapters/claude/tasks-recorder/hooks/src/taskd-client.mjs` | Modify | Claude lifecycle → `/api/v1/events` |
| `adapters/claude/tasks-recorder/hooks/*.mjs` | Modify | 与 host native 事件对齐；不强行复用 Codex payload |
| `skills/task-manager/SKILL.md` | Modify | semantic checkpoint/focus workflow，不再每轮 full sync |
| `adapters/*/tasks-recorder/skills/task-manager/SKILL.md` | Modify | host-specific、contract 一致的 skill 文案 |
| `scripts/build-adapters.mjs` | Modify | package hook runtime 与 MCP bundle 一致性检查 |

### Projection 与 Dashboard

| 路径 | 动作 | 单一责任 |
| --- | --- | --- |
| `mcp/src/dashboard-data.mjs` | Modify | v3 Project tree、Task progress、live state、Inbox/timeline projection |
| `ui/src/project-tree.mjs` | Create | Project/Main Task/Subtask hierarchy 与 open state |
| `ui/src/attribution-inbox.mjs` | Create | Project Inbox / Task Attribution Inbox 操作 |
| `ui/src/timeline-projection.mjs` | Create | planned/actual/envelope 与 adaptive extent 的纯函数 |
| `ui/src/svar-gantt-state.mjs` | Modify | Project summary、actual segment、planned overlay、auto scale state |
| `ui/src/svar-gantt-renderer.jsx` | Modify | 三层 row 与 planned/actual visual grammar；保持 resize/Sheet/accessibility |
| `ui/src/dashboard-api.mjs` | Modify | v3 snapshot、focus、Attribution、Project mutation calls |
| `ui/src/dashboard-state.mjs` | Modify | filter、derived live state 与 project metrics |
| `ui/src/dashboard.mjs` | Modify | 页面 composition、SSE delta、两个 Inbox 与详情 Sheet |
| `ui/src/dashboard.css` | Modify | compact tokens、hierarchy rhythm、focus/accessibility；不承担数据修正 |

### Tests 与文档

新增 focused tests：

```text
test/schema-v3.test.mjs
test/schema-v3-migration.test.mjs
test/project-store.test.mjs
test/project-resolution.test.mjs
test/event-envelope.test.mjs
test/work-segment.test.mjs
test/segment-attribution.test.mjs
test/event-ingest.test.mjs
test/event-spool.test.mjs
test/recovery.test.mjs
test/semantic-tools.test.mjs
test/v3-compatibility.test.mjs
test/project-dashboard-data.test.mjs
test/timeline-projection.test.mjs
test/project-dashboard-ui.test.mjs
```

现有 v2 tests 不批量删除；能表达 compatibility contract 的继续保留，断言 canonical v2 内部结构的测试迁移到 v3 等价 invariant。

## 已锁定的接口契约

### Event ingestion

```http
POST /api/v1/events
Content-Type: application/json

{
  "source": "codex",
  "event_type": "execution.started",
  "external_event_id": "codex:<session>:<turn>:start",
  "observed_at": "2026-08-19T10:00:00.000Z",
  "source_session_key": "...",
  "source_turn_key": "...",
  "source_agent_key": null,
  "workfolder": "/workspace",
  "git_root": "/workspace",
  "git_common_dir": "/workspace/.git",
  "git_remote": null,
  "worktree": "/workspace/.worktree/feature-a",
  "branch": "feature/a",
  "payload": { "kind": "main" }
}
```

成功响应至少包含 `{ ok, persisted, deduped, observation_id, execution_id, segment_id }`；相同 `(source, external_event_id)` replay 返回同一 identity 且 `deduped: true`。

### Semantic commands

```text
agent_work_context(execution_id)
agent_work_focus(execution_id, task_id | null, rationale)
agent_work_checkpoint(execution_id, task_id, summary, next_action)
agent_tasks_mutate(project_id, task mutation + expected_revision)
agent_tasks_sync_structure(project_id, main task + complete direct-child set)
```

- `agent_work_context` 最多返回三个同 Project candidates 和它们的直接 children。
- `agent_work_focus` 切换时原子关闭当前 Segment、创建新 Segment、写 accepted Attribution。
- `agent_tasks_sync_structure` 只处理结构变更，不触碰 Execution lifecycle。
- legacy `agent_tasks_context` / `agent_tasks_sync_tree` 调用 compatibility adapter，并返回 `deprecated: true` 与 replacement；新 skill 不调用它们。

### Query / mutation API

```text
GET    /api/v1/projects
POST   /api/v1/projects
PATCH  /api/v1/projects/:id
GET    /api/v1/projects/:id/tree
POST   /api/v1/work/context
POST   /api/v1/work/focus
PATCH  /api/v1/segments/:id/attribution
GET    /api/v1/inbox/projects
GET    /api/v1/inbox/attributions
POST   /api/v1/migrations/v3/dry-run
POST   /api/v1/migrations/v3/apply
GET    /api/v1/migrations/v3/report
```

Dashboard snapshot 继续通过 `GET /api/v1/snapshot`，但 v3 shape 顶层为：

```js
{
  revision,
  generated_at,
  projects: [],
  tasks: [],
  actual_segments: [],
  project_inbox_count,
  attribution_inbox_count,
  live_executions: [],
  warnings: [],
}
```

### Migration invariants

```text
legacy task count == migrated task count
legacy execution count == migrated execution count
legacy bound execution count == accepted migration attribution count
all foreign_key_check rows == 0
all integrity_check == ok
no task crosses project_id through parent_id
no execution has more than one open segment
no segment has more than one accepted attribution
```

## Phase 划分

### phase-1-data-foundation

- **目标**：建立 schema v3、Project/Task/Work domain store 与安全 migration engine，不改 Hook 和 Dashboard 的外部行为。
- **产出**：独立 JournalStore 空库直接建 v3；v2 fixture 可 dry-run、backup、迁移并满足 invariant；A → B → A 的 store-level test 得到三个 Segment；Project resolution 不使用 branch。现有 v2 taskd runtime 保持可用，直到 phase 3 的 API/MCP 双栈就绪后再 cutover。
- **依赖**：无。
- **退出检查**：focused schema/store/migration tests、原 v2 compatibility store tests、`PRAGMA integrity_check`、`foreign_key_check`。

### phase-2-ingestion-reliability

- **目标**：让 host lifecycle 通过 Event Envelope 自动推进 Observation/Session/Execution/Segment，taskd 不可用时可靠 fail-open。
- **产出**：`POST /api/v1/events` 幂等；Stop 关闭 segment/execution 而不改 Task；bounded spool 可轮转/replay；recovery 区分 stale 与 interrupted。
- **依赖**：phase-1-data-foundation。
- **退出检查**：event contract、dedupe、spool permission/cap、replay、startup recovery、API integration tests。

### phase-3-semantic-control

- **目标**：提供 compact context、focus/Attribution、Task structure mutation，并迁移 MCP tools、host skills 与 compatibility wrapper。
- **产出**：主线程与 subagent 都以 execution/segment 记录；语义变化才调用 MCP；普通 heartbeat 不再 `context + list + full sync_tree`；旧客户端在兼容窗口可用。
- **依赖**：phase-2-ingestion-reliability。
- **退出检查**：MCP schemas、context candidate isolation、focus atomicity、legacy compatibility、built adapters package tests。

### phase-4-project-dashboard

- **目标**：交付 Project → Main Task → Subtask、双 Inbox 与真正表达项目周期的 planned/actual Timeline。
- **产出**：Project synthetic summary row；父级 actual envelope 包络 children；adaptive scale；zoom/pan 不被 SSE 重置；workspace/worktree/branch/session 可查看与复制；compact、可键盘操作的 Sheet/tree。
- **依赖**：phase-3-semantic-control。
- **退出检查**：projection unit tests、UI state tests、build、Playwright MCP functional checks、`visual-driven-review` desktop/mobile/adversarial visual audit。

### phase-5-rollout-documentation

- **目标**：在备份保护下完成真实本机迁移、adapter 切换、文档与发布前验证。
- **产出**：本地 v2 DB dry-run report 经确认后迁移；taskd/status/log/spool 正常；README How it works / install / migrate / troubleshoot 与 architecture docs 对齐；deprecated path 有清晰移除窗口。
- **依赖**：phase-4-project-dashboard。
- **退出检查**：全量 test/check/build/adapters/release package、真实 service smoke、Dashboard visual regression、文档链接扫描、安装升级不覆盖 DB。

## TDD 执行顺序

每个 task 固定采用：

1. 在明确的 test file 写一个最小失败用例。
2. 运行该 test 的精确 `node --test ... --test-name-pattern ...` 命令，保存预期失败原因。
3. 只实现让该测试通过的最小 domain/API/UI 变更。
4. 重跑 focused test，再跑同模块 regression。
5. 更新 phase log、`02-tasks.md` 和 `03-phases.md`；未获授权不 commit。

Task 详情在计划确认后写入 `tasks/phase-N-*/task-XX-*.md`，开始执行后内容冻结；实现中发现的新范围以新 task 文件追加，不能回写掩盖原计划。

## Spec 追溯矩阵

| Spec requirement | 实施 phase | 主要证据 |
| --- | --- | --- |
| Project entity、Location、精确解析、provisional Inbox | phase 1、4 | Project store/resolution tests；Project Inbox browser flow |
| Observation / Session / Execution / Segment facts | phase 1、2 | schema/work store tests；ingest integration |
| Attribution provenance、纠错与 A → B → A | phase 1、3 | segment attribution tests；semantic focus contract |
| Event Envelope、隐私 allowlist、dedupe | phase 2 | envelope rejection/dedupe tests；log/spool privacy scan |
| Hook fail-open、bounded spool、replay | phase 2 | unavailable taskd、capacity、permission、replay tests |
| Task lifecycle / Execution live state 分离 | phase 1、2 | status transition + recovery tests |
| compact MCP commands、legacy wrapper、无 full-tree heartbeat | phase 3 | MCP schema/package tests；hook output assertions |
| Project → Main Task → Subtask 与双 Inbox | phase 4 | snapshot/unit/browser tests |
| planned/actual/envelope/adaptive scale | phase 4 | projection tests；SVAR capability spike；visual review |
| schema v2 → v3 backup/dry-run/apply/report | phase 1、5 | fixture invariants；真实本机 migration rehearsal |
| realtime SSE 保留 UI view state | phase 4 | controller state replay + Playwright interaction |
| logs、status、retention、privacy | phase 2、5 | structured log tests；service diagnostics smoke |
| install/update/docs/release safety | phase 5 | installer/package tests；Markdown/link scan |

## 阶段 checkpoint

每个 phase 结束时输出：

- 完成的 capability 与未完成项；
- changed files（只列本阶段）；
- focused / regression / migration / browser evidence；
- Johari 复核的新 blind spot / unknown；
- 建议 commit message 与精确 staged file list；
- 是否进入下一 phase 的用户确认。

## 风险与验证动作

| 风险 / Unknown | 早期验证动作 | 决策门槛 |
| --- | --- | --- |
| v2 数据中同名 Project 无法安全合并 | phase 1 migration inventory 输出 evidence groups 与 ambiguous rows | 无精确 local evidence 就 provisional，不自动 merge |
| SQLite CHECK 无法表达跨表层级约束 | store transaction + migration invariant query；必要时增加 trigger | 所有写入口和 migration fixture 均能拒绝跨 Project parent |
| 长 reasoning 被误判 interrupted | recovery test 注入无 tool heartbeat 但 session process 存活 | 只能投影 stale，不落 interrupted |
| spool 容量不足或泄露隐私 | fixture 写满 cap、检查权限与序列化字段 | boundary events 优先保留，payload allowlist 无原文 |
| legacy API 投影掩盖多 Segment | A → B → A compatibility test | legacy `task_id` 只返回当前/最近 accepted target，并带 lossy warning |
| schema 先 cutover 导致 taskd 暂时不可用 | phase 1 独立 JournalStore；phase 2/3 双栈 contract tests | v3 ingestion 与 semantic API 都绿后才切换 default runtime |
| SVAR 不支持双层 bar / density | phase 4 第一 task 做 renderer capability spike | 无法满足交互与可访问性时先提 renderer ADR，不用绝对定位 hack |
| SSE 刷新破坏 zoom/open/selection | UI controller state replay test + browser interaction | revision delta 后 view state 不变 |
| 真实 migration 无法回滚 | temp copy 演练 backup/open/restore | 未验证 backup 可打开前禁止 apply 本地 DB |

## Johari 计划复核

### Open Area

- 目标架构、实体边界、迁移原则、Hook fail-open、三层 Dashboard 与 Timeline 包络已由 spec 锁定。
- 当前 code map 和需要拆分的大型 store 已通过源码确认。

### Hidden Area

- 真实 v2 数据的 Project 歧义分布只有 dry-run 后可知；phase 1 不能假定全部可自动解析。
- 用户对 Project merge/split 的具体交互偏好尚未被真实 Inbox prototype 验证。

### Blind Spot

- 同时修改 canonical root hooks 与 packaged adapters 容易产生 drift，因此 package tests 必须比较 event contract，而不是只测试文件存在。
- v2 compatibility projection 是有损的，必须显式 warning，不能假装一条 execution 只有一个 Task。
- 迁移完成前 README 必须继续描述 v2 当前行为，否则开源用户会拿目标架构当已发布功能。

### Unknown Area

- SVAR capability、spool 默认容量、stale threshold 和旧数据 ambiguity 都需要 phase 内 spike/measurement；计划给出了决策门槛，不预先伪造结论。

---

## 计划确认

> 批准后创建 `02-tasks.md`、phase logs 与 phase-1 不可变 task 文件，并使用 `superpowers:executing-plans` 从 schema v3 failing tests 开始。未经用户授权不 commit。

**确认人**：项目所有者
**确认日期**：2026-08-19
**确认内容摘要**：用户此前明确选择“批准实施”，授权生成实施计划并开始 schema v3 TDD；当前计划未扩展 authoritative spec 范围，按自动推进约定以内联方式执行，不自动 commit。
