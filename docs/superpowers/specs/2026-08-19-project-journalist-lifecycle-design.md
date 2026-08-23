# Tasks Recorder 记者模型与双平面生命周期设计

> 日期：2026-08-19（Asia/Shanghai）
> 状态：Phase 1–5、v0.6.0 发布、真实数据库迁移与本机更新已完成；真实 spool 验证发现的永久 replay conflict 正通过 v0.6.1 hotfix 收口
> 取代：[`2026-08-14-task-tree-lifecycle-design.md`](./2026-08-14-task-tree-lifecycle-design.md) 中的后续演进模型
> 可编辑流程图：[`2026-08-19-project-journalist-lifecycle.drawio`](./2026-08-19-project-journalist-lifecycle.drawio)

## 结论

Tasks Recorder 的产品角色是本机工作记录员，而不是驱动 Agent 的项目管理器。它像记者一样：持续接收来源不同的事实，保存发生过什么与正在发生什么，再把可验证的工作片段归入稳定的 Project / Task 叙事；不确定的归属留给 Inbox，而不是靠 branch、标题或相邻时间强行猜测。

系统采用双平面模型：

```text
Fact plane
Observation -> Source Session -> Execution -> Work Segment
                                                |
                                                | Attribution
                                                v
Semantic plane                         Project -> Main Task -> Subtask
```

- Fact plane 只记录可观察事实，允许事实暂时没有 Task 归属。
- Semantic plane 表达用户真正要掌控的 Project 与交付目标。
- `Work Segment` 表达一次 execution 内连续推进同一目标的时间区间。
- `Attribution` 是两个平面之间唯一的语义桥梁，并记录依据、来源与可信度。
- Dashboard 把 Project 作为一级节点，但存储层不把 Project 伪装成 Task，也不强迫每条 Observation 立即进入 Task 树。

## 第一原则

### Goal

Dashboard 应稳定回答五个问题：

1. 我有哪些 Project，各自处于什么工作态势？
2. 每个 Project 正在推进哪些 Main Task，下一步是什么？
3. Main Task 拆成哪些 Subtask，阻塞与等待发生在哪里？
4. 哪些 Agent / session 当前正在工作，实际工作时间落在哪些目标上？
5. 哪些事实尚不能可靠归属，等待怎样的确认？

### Facts

- v2 中 `tasks.project` 只是文本，不是稳定实体。
- v2 中 `task_executions.task_id` 是单值外键，无法准确表示一次 session 中 Task A → B → A。
- 当前 `agent_tasks_context` 会把 branch 当跨仓库候选依据；常见的 `main` 会造成 Project 污染。
- 当前 lifecycle 收口经常触发 `context + list + full sync_tree`，payload 大且把机械记录与语义编辑混在一起。
- Hook 能观察生命周期边界，但不能只凭事件文本可靠判断 Main Task identity。
- Session ID 能关联一次 host session，却不是 Task ID、Project ID 或认证凭据。

### Assumptions to Validate

- 大多数 Project 可以通过显式注册或精确的 Git/workspace location 解析；无法解析的比例需要用迁移报告和运行指标验证。
- `update_plan` 对任务语义有帮助，但 plan item 未必都是值得长期追踪的 Subtask。
- 多数 tool-use heartbeat 只需更新时间和计数，不需要逐条形成永久事件。
- Adapter 本地 bounded spool 足以覆盖 taskd 短暂不可用；容量、保留期和丢弃策略需要故障测试确认。

### Constraints

- SQLite 继续是 canonical store，只有 `taskd` 写入。
- 不保存原始 prompt、reasoning、assistant message、tool input/output、token、cookie 或 secret。
- Codex、Claude 等 adapter 各自利用原生 lifecycle，服务端只接受 host-neutral Event Envelope。
- 业务层级固定为 Project → Main Task → Subtask；不支持任意深度。
- Recorder 默认 fail-open，不能因为记录服务异常而阻止 Agent 停止或用户关闭会话。
- 迁移必须可备份、可回滚、可 dry-run，宁可保留未归属数据也不能错误合并 Project / Task。

