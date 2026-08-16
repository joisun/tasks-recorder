# Tasks Recorder Task Tree and Execution Lifecycle Design

> 日期：2026-08-14（Asia/Shanghai）
> 状态：Phase 1–3 已实现，v0.4.0 已发布并完成本机 service/adapter 升级；真实历史 import apply 未执行
> 适用项目：`/Users/joi-com/Desktop/space/projects/tasks-recorder`

## 目标

把 Tasks Recorder 从“Agent 主动上报少量 task + session heartbeat”升级为真正的本机多任务控制面：

1. 以一棵 `root task -> child task` 的一层 Task tree 表达要完成的工作。
2. 自动记录主线程、turn、session 与 subagent 的 execution lifecycle，但不把执行单元伪装成业务任务。
3. 允许一个 session 顺序执行多个 Task，也允许同一个 Task 跨 session 接力。
4. 让 Task 的 title、description、status 和拆解随真实目标变化持续更新，同时保留可审计历史。
5. 使用剩余数量、总数和 progress ring 展示父任务进度，不依赖颜色传达进程。
6. 通过 Codex native hooks 实时采集新数据，并提供显式、幂等、可预览的历史 session importer。

## 第一原则

- **Goal**：用户需要掌控“有哪些任务、任务如何拆解、谁正在执行、还剩多少、如何恢复”，而不是只查看 Agent 曾经活动过的时间戳。
- **Facts**：Codex 0.147.0 原生提供 `SessionStart`、`SessionEnd`、`UserPromptSubmit`、`PostToolUse`、`SubagentStart`、`SubagentStop` 和 `Stop` hooks；现有数据库已支持一层 `parent_id`，但 Task 只能靠 Agent 显式 upsert，subagent lifecycle 没有进入数据库。
- **Assumptions**：Task 是长期、可变的业务对象；session、turn、root Agent 和 subagent 都是执行上下文。仅凭 prompt 或 plan item 文本不能稳定判断 Task identity。
- **Constraints**：Task tree 首期只支持 root + 一层 child；SQLite 仍是 canonical store 且只由 `taskd` 写入；不后台扫描全部 Codex 历史；不保存 prompt 或 assistant message 正文；Codex 与 Claude adapter 继续各自维护。
- **Success Criteria**：同一 session 的 A -> B -> A 执行不会丢失；subagent execution 能绑定 Task 或进入未绑定 inbox；Task 改名不换 ID；child 变化实时更新父任务 `remaining / total`；旧 session 可手动 import；现有 v0.3.x 数据和 MCP tools 继续可用。

## 已确认的产品决策

1. Task tree 是唯一业务主模型；execution 不是 Task tree node。
2. Tree 深度固定为一层：一个 root 可有多个 child，child 不能再有 child。
3. subagent 是执行者。只有当其工作目标本身是独立工作项时，才创建或匹配一个 child Task，再把 subagent execution 绑定到该 Task。
4. 所有 child 完成后，只更新父任务 progress；父任务仍需 Agent 或用户显式完成。
5. 新 turn 先生成未绑定 execution；Agent 同步 Task tree 后再绑定。系统不根据 prompt 自动伪造 Task。
6. 历史数据采用“实时 hooks + 显式手动 import”；不做后台全量扫描。
7. 历史 execution 无法证明 Task 归属时保留未绑定，允许 Dashboard 后续分配或批量分配。
8. 删除是 soft delete；范围移除优先使用 `canceled`，不能因为某个 child 从 plan snapshot 消失就自动删除。
9. 首期完整支持 Codex adapter；service contract 保持 host-neutral，Claude adapter 后续通过自己的 native hooks 独立接入。

## 领域模型

### Task tree

Task 表达“要完成什么”。它拥有稳定 ID，但可持续修改 title、description、status、排序和父子关系。

```ts
type TaskStatus =
  | "planned"
  | "active"
  | "waiting"
  | "blocked"
  | "done"
  | "canceled";

interface Task {
  id: string;
  parent_id: string | null;
  project: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  start_date: string;
  due_date: string | null;
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

约束：

- `parent_id = null` 表示 root。
- parent 必须存在且与 child 属于同一 project。
- parent 自身不能再有 parent；child 不能拥有 children。
- 不允许 self-reference 或任何循环。
- ID 在改名、改描述、状态变化和跨 session 继续时保持稳定。
- 每个 node 的 `revision` 在自身真实 mutation 时增加一；root 的 revision 同时作为 tree revision，任何 child 创建、更新、移动、取消、归档、删除或恢复都会增加 root revision。`sync_tree.expected_revision` 始终比较 root tree revision，避免只校验 root 字段却覆盖较新的 child 变化。

### Task execution

Task execution 表达“谁在什么会话和 turn 中执行了哪个 Task”。未完成语义归属时，`task_id` 可暂时为空。

```ts
type ExecutionKind = "main" | "subagent";
type ExecutionStatus = "active" | "completed" | "interrupted" | "unknown";
type ExecutionClassification = "unknown" | "work" | "non_work";