### Success Criteria

- 相同 branch 的不同 repository 不再互相成为候选。
- 一次普通 Hook heartbeat 只写 compact event，不调用 MCP，也不执行整树同步。
- 同一 execution 的 A → B → A 会形成三个 Work Segment、两个稳定 Task。
- Project / Main Task 的 actual timeline summary 必须包络全部 descendant segments。
- Task lifecycle 与 execution live state 分离：Agent 离线不会自动把 Task 标为 done。
- taskd 暂时不可用时，Hook fail-open；允许的 metadata 进入 bounded spool，并在恢复后幂等 replay。
- Dashboard 可以处理 Project 未归属与 Task 未归属两类 Inbox。
- 所有自动归属都能回答“为什么被归到这里”，且用户修正不会被下一次 heartbeat 覆盖。

## 产品语义

| 记者行为 | Tasks Recorder 概念 | 系统语义 |
| --- | --- | --- |
| 收到线索 | Observation | Host 观察到的不可变事实 |
| 辨认消息来源 | Source Session | 来源、session、turn、Agent 的关联上下文 |
| 一次出勤 | Execution | Agent 从开始到结束的一次执行生命周期 |
| 出勤中的一段工作 | Work Segment | 连续推进同一目标的实际区间 |
| 给线索归版面/报道 | Attribution | Segment 与 Task 的可解释归属 |
| 新闻版面 | Project | 稳定工作范围 |
| 一条报道 | Main Task | 独立交付目标 |
| 报道中的工作项 | Subtask | 可独立追踪的拆解 |
| 编审记录 | Task Event | Task 的语义变更与纠错历史 |
| 待核实线索 | Inbox | 不足以安全归属的事实或建议 |

关键原则是：先记录事实，后解释事实。错误归属比暂时未归属更危险。

## 领域模型

### Project 与 Project Location

Project 是稳定实体，不使用 Task status：

```ts
interface Project {
  id: string;
  name: string;
  description: string | null;
  revision: number;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

interface ProjectLocation {
  id: string;
  project_id: string;
  kind: "git_common_dir" | "workspace" | "git_remote" | "manual";
  normalized_value: string;
  display_value: string | null;
  last_seen_at: string;
  created_at: string;
}
```

规则：

- Project ID 不从 path、remote 或 name 动态推导，改名、移动目录不换 ID。
- 一个 Project 可以拥有多个 clone、worktree、workspace location。
- 精确注册的 `git_common_dir` / workspace 可以确定归属；remote 只产生合并建议，不能自动合并两个 Project。
- `git_remote` 持久化前必须移除 URL userinfo、credential 与不稳定参数。
- branch 只是 execution context，永远不能单独解析 Project。
- Project metadata 使用自己的 revision；Task tree 使用各 Task revision，避免 Project aggregate CAS 成为写热点。

Project resolution：

```text
explicit project_id
  > exact registered git_common_dir
  > exact registered workspace
  > create/retain provisional project from exact local evidence
  > project inbox

normalized git_remote -> merge suggestion only
branch                -> display/filter only
```

### Main Task 与 Subtask

```ts
type TaskLifecycle =
  | "planned"
  | "in_progress"
  | "waiting"
  | "blocked"
  | "done"
  | "canceled";

interface Task {
  id: string;
  project_id: string;
  parent_id: string | null;
  title: string;
  description: string | null;
  lifecycle: TaskLifecycle;
  planned_start_at: string | null;
  planned_due_at: string | null;
  next_action: string | null;
  sort_order: number;
  revision: number;
  completed_at: string | null;
  archived_at: string | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}
```

- `parent_id = null` 是 Main Task。
- `parent_id != null` 是 Subtask，parent 必须是同 Project 的 Main Task。
- Subtask 不允许拥有 children。
- `active` 在迁移与兼容 API 中作为 `in_progress` alias 接受，存储层只写新值。
- Task 完成、取消、阻塞是显式语义变更，不从 execution end 自动推导。
- plan 的细粒度步骤先进入 `Plan Observation`，只有确认需要长期追踪时才提升为 Subtask。

### Observation

Observation 是 append-only、host-neutral 的事实：

```ts
interface EventEnvelope {
  source: "codex" | "claude" | "dashboard" | "importer";
  event_type: string;
  external_event_id: string;
  observed_at: string;
  source_session_key: string | null;
  source_turn_key: string | null;
  source_agent_key: string | null;
  workfolder: string | null;
  git_root: string | null;
  git_common_dir: string | null;
  git_remote: string | null;
  worktree: string | null;
  branch: string | null;
  payload: Record<string, JsonPrimitive>;
}
```

约束：

- `observations` 对 `(source, external_event_id)` 建唯一约束，replay 必须幂等。
- `payload` 采用 event-type allowlist，只允许 lifecycle、计数、状态码等 metadata。
- tool use 默认 coalesce 到 execution / segment 的 `last_seen_at` 与计数；不保存原始输入输出。
- session/turn/subagent start/end、Task mutation、Attribution correction 是 durable boundary。
- `non_work` / 未归属的普通活动默认保留 30 天；已归属 Task 的事实与语义边界长期保留。保留期可配置。

### Source Session 与 Execution

```ts
interface SourceSession {
  id: string;
  source: string;
  external_session_id: string;
  root_session_id: string | null;
  project_id: string | null;
  first_seen_at: string;
  last_seen_at: string;
}

type ExecutionLiveState = "running" | "idle" | "stale" | "ended" | "interrupted";

interface Execution {
  id: string;
  source_session_id: string;
  source_turn_id: string | null;
  source_agent_id: string | null;
  parent_execution_id: string | null;
  started_at: string;
  ended_at: string | null;
  last_seen_at: string;
  end_reason: string | null;
}
```

- `session_id` 只是 correlation evidence，不是 auth token、Task ID 或全局 identity。
- `(source, external_session_id)` 才是 source session 的稳定外部键。
- Execution 保存 Agent / subagent 与 turn 生命周期，不直接拥有 `task_id`。
- `running / idle / stale` 是基于最近事件与 host signal 的 projection；长时间 reasoning 不能仅因无 tool call 被标为 interrupted。
- 明确 stop/session end 关闭 Execution；watchdog 只能先投影为 stale。只有进程消失、下次 session recovery 或明确异常证据才能落盘为 interrupted。
- `execution_id` 与 `segment_id` 本身就是 lookup handle，不再增加抽象的 `context_ref` 表。

### Work Segment

```ts
interface WorkSegment {
  id: string;
  execution_id: string;
  started_at: string;
  ended_at: string | null;
  last_seen_at: string;
  close_reason: "focus_changed" | "execution_ended" | "manual" | "recovered" | null;
  summary: string | null;
  created_at: string;
  updated_at: string;
}
```

Segment 边界来自可解释事件：

- execution start 创建首个未归属 Segment；
- Agent 或用户切换 focus 时关闭当前 Segment 并创建新 Segment；
- subagent start 创建独立 Execution，不复用父 Agent Segment；
- Stop/session end 关闭仍打开的 Segment 与 Execution；
- A → B → A 产生三个 Segment，不改写前一个 A Segment。

### Segment Attribution

```ts
type AttributionProvenance =
  | "user"
  | "agent_explicit"
  | "spawn_intent"
  | "current_focus"
  | "migration"
  | "suggestion";

interface SegmentAttribution {
  id: string;
  segment_id: string;
  task_id: string;
  provenance: AttributionProvenance;
  confidence: number | null;
  rationale_code: string;
  accepted_at: string | null;
  rejected_at: string | null;
  superseded_at: string | null;
  created_at: string;
}
```