interface TaskExecution {
  id: string;
  external_key: string;
  task_id: string | null;
  kind: ExecutionKind;
  root_session_id: string;
  session_id: string;
  turn_id: string | null;
  agent_id: string | null;
  agent_type: string | null;
  agent_path: string | null;
  parent_execution_id: string | null;
  transcript_path: string | null;
  classification: ExecutionClassification;
  workfolder: string;
  git_root: string | null;
  worktree: string | null;
  branch: string | null;
  status: ExecutionStatus;
  started_at: string;
  last_seen_at: string;
  ended_at: string | null;
}
```

定义：

- main execution 的 `session_id` 等于 root Codex session ID。
- subagent execution 的 `session_id` 在 transcript enrichment 后等于 child thread ID，`root_session_id` 指向根会话；live hook 的 `agent_id` 保留 Codex hook identity，历史 importer 在没有该 identity 时使用 child thread ID。
- `external_key` 是 host event 的幂等键；相同 hook 或 importer event 重放不会重复创建 execution。
- execution 可以先以 `task_id = null` 写入，之后原子绑定到 root 或 child。
- 新 execution 默认 `classification = unknown`；绑定 Task 时变为 `work`，用户或 Agent 明确确认普通聊天后可标记为 `non_work`。`non_work` execution 保留审计记录，但不进入未绑定计数和 Task activity。
- transcript path 只是本机恢复和历史 import 的定位 metadata；数据库不复制 transcript 正文。

### Task event

每次影响 Task tree 语义的 mutation 都记录 activity event：

```ts
type TaskEventType =
  | "created"
  | "renamed"
  | "description_changed"
  | "updated"
  | "status_changed"
  | "moved"
  | "reordered"
  | "canceled"
  | "archived"
  | "deleted"
  | "restored"
  | "execution_bound"
  | "execution_unbound";