- 一个 Segment 在任一时刻最多有一个 accepted Attribution。
- `user`、`agent_explicit`、已登记的 `spawn_intent`、同 execution 的 `current_focus` 可自动 accepted。
- 标题相似、branch 相同、remote 相同、时间相邻只能生成 suggestion，进入 Inbox。
- 用户纠正会 supersede 旧 Attribution 并写审计事件；后续 heartbeat 不能覆盖它。
- `source_agent_key` 是 Execution 属性，不写入 Task。spawn 时使用短期 `execution_intent` 把 host agent key 映射到目标 Task，消费后生成 Attribution。

### Task Event 与 Plan Observation

- `task_events` 记录 Task create/update/move/status/archive/restore 与 before/after 摘要。
- `plan_observations` 保存 plan revision、结构化 item 和来源，但不直接成为 Task tree。
- 同一 plan 的重复快照按 `(source_session, plan_revision)` 幂等更新。
- 语义 checkpoint 只提交有意义的 Task 变化，不需要在每个 turn 重写完整 tree。

## 触发与写入架构

### 角色边界

| 组件 | 责任 | 不负责 |
| --- | --- | --- |
| Host / native lifecycle | 产生真实触发点 | 判断业务 Task identity |
| Source adapter / Hook | 归一化、脱敏、spool、投递 | 直接写 SQLite、阻塞 Agent |
| taskd | 幂等接收、写事实、维护 lifecycle、投影 | 猜测复杂任务语义 |
| Agent MCP / Dashboard | 显式语义编辑、确认 Attribution | 机械 heartbeat |
| Recovery watchdog | 发现 stale、重放 spool、生成恢复证据 | 无证据地完成 Task |

### Host-neutral ingestion

```text
Native event
  -> adapter validate + redact + normalize
  -> POST /v1/events
     -> taskd dedupe Observation
     -> resolve Source Session / Project evidence
     -> advance Execution / Work Segment lifecycle
     -> apply deterministic Attribution or create Inbox suggestion
     -> publish projection change
```

Adapter 不通过 Agent 调用 MCP。MCP 专注于语义命令，例如：

- `agent_work_context(execution_id)`：返回 resolved Project、当前 focus、最多 3 个同 Project 候选及直接 children。
- `agent_work_focus(execution_id, task_id)`：显式切换 focus，形成 Segment boundary。
- `agent_tasks_mutate(...)`：创建/修改/move/完成单个 Task。
- `agent_tasks_sync_structure(...)`：仅在真实结构变化时批量提交 Task/Subtask，不用于 heartbeat 或 Stop。
- `agent_work_checkpoint(...)`：写 compact summary / next action，不携带整个 session 列表。

旧 `agent_tasks_context`、`agent_tasks_sync_tree` 在 `0.6.x` 兼容期包装到新 command，返回 deprecation metadata；新 skill 不再使用 `list + full sync_tree` 收口。legacy wrapper 最早在 `0.7.0` 移除。

### Stop 与异常策略

```text
Stop Hook
  -> 发出 execution.stop EventEnvelope
  -> taskd 可用：关闭 Segment / Execution，返回 2xx
  -> taskd 不可用：写 bounded spool，立即 exit 0
  -> spool 写入也失败：记录本地单行 error，仍 exit 0
```

- Stop 只关闭执行事实，不自动修改 Task lifecycle。
- 未提交的语义变更可以进入 reconciliation Inbox，但不能阻断 Stop。
- Hook 只允许短超时、单次投递，不做长重试、不运行 npm、不启动 taskd。
- taskd 恢复后按 `external_event_id` replay，重复事件不会重复关闭 lifecycle。

### Bounded spool

- 默认目录：`~/.config/tasks-recorder/spool/`，文件/目录权限 `0600/0700`。
- 只写经过 allowlist 与脱敏的 Event Envelope，不写 prompt 或 tool payload。
- 按文件大小与时间轮转，设总容量上限；超限先丢可 coalesce heartbeat，保留 lifecycle boundary。
- replay 成功后采用可恢复的归档/删除策略，并记录 dropped/replayed 计数。
- replay 必须区分临时失败与确定不可重试的 Event contract/identity rejection：前者恢复 claim 并等待下次重试，后者以 `0600` `.invalid` 文件隔离、增加 isolated 计数并继续后续事件，避免 poison event 永久阻塞 boundary queue。
- taskd 仍是唯一 SQLite writer，spool 不是第二数据库。

## Task lifecycle 与 live state

这两个维度必须分离：

| 维度 | 值 | 由谁改变 |
| --- | --- | --- |
| Task lifecycle | planned / in_progress / waiting / blocked / done / canceled | 用户或 Agent 的显式语义命令 |
| Execution live state | running / idle / stale / ended / interrupted | lifecycle event 与 recovery projection |

例子：

- Task `blocked` 时仍可能有 Agent `running` 在调查阻塞原因。
- Agent `ended` 后 Task 仍可保持 `in_progress`，等待下一 session 接力。
- Task `done` 后出现新 Segment 时，系统应提示 reopen / correction，而不是静默改状态。

## Timeline 与 Dashboard projection

### Planned 与 Actual 分离

- Planned：来自 `planned_start_at` / `planned_due_at`，使用 outline / marker。
- Actual：来自 accepted Attribution 对应的 Work Segments，使用实体或密度条。
- Main Task summary：`envelope(own accepted segments + descendant subtask segments)`。
- Project summary：`envelope(all descendant task segments)`。
- 无 actual segment 的 planned Task 仍显示计划；无 plan 的 actual work 仍显示实际时间。

```text
Subtask actual = union(its attributed segments)
Main Task actual envelope = min(start) ... max(end) of own + descendants
Project actual envelope = min(start) ... max(end) of all descendants
```

Summary row 是 projection，不回写 Task planned fields。这样主任务视觉上一定包含子任务的 actual scope，不会再出现父子 bar 互相交叉却不包络的错误。

### 默认 scale

- 默认视窗依据 Project actual/planned extent 自适应，并留 8%–12% 水平 breathing room。
- extent ≤ 48 小时：hour/day；≤ 21 天：day/week；≤ 120 天：week/month；更长：month/quarter。
- 用户 zoom/pan 后保持选择，不被实时刷新重置。
- 多个短并行 Segment 在较大 scale 下采用 density/stack indicator，避免每条都铺满一到两天视窗。

### Information architecture

```text
Project
  Main Task
    Subtask
```

- Project row 展示 active Main Task、running Agent、blocked 数量和 summary timeline。
- Main Task row 展示 progress、next action、lifecycle 与 descendant envelope。
- Subtask row 展示具体状态与 attributed segments。
- Execution / session 在详情 Sheet 中展示，不塞进 Task hierarchy。
- 表格保留 workspace、worktree、branch、session ID；session ID 可复制，长文本使用 tooltip / Sheet 展开。
- Project Inbox 与 Task Attribution Inbox 分开，避免“项目未知”和“工作目标未知”混为一类。

## 数据库目标结构

Schema v3 引入：

```text
projects
project_locations
source_sessions
observations
executions
work_segments
segment_attributions
execution_intents
tasks
task_events
plan_observations
```

关键完整性约束：

- tasks.project_id -> projects.id
- tasks.parent_id -> tasks.id，且 parent 同 Project、最多两层
- executions.source_session_id -> source_sessions.id
- work_segments.execution_id -> executions.id
- segment_attributions.segment_id -> work_segments.id
- segment_attributions.task_id -> tasks.id
- accepted Attribution 同一 Segment 唯一
- 一个 Execution 同时最多一个 open Segment
- Observation `(source, external_event_id)` 唯一
- 删除 Project/Task 使用 soft delete / archive；事实记录不 cascade hard delete

常用索引覆盖：

- Project tree：`tasks(project_id, parent_id, sort_order)`
- live execution：`executions(ended_at, last_seen_at)`
- session lookup：`source_sessions(source, external_session_id)`
- open segment：`work_segments(execution_id, ended_at)`
- timeline：`segment_attributions(task_id, accepted_at)` + segment time
- inbox：未 accepted Attribution / unresolved Project 的 partial index