interface TaskEvent {
  id: string;
  task_id: string;
  event_type: TaskEventType;
  before_json: string | null;
  after_json: string | null;
  actor: "agent" | "user" | "hook" | "importer";
  source_session_id: string | null;
  created_at: string;
}
```

`before_json`/`after_json` 只包含 Task metadata，不写 prompt、assistant message、token 或 transcript 内容。
`updated` 用于 due date、next action、agent key 等没有专用事件名的 metadata 变化；title、description、status、move、reorder 和 lifecycle actions 仍使用专用事件类型。

### Plan observation

Codex `update_plan` 没有 stable plan item ID，因此它只能作为“需要同步”的 observation，不能直接成为 Task tree 的 authoritative mutation。

```ts
interface PlanObservation {
  external_key: string;
  session_id: string;
  turn_id: string;
  plan_json: string;
  observed_at: string;
  reconciled_task_id: string | null;
  reconciled_revision: number | null;
  reconciled_at: string | null;
}
```

plan JSON 只保存 step title/status/explanation；它属于 Task metadata 范围，不包含用户完整 prompt。

## Task identity 与任务切换

Task identity 由交付目标决定，不由 session、turn、标题字符串或 subagent thread 决定。

### 同一个 Task 持续演化

以下情况保持 Task ID，只更新 title/description/status：

- 初始讨论叫“做 A”，后续澄清为更准确的“完成 B”，但 B 是 A 的同一交付目标。
- 实施中发现范围扩大或缩小，但旧 Task 不再需要作为独立工作项保留。
- 子任务拆解改变，但根目标没有变。

每次 title/description 更新都产生 `task_events`，Dashboard 能解释名称为何变化。

### 创建新的 root Task

以下情况创建新 root，同时保留旧 root：

- A 仍是独立、未完成或可恢复的目标，用户又开始 B。
- A 已完成，当前 conversation 继续处理新的 B。
- B 有独立完成条件、状态和历史，不应被 A 的改名覆盖。

同一个 session 可依次绑定 A、B，再回到 A；每次切换创建或结束对应 main execution。

### Child Task identity

- child 首次创建可不传 ID，由 service 生成稳定 ID并在响应中返回。
- 后续同步必须复用返回的 ID；title 改变不创建新 child。
- 从 full snapshot 省略 existing child 不产生 mutation。
- 确认不再执行的 child 必须显式同步为 `canceled`。
- 若 child 实际是另一个独立 root，使用 move mutation；不能靠删除再创建伪造历史。

## Tree progress 与父子状态

对 root 的有效 child 定义为：`deleted_at IS NULL AND status != 'canceled'`。

```text
total = 有效 child 数量
remaining = 有效 child 中 status != done 的数量
completed = total - remaining
progress = total == 0 ? null : completed / total
```

规则：

- Root 有 child 时显示 progress ring 和 `未完成 remaining / total`。
- Root 没有 child 时不显示 `0 / 0`，只显示自身文字状态。
- `archived` child 仍计入原始交付 progress；`canceled` 和 soft-deleted child 不计入。
- 任一 child 从 planned/waiting 开始执行时，可自动变为 active。
- subagent execution 结束只更新 execution，不自动把 child 标为 done。
- Root 有未完成 child 时禁止设为 done。
- 所有 child done 后，root 仍需显式完成，以保留集成、回归和交付门禁。
- Done child 重新打开时，如果 root 已 done，同一事务把 root 恢复为 active。
- active agent count 独立于 progress；它表示当前执行并发，不表示完成比例。

## Codex-native lifecycle

### Hook contract

Codex adapter 增加：

```text
SessionStart     -> register/resume root session
UserPromptSubmit -> begin main turn execution
PostToolUse      -> execution heartbeat; observe update_plan
SubagentStart    -> begin subagent execution
SubagentStop     -> end/interruption of subagent execution
SessionEnd       -> close root session executions
Stop             -> enforce pending Task tree synchronization
```

Codex 0.147.0 hook payload 可直接提供 `session_id`、`turn_id`、`agent_id`、`agent_type`、`tool_input`、`tool_response` 和 transcript path。

`SubagentStart` 的 stable payload 不直接提供 parent session ID 或 `agent_path`。Codex adapter 允许从该 child transcript 的 session metadata 做隔离式 enrichment：

- enrichment 成功：发送 `root_session_id`、parent thread、agent path。
- enrichment 失败：仍写入 child execution，但保持未绑定；不得通过时间相近或字符串相似强行猜测。
- service、MCP core 和 Claude adapter 不读取 Codex transcript 格式。

### UserPromptSubmit

1. Hook 把 session/turn/workfolder 注册到 `taskd`。
2. Service 创建或复用该 turn 的 main execution，初始可以未绑定。
3. Hook 查询当前 session 最近 Task tree、tree revision、未绑定 execution 和 pending plan observation。
4. Hook 把结构化摘要注入 Agent context，提示 Agent先调用 context，再同步 tree。
5. prompt 正文不写入 SQLite。

### Tree sync MCP

新增原子 tool：

```ts
agent_tasks_sync_tree(input: {
  session_id: string;
  turn_id: string;
  workfolder: string;
  expected_revision: number | null;
  root: {
    id?: string;
    project?: string;
    title: string;
    description?: string | null;
    status: TaskStatus;
    start_date?: string;
    due_date?: string | null;
    next_action?: string | null;
  };
  children: Array<{
    id?: string;
    title: string;
    description?: string | null;
    status: TaskStatus;
    sort_order: number;
    agent_key?: string | null;
    due_date?: string | null;
    next_action?: string | null;
  }>;
  focus_task_id?: string | null;
}): {
  root: Task;
  children: Task[];
  focused_task: Task | null;
  progress: { remaining: number; total: number; completed: number } | null;
  bound_execution: TaskExecution | null;
  reconciled_plan_observations: string[];
}
```

事务语义：

- 校验 expected revision；冲突时拒绝全部 mutation并返回最新 tree。
- 创建缺失节点、更新已存在节点、记录 task events。
- Snapshot 中缺少 existing child 不取消、不删除。
- `focus_task_id` 必须是本次 root 或其 child；成功后把当前 main execution 绑定到该 Task。
- 同一 turn 从 A 切到 B 时，结束 A execution 并创建 B execution；再次切回 A 创建新的 execution。
- 同步成功后，将该 turn 已观察到的 plan revision 标为 reconciled。
- 重复提交相同 tree 不增加 revision、不发布重复 SSE。

现有 `agent_tasks_upsert`、`complete`、`context`、`list`、`show`、`check` 继续保留。旧 upsert 继续写 Task 与 `task_sessions` compatibility projection；精确 execution 由 native lifecycle hooks 创建，只有 `sync_tree` 能一次同步完整 root/child 语义并绑定当前 turn。

### update_plan observation

`PostToolUse` 遇到 Codex native `update_plan` 时：

1. 使用 `tool_use_id` 生成幂等 external key。
2. 把 plan steps/status/explanation 写入 plan observation。
3. 标记当前 turn `sync_pending`。
4. 通过 PostToolUse additional context 提示 Agent 调用 `agent_tasks_sync_tree`。
5. 不按 step title、数组位置或相似度直接创建、改名、取消 Task。

Stop hook 只在 `taskd` 可达且存在未 reconcile observation、未绑定 concrete execution 或未收口 active Task 状态时阻止结束一次，并给出明确 sync context。普通聊天、没有 work objective 的 turn 可以由 Agent显式标记为 non-work，从而关闭未绑定 execution而不创建 Task。

### Subagent execution 绑定

每个 child Task 可选保存稳定 `agent_key`，格式适合 Codex `spawn_agent.task_name`。推荐流程：

1. 根 Agent 先 sync tree 并获得 child ID/agent key。
2. 调用 `spawn_agent` 时复用该 `agent_key`。
3. SubagentStart hook 写入 child execution，并通过 transcript metadata 取得 parent/agent path。
4. Service 只在 agent key 对 root tree 中唯一匹配时自动绑定。
5. 不唯一或无法解析时进入未绑定 inbox。
6. SubagentStop 结束 execution；根 Agent根据结果更新 child Task status/description/next action。

Root Stop hook 要求为本轮新 subagent executions 明确分配 Task 或保留为用户可见的未绑定项；不得静默丢弃。

## 新增、更新、取消、归档与删除

### 新增

- 新 root：由 Agent 对新独立目标调用 sync tree 创建。
- 新 child：由 Agent 将 confirmed plan step 放进 sync tree 创建。
- subagent spawn 本身不自动创建 Task；先有 child 或进入未绑定 execution。

### 更新

- scope/label 演化：同 ID 更新 title/description。
- plan step 继续拆清：更新 child title/description/next action。
- execution 开始：planned/waiting 可推进到 active。
- execution 结束：只更新 execution；Task done 需要结果确认。
- 所有 Agent mutation 使用 expected revision，不能覆盖 Dashboard 更新。

### 取消

- 已确认从范围移除、不会继续交付的 Task 使用 `canceled`。
- canceled child 从当前 progress denominator 中排除，但保留 events、executions 和 resume 证据。
- canceled Task 可恢复到 planned/active。

### 归档

- done/canceled Task 可归档以减少主视图噪音。
- 归档不改变 Task status、不删除 execution，也不改变原始完成历史。
- 历史视图可展开已归档 Task。

### 删除

- 删除只允许显式 Dashboard action 或用户明确要求后的 MCP action。
- Agent 不能因 plan item 消失而自动删除。
- 删除写 `deleted_at` 和 task event，不物理删除 row。
- soft-deleted Task 默认不出现在 active/history，进入可恢复的 Recently deleted view。
- 首期不做自动永久清理；用户恢复前保留 executions/events。

## Dashboard 设计

### Task tree Grid

Grid 只渲染 root/child Task：

```text
▾ 升级 Vue 2.7 与 Node 24   ◔ 未完成 3 / 7   2 agents
  ├─ 升级 Vue/compiler       done             2 executions
  ├─ 迁移 Vite config        active           1 execution
  └─ 浏览器回归              planned          0 executions