## v2 → v3 迁移

### 原则

1. 先 backup，再在单事务中迁移；失败保留 v2 数据与 migration report。
2. 提供 dry-run，输出会创建多少 Project、未归属多少 execution、出现哪些歧义。
3. 宁可拆成 provisional Project，也不凭 name/remote 把不确定数据错误合并。
4. 现有 installer / update 绝不能覆盖 `~/.config/tasks-recorder/tasks.db`。

### 映射

- `tasks.project TEXT` + 精确的已知 local context 生成 provisional Project 与 ProjectLocation。
- 只有 project text、没有精确 location 的 Task 进入对应 provisional Project，标记待核对。
- legacy `active` → `in_progress`。
- 每条 legacy task execution 迁移为 Execution + 一个 Work Segment。
- legacy `task_id != null` 生成 `provenance = migration` 的 accepted Attribution。
- legacy 未绑定 execution 保持未归属，不依据 branch 自动绑定。
- legacy Task Event 保留，并补写迁移审计事件。

### 回滚与兼容

- 数据库 schema version 从 2 升到 3，仅在全部 migration checks 通过后落版本号。
- 迁移前 backup 文件包含时间戳与源 schema checksum。
- 新 taskd 在兼容期读取旧 API shape；旧 taskd 不允许打开已升级的 v3 database。
- CLI 提供 `migrate --dry-run` 与 `migrate --apply --backup <path>`；apply 只允许在 taskd 停止时运行，dry-run 与 apply 都输出 privacy-bounded JSON report。首次服务启动不静默迁移，也不执行有歧义的合并。

## API 与事件投影

- Command API：Task / Project / Attribution 的显式 mutation，使用 revision 做 optimistic concurrency。
- Event ingest API：只接收 Event Envelope，通过 `external_event_id` 幂等。
- Query API：按 Project 返回 compact tree、live executions、timeline extent、Inbox counts。
- Realtime：SSE 发送 projection invalidation / compact delta；客户端断线后用 revision 补拉，不通过静态 HTML 刷新。
- Status API：区分 process loaded、HTTP ready、DB writable、spool backlog、last replay error。

## Reliability、Privacy 与 Observability

### Reliability

- Hook fail-open；Dashboard / MCP mutation 返回明确错误，不假装成功。
- ingest 与 replay 都幂等；同一 external event 重放不产生重复 Segment。
- open Segment / Execution 在 taskd startup 做 consistency scan，只修复有确定证据的异常。
- 并发 mutation 使用实体级 revision；语义冲突返回 current snapshot，不做 last-write-wins。

### Privacy

- Event schema 使用 allowlist，不做“先接收完整 payload 再过滤”。
- 所有本地存储、日志与 spool 禁止原始 prompt、reasoning、tool IO 与 credential。
- path/session ID 在 Dashboard 可见是本机功能；导出时默认 redact，可由用户显式选择包含。
- auth token 仅用于非 loopback 或跨用户访问；默认 `127.0.0.1` 本机模式不把 token 暴露给 Hook 输出。

### Logs 与 metrics

结构化日志写入 `~/.config/tasks-recorder/logs/`，至少包含：

- event accepted/deduped/rejected（不含敏感 payload）；
- lifecycle transition 与 rejected transition reason；
- attribution source、rationale code 与 correction；
- spool queued/replayed/dropped；
- migration summary 与 recovery action。

核心 metrics：ingest latency、dedupe rate、unresolved project rate、unattributed segment rate、spool backlog、stale execution count、manual correction rate。manual correction rate 是自动归属质量的关键反馈，不是越低越好；需要结合 unresolved rate 解读。

## Rollout

目标模型不因最小改动妥协，但落地采用可验证阶段：

1. Schema v3 + domain stores + migration dry-run/report。
2. Host-neutral ingest、Execution / Segment lifecycle、bounded spool。
3. Attribution 与 compact semantic MCP commands，旧 tools compatibility wrapper。
4. Dashboard Project tree、双 Inbox、planned/actual timeline projection。
5. 新 Codex/Claude adapters 与 skill 切换，故障恢复、migration CLI 和 isolated package/runtime rehearsal。
6. 经用户授权后执行真实本机 migration、merge/release 与本地更新；`0.6.x` 结束后才允许删除 deprecated compatibility wrapper。

每阶段必须保留 v2 数据备份，并以契约测试、migration fixture 与浏览器视觉验证作为退出条件。

## 明确不做

- 不替代 Linear、Jira 等完整项目管理系统。
- 不支持任意深度 Task tree。
- 不保存或重放对话正文、reasoning、tool input/output。
- 不依赖大模型从每条事件自动分类 Task。
- 不用 branch、remote、标题相似度或时间邻近自动合并 Project / Task。
- 不把 heartbeat、tool call 或 subagent 一一变成 Task。
- 不在本阶段引入 cloud sync、多用户协作或远程 Dashboard。

## 关键验证场景

1. 同一 session：A → B → A，得到 3 Segment / 2 Task，timeline 不丢区间。
2. 主 Agent spawn 两个 subagent，两个 child Execution 可分别 Attribution 到不同 Subtask。
3. 两个不同 repo 都在 `main`，候选与 Project resolution 完全隔离。
4. 一个 Project 有 main checkout 与多个 worktree，Project 唯一，location 多值。
5. taskd 停止时 Stop Hook 立即成功；重启后 spool replay 且无重复 event。
6. Agent 直接关闭会话：Execution 先 stale，经 recovery evidence 后 interrupted；Task 保持原 lifecycle。
7. 用户把 Segment 从 Task A 修正到 B，旧 attribution 可审计，heartbeat 不会改回 A。
8. Subtask 实际时间超出 Main Task 自身 Segment，Main Task summary 自动扩展并包络 Subtask。
9. v2 dry-run 报告 ambiguous Project；apply 后 legacy 数据总数守恒，rollback backup 可打开。
10. ordinary chat 只形成 non_work/coalesced execution，不创建 Task、不触发整树同步。

## Johari 复核

### Open Area

- 产品角色、双平面模型、三层业务树、fail-open 与隐私边界已明确。
- v2 单值 `task_id`、branch 污染和 full-tree sync payload 是代码与运行数据中已观察的问题。
- Project summary 与 Main Task summary 必须包络 descendant actual scope。

### Hidden Area

- 用户未来是否需要 cloud / team sharing 当前不在本地证据中；本阶段不预埋复杂权限模型。
- 旧数据库中同名 Project 的真实归属只能由 migration report 与用户确认决定。

### Blind Spot

- 自动归属过于保守会堆积 Inbox；过于激进会污染历史。因此必须同时量化 unresolved 与 manual correction。
- watchdog 只看 last_seen 会误伤长 reasoning；interrupted 必须要求更强证据。
- remote 相同不代表 Project 相同，尤其 fork、mirror 与多个独立 clone。
- Project aggregate revision 会产生并发热点，故采用实体级 revision。

### Unknown Area

- spool 容量、coalesce window、stale threshold 的默认值尚无真实负载数据；先配置化并通过故障/负载测试给出默认值。
- SVAR Timeline 对 planned/actual 双层 bar 与自适应 scale 的能力需要浏览器 spike 验证；不满足时应替换 renderer，而不是扭曲领域模型。
- Codex/Claude lifecycle payload 的稳定字段需要 adapter contract fixture 持续验证。

## 审批门槛

本设计经 written spec 复核后，才进入 implementation plan。实施计划必须逐项映射本文件的 Success Criteria、迁移安全和关键验证场景；不得在 heartbeat 中恢复 `list + full sync_tree`，也不得用 `context_ref` 或 execution 直接 `task_id` 代替 Work Segment + Attribution。