```

Root progress cell：

- progress ring 使用 SVG/HTML，可通过 stroke 表达比例，但旁边必须显示文字 `未完成 3 / 7`。
- `aria-label` 包含 root title、remaining、total、completed percentage。
- 不能只用 red/yellow/green 或 status color 传达状态。
- no-child root 显示文字 status，不渲染空 ring。

其他行信息：

- active agents 显示数字与文字，例如 `2 agents`。
- execution count 与 Task progress 分开显示。
- Session ID 列继续展示最近 execution 的完整 session ID并支持复制。
- root disclosure 控制一层 child 展开/折叠。
- status、progress、agent count 和 disclosure 都支持键盘访问与 screen reader label。

### Details sheet

选中 root 或 child 打开右侧 sheet，包含：

1. **Summary**：title、description、status、next action、due date、parent。
2. **Executions**：主线程/subagent、agent type/path、session ID、turn、状态、开始结束时间、workfolder/worktree/branch。
3. **Activity**：task events，展示 rename、description、status、move、cancel、archive、delete/restore。
4. **Actions**：编辑、添加 child、重新排序、分配 execution、取消、归档、soft delete、restore。

编辑使用 expected revision；冲突时不覆盖，刷新最新值并提示用户。

### Unassigned execution inbox

工具栏显示 `未绑定 N`：

- 点击打开 execution list。
- 支持按 root session、时间、agent path 过滤。
- 支持单项或批量分配到 root/child。
- 分配产生 `execution_bound` event 和一次 SSE change。
- 用户可以把普通聊天 execution 标记为 non-work；该 execution 保留但不计入 Task activity。

### Timeline

- 现有 Task Timeline 继续展示 Task 的 start/due/completed 范围。
- Details sheet 的 Executions section 展示精确 execution 时间段。
- 本轮不把 session/subagent 伪装为 Gantt Task rows，避免破坏 Task tree。
- Timeline 折叠、分隔线拖拽和当前 UI state persistence 保持现有行为。

## 历史 Codex importer

CLI：

```bash
tasks-recorder import codex --session <session-id> --dry-run
tasks-recorder import codex --session <session-id>
```

行为：

1. 只在用户显式调用时执行。为 exact-match root 并发现 direct children，会读取 `~/.codex/sessions` 下各 transcript 的 bounded `session_meta` prefix；完整 lifecycle parsing 只针对选定 root 与其 direct child transcripts，不做后台 import。
2. dry-run 输出将新增/更新/跳过的 root turn、subagent execution、已知 Task 关联和未绑定数量。
3. apply 使用单事务和 external keys，重复执行不会产生重复 execution/events。
4. 不改现有 Task title/status，不删除任何数据。
5. 只读取 lifecycle metadata；不把 prompt、reasoning、assistant message 或 tool output 写入 SQLite。
6. 能通过现有 `task_sessions` 或精确 task event 证明归属时绑定；其余保持未绑定。
7. transcript 缺失或格式不识别时返回结构化 warning；任一 normalized batch 校验或 identity conflict 都会 rollback，不留下半次 import。
8. store 边界只接受一层 execution 关系：带 parent 的记录必须是 subagent，且 parent 必须是同一 root session 的 main execution；跨 root、nested subagent 和 main-with-parent batch 会在写入前整体拒绝。

对 session `019fa297-4567-7bf0-a69a-84fd23b3aaab` 的验收基线：

- parser-only dry-run 实测识别 180 个 root turns、98 个实际 started child threads，共 278 个唯一 external keys；其中 7 次 spawn 明确失败并作为 warning，不伪造 child execution。
- 保留现有 3 个 root Task。
- 不通过时间范围强制把 98 个 executions 归到任一 root。
- apply 后 Dashboard 显示这些 execution，并允许批量分配。

## HTTP、MCP 与 CLI contract

新增 host-neutral lifecycle HTTP routes：

```text
POST  /api/v1/lifecycle/session-start
POST  /api/v1/lifecycle/turn-start
POST  /api/v1/lifecycle/tool-use
POST  /api/v1/lifecycle/subagent-start
POST  /api/v1/lifecycle/subagent-stop
POST  /api/v1/lifecycle/session-end
GET   /api/v1/sessions/:id/context
GET   /api/v1/executions?task_id=&session_id=&unassigned=
PATCH /api/v1/executions/:id/task
PATCH /api/v1/executions/:id/classification
PATCH /api/v1/executions/tasks
POST  /api/v1/tasks/sync-tree
PATCH /api/v1/tasks/:id
POST  /api/v1/tasks/:id/archive
POST  /api/v1/tasks/:id/delete
POST  /api/v1/tasks/:id/restore
POST  /api/v1/import/executions
```

所有 mutation：

- 只接受 loopback JSON request。
- 普通 JSON mutation 使用 64 KiB body limit；normalized historical import route 使用独立的 8 MiB limit，并继续受最多 10,000 records 的 store validation 约束。
- task mutation 要求 expected revision。
- lifecycle mutation 要求 external key 并保证 idempotent。
- 一个事务只发布一次 SSE changed event。

新增 MCP tools：

```text
agent_tasks_sync_tree
agent_tasks_update
agent_tasks_archive
agent_tasks_restore
agent_task_executions_list
agent_task_execution_assign
```

不新增默认 hard-delete tool；soft delete 必须携带显式确认字段和 expected revision，并在 skill 中限制为用户明确要求时使用。

## Schema migration 与兼容性

数据库从 schema v1 升级到 v2：

- 非破坏迁移 existing `tasks`、`task_sessions`。
- 增加 description、sort/revision、archive/delete metadata 和 canceled status。
- 新建 `task_executions`、`task_events`、`plan_observations`。
- 不根据旧 `task_sessions` 自动制造虚假的精确 execution 区间。
- v1 rows 默认 `description = null`、`sort_order = 0`、`revision = 1`、archive/delete null。
- v0.3.x MCP inputs 继续有效；缺少 turn ID 时，upsert 只更新 Task/task_sessions，并在能唯一确定当前 turn 时绑定 execution。
- migration 在 transaction 内执行；失败时回滚并让 `/health/ready` 返回 schema error。

Installer 仍不覆盖 `~/.config/tasks-recorder/tasks.sqlite`。升级验证必须包含真实 v1 fixture 的 migration 和回滚测试。

## 安全与隐私

- Server 继续只监听 `127.0.0.1`。
- 不保存 prompt、reasoning、assistant message、tool output、token 或 secret。
- transcript path 是本机 metadata，只通过 details API 返回给同一 loopback client。
- 历史 importer 只读取用户指定 session，不后台遍历并导入全部 history。
- Codex transcript parser 放在 Codex adapter/importer，不能进入 service domain layer。
- UI 对 title、description、agent path、workfolder 等字符串全部 escape。
- task events 中不记录敏感 hook payload；只记录 Task metadata diff。

## 错误处理

| 场景 | 结果 |
| --- | --- |
| Hook 重放 | external key 命中，返回原 execution，不重复发布 SSE |
| Hook 无法解析 parent transcript | 写入未绑定 execution，记录 enrichment warning，不阻塞 Codex |
| taskd unavailable | lifecycle hook fail-open；Stop 报告 service unavailable，不写替代文件 |
| Tree revision 冲突 | `409 TASK_VERSION_CONFLICT`，返回最新 root/children/revision |
| focus 不属于 root tree | `400 TASK_FOCUS_INVALID`，整个 sync 回滚 |
| parent/child 层级非法 | `409 PARENT_DEPTH_INVALID`，整个 sync 回滚 |
| Root 有未完成 child 却设 done | `409 CHILD_TASKS_INCOMPLETE` |
| execution 已被其他页面分配 | `409 EXECUTION_ASSIGNMENT_CONFLICT` |
| Import transcript 缺失 | dry-run/apply 报告 skipped file；apply 不提交半次 import |
| 重复 tree snapshot | no-op，不增加 revision，不发布 SSE |

## 测试策略

### Store 与 migration

- v1 fixture 原样迁移到 v2，Task/session 数据不丢失。
- root/child 一层约束、自引用、跨 project、child 再嵌套均被拒绝。
- title/description 改名保持 ID并记录 event。
- canceled/archive/delete/restore 与 progress denominator 一致。
- A -> B -> A 产生三个 execution 区间，不覆盖旧区间。
- execution idempotency、绑定冲突和 revision conflict。

### Service/API/MCP

- sync tree 原子创建、更新、focus 和 plan reconciliation。
- omitted child 不删除；显式 canceled 才改变范围。
- child start 更新 active，child stop 不自动 done。
- parent done gate 与 reopen cascade。
- lifecycle routes body/host/origin/error mapping。
- 旧 upsert/context/complete/list/show contract 回归。

### Codex adapter

- 使用 Codex 0.147.0 hook fixtures 验证所有 lifecycle payload。
- Subagent transcript enrichment 成功、缺失、损坏三种路径。
- update_plan observation 与 Stop pending-sync feedback。
- hook network/error timeout fail-open。
- Codex/Claude adapters 保持独立 manifest、hooks 和 bundles。

### Importer

- dry-run 不写数据库。
- 同一 session 两次 apply 结果一致。
- root/child transcript 缺失时事务边界正确。
- 不把 prompt/message/tool output 持久化。
- generated fixture 与 `019fa297...` parser-only real audit 均识别 98 个 unique started child executions。

### Dashboard

- root/child tree 展开折叠。
- progress ring 和 `remaining / total` accessible text。
- status 与 progress 不依赖颜色。
- details sheet 的 Task、Executions、Activity 和 Actions。
- 未绑定 count、筛选、单项/批量分配。
- rename/edit/cancel/archive/delete/restore 的 optimistic conflict。
- Session ID 完整显示、复制和 resume context。
- SSE refresh 保留 tab、tree open state、sheet selection、Grid/Timeline 宽度。

## 分阶段交付

### Phase 1：Task tree correctness

- 已完成：schema v2、Task metadata/events/progress。
- 已完成：`agent_tasks_sync_tree` 与 task mutation contracts。
- 已完成：update_plan observation 与 Stop reconciliation gate。
- 已完成：Dashboard progress ring、count、Task details/edit actions。

### Phase 2：Execution lifecycle

- 已完成：session/turn/subagent native hooks。
- 已完成：task executions、focus/binding、未绑定 inbox。
- 已完成：details sheet execution history。

### Phase 3：历史 import

- 已完成：Codex transcript parser 与 explicit CLI importer。
- 已完成：dry-run/idempotency/partial conflict rollback。
- 已完成：`019fa297...` parser-only 实际历史 session 验证与批量分配 UI；真实数据库 apply 尚未授权，也未执行。

三个 phase 属于同一领域设计，但每个 phase 都必须保持可运行、可迁移、可回归。实现完成不等于旧 session 已回填：只有用户显式执行非 dry-run importer 后，历史 executions 才会进入真实数据库。

## 文档同步

实现时必须同步：

- `README.md` How it works、data model、Codex minimum version、update/import 命令。
- Dashboard architecture/design 文档中的 snapshot 和 Grid contract。
- public MCP tool list 与 adapter hook list。
- release/install 文档中的 schema migration 与 rollback 说明。

## Johari 风险检查

### Open Area

- Task 是 root + 一层 child 的 canonical tree。
- execution/session/subagent 从属于 Task 或进入未绑定 inbox。
- progress 使用 remaining/total + ring，不靠颜色。
- 父任务不因 child 全 done 自动完成。
- 历史采用显式 importer，不后台全扫。

### Hidden Area

- 不同用户对“同一交付目标演化”与“新独立 Task”的边界可能不同，因此保留 Dashboard 改名、移动和重新分配能力，不能把 Agent 语义判断当成不可纠正事实。

### Blind Spot

- Codex stable Subagent hook 不直接包含 parent session/agent path；adapter enrichment 必须隔离、容错并可回归。
- `update_plan` 没有 stable item ID；直接用文本 reconcile 会破坏 Task identity，因此只作为 sync observation。
- subagent 完成不等于 Task 完成，自动 done 会跳过 review/集成。
- 自动删除会破坏多任务控制工具最重要的历史和可恢复性。

### Unknown Area

- transcript metadata 在未来 Codex 版本可能变化。实现需要 versioned parser fixture、unknown-version fallback 和 importer dry-run；无法解析时保持未绑定而不是错误归属。

## 参考依据

- OpenAI Codex 0.147.0 hook schemas：[SubagentStart](https://github.com/openai/codex/blob/rust-v0.147.0/codex-rs/hooks/schema/generated/subagent-start.command.input.schema.json)、[SubagentStop](https://github.com/openai/codex/blob/rust-v0.147.0/codex-rs/hooks/schema/generated/subagent-stop.command.input.schema.json)、[PostToolUse](https://github.com/openai/codex/blob/rust-v0.147.0/codex-rs/hooks/schema/generated/post-tool-use.command.input.schema.json)、[UserPromptSubmit](https://github.com/openai/codex/blob/rust-v0.147.0/codex-rs/hooks/schema/generated/user-prompt-submit.command.input.schema.json)。
- OpenAI Codex hook runtime 的 root/subagent dispatch：[hook_runtime.rs](https://github.com/openai/codex/blob/rust-v0.147.0/codex-rs/core/src/hook_runtime.rs)。
- Linear parent/sub-issue 与可选 parent auto-close：[Parent and sub-issues](https://linear.app/docs/parent-and-sub-issues)。
- Linear delete/archive/restore 语义：[Delete and archive issues](https://linear.app/docs/delete-archive-issues)。

以上外部依据访问日期均为 2026-08-14。
