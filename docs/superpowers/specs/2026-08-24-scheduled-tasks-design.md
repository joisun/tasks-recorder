# Tasks Recorder Scheduled Tasks v1 设计

> **Historical / superseded (2026-08-27)**：本文记录已退役的 per-Schedule `launchd` / runner 方案，不是现行实现。当前架构见 [`README.md`](../../../README.md) 与 [`Runtime Agent Registry 设计`](./2026-08-27-runtime-agent-registry-design.md)。

> **Superseded（2026-08-25）**：本文件保留首次交付的历史设计。当前 Schedule definition 已迁移为 Markdown source of truth，SQLite 仅保留 Run ledger；现行设计见 [`2026-08-25-file-native-scheduled-tasks-design.md`](./2026-08-25-file-native-scheduled-tasks-design.md)。

> 日期：2026-08-24（Asia/Shanghai）
> 状态：written spec，等待用户复核
> 实施分支：`feature/scheduled-tasks`
> 目标：在 Dashboard 增加独立的 Scheduled 视图，并让 macOS 能可靠地按计划启动无人值守的 Codex 工作、记录运行结果并进入 Review queue。

## 结论

Scheduled Tasks 作为与记者模型并列的 **Automation control plane**，不进入 Project → Main Task → Subtask 语义树：

```text
Recorder plane
Host Hook -> Observation -> Source Session -> Execution -> Work Segment -> Attribution -> Task

Automation plane
Schedule -> launchd wake-up -> Scheduled Runner -> Codex Thread -> Scheduled Run Review
                                                   |
                                                   +-> Host Hook records the run in Recorder plane
```

系统采用以下职责划分：

- `launchd` 只负责 durable wake-up，不保存 Prompt，不访问数据库，不判断业务状态。
- `taskd` 是 Schedule 定义、Run ledger 与 scheduler desired state 的唯一 SQLite writer。
- 独立 `scheduled-runner` 负责 no-overlap、Codex 子进程监督、timeout、日志与完成回报。
- Dashboard 的 Scheduled 视图负责创建、编辑、暂停、手动运行与 Review，不复用 Project / Attribution Inbox。
- 每个 v1 Run 创建新的 standalone Codex thread；现有 Hook 会像记录普通 Codex Session 一样记录它。

该方案借鉴 `opencode-scheduler` 的 OS-native scheduler、supervisor、lock、timeout、logs/run history 分层，但不复制其 JSON source-of-truth、单文件 monolith、manual run 绕过 supervisor 或 best-effort rollback。

## 依据

### 已核验事实

- OpenAI 官方 Scheduled Tasks 文档将 Scheduled 定义为 active/paused/completed Tasks 与 recent runs 的统一入口；本地任务需要电脑和 Desktop App 运行，支持 local project/worktree、model/reasoning、skills、Review inbox 与 RRULE advanced schedule。
- OpenAI 官方说明 unattended Scheduled Tasks 使用 sandbox，并在组织策略允许时使用 `approval_policy = "never"`。
- 本机 `codex-cli 0.149.1` 提供稳定的 `codex exec --json --cd <dir> --sandbox <mode>` 非交互入口；Prompt 可以从 stdin 读取，首个 JSONL 事件包含 `thread.started.thread_id`。
- 当前 Tasks Recorder 安装仅支持 macOS，`taskd` 已由 LaunchAgent `KeepAlive` 管理，release 使用 `~/.local/share/tasks-recorder/current` stable symlink。
- macOS `launchd.plist(5)` 明确说明：`StartCalendarInterval` 会在休眠唤醒后补触发，并把多次错过的触发合并为一次；`StartInterval` 会漏掉休眠期间的触发。
- 当前记者模型约束是 `taskd` 为 canonical SQLite owner，Hook fail-open，Dashboard 通过 REST + SSE 读取 authoritative state。

### 来源

- [OpenAI Scheduled Tasks](https://developers.openai.com/codex/app/automations)（访问：2026-08-24）
- [Introducing the Codex app](https://openai.com/index/introducing-the-codex-app/)（访问：2026-08-24）
- [`openai/codex` exec JSONL contract](https://github.com/openai/codex/blob/main/codex-rs/exec/src/exec_events.rs)（访问：2026-08-24）
- [`different-ai/opencode-scheduler`](https://github.com/different-ai/opencode-scheduler/tree/cd0b62364792f53e8687db53bc2c2c0261c9cf17)（源码快照：`cd0b62364792f53e8687db53bc2c2c0261c9cf17`）
- 用户提供的架构分析附件：`pasted-text-1.txt`（读取：2026-08-24）

## 第一原则

### Goal

用户应能把一个清晰、可重复的 Codex 工作交给本机后台执行，并在 Dashboard 中回答：

1. 有哪些定时任务，何时再次执行？
2. 哪些处于 Active / Paused / scheduler error？
3. 最近一次是否真正启动 Codex、运行多久、结果是什么？
4. 运行是否需要人工 Review，能否恢复对应 Codex thread？
5. 睡眠、重启、并发触发或 taskd 短暂不可用时发生了什么？

### Constraints

- macOS v1，backend 明确标识为 `launchd`，不虚假宣称跨平台等价。
- `taskd` 继续是所有 Tasks Recorder SQLite 的唯一 writer。
- Prompt、workspace、sandbox spec 不进入 plist、process argv 或普通 structured logger。
- Dashboard 不能提交任意 command；runner 只执行 allowlisted Codex invocation。
- unattended 默认 `read-only`；扩大权限必须由用户对每个 Schedule 显式选择。
- 不自动使用 bypass approvals/sandbox/hook trust。
- Schedule edit/delete、taskd restart、runner crash 与 Run now 必须保持可恢复、可解释。
- Scheduled Run 是事实，不自动创建或完成语义 Task。

### Success Criteria

- 从 UI 创建一个 2–3 分钟后的 Schedule，真实经过 launchd 唤醒并产生 Codex thread。
- Run 的 `thread_id`、状态、duration、final message 与 bounded logs 可在 Scheduled Review 查看。
- 对应 Codex Session 被现有 Hook 记录，Review 中可 Resume。
- 同一 Schedule 的 scheduled trigger 与 Run now 竞争时，最多一个 Codex process 运行，另一个记录为 `skipped_overlap`。
- 睡眠错过多个 occurrence 后最多 catch up 一次；Pause 后不再执行；Edit 只影响下一 Run。
- taskd restart、runner crash、Codex timeout、Codex path/auth failure 均有稳定状态与诊断，不出现永久 `running`。
- Dashboard Tasks / Scheduled 切换、创建/编辑/Review 在桌面与窄屏完成视觉和交互验证。

## 方案选择

### A. 复用 Codex Desktop 私有 Automation storage/API

不采用。内部 action 与存储不是公开稳定 contract，会强依赖 Desktop App 版本和 capability registration；Tasks Recorder 也无法独立安装、测试与发布。

### B. 在 taskd 中使用普通 timer

不采用。实现简单，但 timer 自身不提供 durable registration，睡眠/重启期间触发语义弱，也把执行监督和 API 进程生命周期绑在一起。

### C. launchd wake-up + taskd control plane + independent runner

采用。OS 负责时间，taskd 负责 desired state 与事实，runner 负责进程生命周期；每层都可独立测试与恢复。

## 产品范围

### v1 包含

- nav 最左侧 `Tasks / Scheduled` 双态 view switch。
- Scheduled 页面：Search、All / Active / Paused、未读 Review、New scheduled task。
- Schedule 创建与编辑：Title、Prompt、Workspace、cadence、sandbox、model、reasoning effort、timeout。
- Cadence：One time、Hourly、Daily、Weekdays、Weekly、Monthly，均使用 system timezone。
- Enable/Pause、Run now、Edit、Soft delete。
- Run history、final message、bounded log tail、Mark reviewed、Resume Codex thread。
- no-overlap、timeout、sleep/wake coalescing、startup reconciliation、completion spool。
- launchd capability/health/sync error 可见。

### Out of Scope

- 在同一个 Codex thread 中反复 heartbeat/resume。
- event/webhook/cloud trigger。
- Windows Task Scheduler、systemd、cron backend。
- 自动创建、归档或清理 Git worktree。
- arbitrary shell command、任意 environment snapshot、secret 管理。
- 自动 retry Codex Agent 工作。
- macOS Notification Center；v1 的 Review queue 只在 Dashboard 内。

数据模型预留 `thread_mode` 与 backend capability 字段，但 v1 只接受 `thread_mode = "new"`、`backend = "launchd"`。

## 存储边界

### 独立 scheduler database

新增：

```text
~/.config/tasks-recorder/
├── tasks.sqlite                 # 记者模型 canonical store
├── scheduler.sqlite             # Automation desired state + run ledger
├── schedules/
│   ├── locks/                   # per-schedule OS locks
│   ├── logs/<job>/<run>.jsonl   # codex stdout JSONL
│   ├── logs/<job>/<run>.stderr.log
│   └── spool/                   # bounded runner completion/dispatch evidence
└── runtime/taskd.sock           # internal control socket
```

选择独立 database 的原因：

- Schedule/Run 是 operational control state，不是 Project/Task 语义。
- 可以独立演进 schema，不要求现有 schema-v3 journal 做一次高风险迁移。
- scheduler database 损坏时可令 Scheduler degraded，而 Recorder 仍可读写。
- 两个 database 仍只由同一个 `taskd` 进程打开；runner 不直连任何 SQLite。

代价是无法做跨库 foreign key。`scheduled_runs` 保存 `(source = "codex", external_session_id)`，API 通过 eventual lookup 关联 `source_sessions`，不伪造原子一致性。

### `scheduled_jobs`

核心字段：

| 字段 | 语义 |
| --- | --- |
| `id` | stable UUID；不从 title/path 推导 |
| `title` / `prompt` | 用户定义，均不进入普通日志 |
| `workspace` | canonical absolute existing directory |
| `cadence_json` | allowlisted structured schedule；不保存任意 launchd fragment |
| `timezone_mode` | v1 固定 `system` |
| `thread_mode` | v1 固定 `new` |
| `sandbox_mode` | `read-only` / `workspace-write` / `danger-full-access` |
| `model` / `reasoning_effort` | nullable 表示使用 Codex 默认 |
| `timeout_seconds` | 默认 7200，设上下界 |
| `enabled` / `deleted_at` | desired lifecycle；delete 为 soft delete |
| `revision` | optimistic concurrency |
| `schedule_generation` | launchd desired state generation |
| `sync_state` / `sync_error_code` | `pending/synced/error/unsupported` |
| `next_run_at` / `last_run_at` | taskd authoritative projection |
| `created_at` / `updated_at` | UTC ISO-8601 |

### `scheduled_runs`

核心字段：

| 字段 | 语义 |
| --- | --- |
| `id` / `job_id` | stable run identity |
| `job_revision` / `spec_json` | claim 时固化的 immutable execution snapshot |
| `trigger` | `scheduled/manual/catchup` |
| `scheduled_for` | occurrence instant |
| `status` | `claimed/running/succeeded/failed/timed_out/canceled/skipped_overlap/lost` |
| `run_nonce_hash` | 防止旧 runner 完成新 claim |
| `thread_id` | 从 `thread.started` 解析的 Codex external session id |
| `started_at` / `heartbeat_at` / `finished_at` | crash/lease recovery evidence |
| `exit_code` / `error_code` | bounded diagnostics |
| `final_message` | Review 内容；本机 0600 storage，不进入 structured logger |
| `stdout_log_path` / `stderr_log_path` | data directory 内的 validated relative path |
| `reviewed_at` | Review inbox unread/read 状态 |

数据库对同一 `job_id` 的 active statuses 建 partial unique index。DB lease 不能单独证明进程死亡；stale recovery 结合 OS lock、PID、run nonce 与 heartbeat。

## Schedule 语义

### Structured cadence

Browser 只能提交以下 allowlisted shape；taskd 负责验证与 server-side summary/next occurrence：

```ts
type Cadence =
  | { kind: "once"; at: string }
  | { kind: "hourly"; minute: number }
  | { kind: "daily"; hour: number; minute: number }
  | { kind: "weekly"; weekdays: number[]; hour: number; minute: number }
  | { kind: "monthly"; day: number; hour: number; minute: number };
```

- `weekdays` 使用 ISO 1–7，adapter 转换为 launchd 1–7/Sunday semantics。
- v1 的 timezone 是当前 system local time；UI 同时展示 human summary 与 absolute `next_run_at`。
- Monthly day 在短月份不存在时跳过，不移动到月末。
- One time 只能选择未来且不超过 366 天；首次 accepted claim 后自动 disabled。
- 不暴露原始 cron/RRULE，避免 UI summary、server next-run 与 OS backend 三套解析器漂移。

### Missed-run policy

- `StartCalendarInterval` 休眠期间错过的多个 occurrence 由 launchd 合并为一次。
- taskd 用 `next_run_at` 和 claim time 判定 `scheduled_for`，最多产生一次 `catchup`。
- 不回放每一个错过的 occurrence，避免醒来后并发执行大量重复 Agent 工作。
- 机器关机期间的 trigger 不能被 launchd 保证；taskd startup reconciliation 对最近一个 due occurrence 进行同样的单次 catchup 判定。

## launchd desired-state reconciliation

每个 enabled Schedule 对应：

```text
~/Library/LaunchAgents/com.joi.tasks-recorder.schedule.<safe-id>.plist
```

plist 只包含：

- owned Label；
- 安装时验证并固定的 absolute Node path；
- stable `~/.local/share/tasks-recorder/current/server/scheduled-runner.mjs`；
- Schedule ID；
- `StartCalendarInterval`；
- background process/log policy。

Prompt、Workspace、Codex path、sandbox 与 model 均不进入 plist。

更新流程：

1. taskd transaction 先提交 desired state，递增 `schedule_generation`，写 `sync_state = pending`。
2. reconciler 生成 allowlisted plist，先写同目录 temporary file，再 atomic rename。
3. 使用 `launchctl bootout/bootstrap` 应用；成功写 `synced`，失败写 bounded `sync_error_code`。
4. taskd startup 和 Schedule mutation 后都执行 reconciliation。
5. cleanup 只处理严格 Label prefix、owned ProgramArguments 且属于本数据库 known IDs 的 unit。

系统不通过回滚一份文件假装 DB/launchd 原子一致；drift 始终可见并可修复。

## Internal runner protocol

Dashboard 继续使用 loopback HTTP；runner 使用：

```text
~/.config/tasks-recorder/runtime/taskd.sock
directory mode 0700
socket mode 0600
```

内部协议只提供：

- claim schedule run；
- report overlap skip；
- heartbeat lease；
- complete/timeout/failure；
- replay bounded runner spool。

执行顺序固定：

1. runner 以 `open(..., "wx")` 获取 per-job OS lock，写 PID、nonce、started_at。
2. 锁忙时不启动 Codex，向 taskd 或 spool 记录 `skipped_overlap`。
3. 通过 Unix socket claim；taskd transaction 创建 Run，固化 Job revision/spec，返回 raw nonce 与 spec。
4. runner 验证 Codex absolute executable、Workspace 与 log paths。
5. runner 使用 `spawn(..., { shell: false, detached: true })` 创建独立 process group。
6. Prompt 通过 stdin 写入；stdout 逐行校验/保存 JSONL，stderr 单独保存。
7. 解析首个 `thread.started.thread_id`；周期 heartbeat 续租。
8. timeout 先向 process group 发送 TERM，grace 后 KILL；`finally` 上报 terminal result。
9. taskd 不可达时，把 bounded completion evidence 原子写入 0600 spool；startup replay 幂等收口。
10. 释放 lock；lock stale 不能只凭时间删除，必须同时验证 PID/nonce/DB run evidence。

`Run now` 走相同 runner/supervisor，不允许绕过 lock、timeout 或 logs。

## Codex invocation contract

允许的 invocation 由 taskd 构造，runner 不接收 browser command：

```text
<absolute-codex> exec
  --json
  --color never
  --sandbox <read-only|workspace-write|danger-full-access>
  --cd <workspace>
  -c approval_policy="never"
  [--model <catalog-validated slug>]
  [-c model_reasoning_effort="<model-supported value>"]
  -
```

- `shell: false`，args 为数组；Prompt 仅 stdin。
- 不使用 `--dangerously-bypass-approvals-and-sandbox` 或 `--dangerously-bypass-hook-trust`。
- admin requirements 不允许 `approval_policy = "never"` 时，Run 以可诊断配置错误失败，而不是偷偷提升权限。
- Codex path 在 installer/control flow 中从交互式安装环境探测并保存 absolute path；Dashboard 显示 path/auth/version preflight 状态。
- taskd 以该 canonical executable 的 shell-free `codex debug models` 作为唯一 Model catalog，过滤 hidden entries 并短时缓存；Browser 只接收 bounded visible metadata。Markdown 与 immutable Run snapshot 不复制易过期的 Model 枚举，实际 compatibility 在 Schedule mutation/resume preflight 检查。
- 不 snapshot 任意环境变量或 secrets。runner 继承最小 LaunchAgent environment；项目专用环境由 Codex/项目自身配置负责。

## API contract

Public loopback routes：

```text
GET    /api/v1/schedules
GET    /api/v1/codex/models
POST   /api/v1/schedules
POST   /api/v1/scheduler/reconcile
GET    /api/v1/schedules/:id
PATCH  /api/v1/schedules/:id
POST   /api/v1/schedules/:id/pause
POST   /api/v1/schedules/:id/resume
POST   /api/v1/schedules/:id/run
DELETE /api/v1/schedules/:id
GET    /api/v1/schedules/:id/runs
GET    /api/v1/scheduled-runs/:id
GET    /api/v1/scheduled-runs/:id/log?stream=stdout|stderr&tail=<bounded>
POST   /api/v1/scheduled-runs/:id/review
POST   /api/v1/scheduled-runs/:id/resume
```

- Job mutations 使用 revision；Run now 使用 durable idempotency key。Mark reviewed 是仅允许 `null -> timestamp` 的单调、天然幂等 mutation，因此不引入无意义的 Run revision；重复请求返回当前事实且不发布 SSE invalidation。
- `POST /api/v1/scheduler/reconcile` 是 loopback control-plane operation：body 必须为 `{}`；taskd 逐 Job retrySync，单个失败以 bounded `{id,reconciled,error_code}` 返回且不会阻断其他 Job。仅存在 Job sync/revision/next-run 实际变更时发布 SSE invalidation。
- `GET /api/v1/schedules` 的每个 Job 额外包含 bounded `unread_run_count` 与 `last_run = {id,status,finished_at,reviewed_at}|null`，用于 list/review inbox；不返回 Prompt、spec、thread ID 或 log path。
- 返回 typed error，不泄漏 Prompt、absolute log path、nonce 或 raw stderr。
- Schedule change 与 Run state change 在 commit 后发布现有 SSE `changed` invalidation；Scheduled client 再 fetch authoritative data。
- `/health/ready` 继续代表 Recorder 核心可用；Scheduler 损坏/unsupported 进入 diagnostics `degraded`，不会拖垮 Recorder API。

## Run state machine

```text
                  +-------------------+
trigger ----------> claimed ----------> running
   |              +-------------------+    |
   | lock busy                             +--> succeeded
   +----------------> skipped_overlap      +--> failed
                                            +--> timed_out
                                            +--> canceled
                                            +--> lost
```

- Pause 只阻止 future claim，不取消 active Run。
- Edit 只影响下一个 claim；active Run 使用 immutable spec snapshot。
- Delete 是 soft delete并移除 future unit；Run history 保留。
- Cancel 是 Run action；v1 可以在 UI 延后暴露，但 domain/API 不把它与 Pause 混为一谈。
- lease 到期只生成 stale candidate；必须结合 lock/PID evidence 才可写 `lost`。

## Dashboard UX

### Global nav

nav 最左侧新增紧凑的双态 switch：

```text
[ Tasks | Scheduled ]  [任务状态 tabs ...]                          [Settings]
```

- `role=tablist` + roving tabindex；图标带可见 label，不做只有 tooltip 的神秘 icon。
- `Tasks` active 时保留现有 Gantt/Timeline。
- `Scheduled` active 时隐藏 Task status tabs、Inbox、Timeline zoom/labels/today，右侧 Settings 保留。
- 用户偏好只保存在 localStorage；URL/hash 可在后续增加，不作为 v1 source of truth。

### Scheduled list/review

页面是 review inbox，而不是另一个 Gantt：

- Header：`Scheduled Tasks`、active count、unread count、`New scheduled task`。
- Search + `All / Active / Paused`。
- Row：Title、cadence summary、Workspace、Next run、Last result、Unread、Enabled toggle。
- 默认排序：需要 Review 的失败/完成 Run优先，其次 Active 的 `next_run_at`，再 Paused 的 `updated_at`。
- Empty state 明确解释电脑需开机、Scheduler 为本机运行，并提供创建入口。
- Loading/error/unsupported/sync error 都有专门状态，不显示空白页。

### Editor

使用右侧 Sheet 或 modal dialog，与现有 Settings/Details 的视觉语言一致：

- General：Title、Prompt、Workspace。
- Schedule：cadence builder、system timezone label、next-run preview。
- Permissions：默认 read-only；workspace-write/full access 有逐级风险说明。
- Runtime：model、reasoning、timeout；默认值可继承 Codex config。
- 创建前 preflight：Workspace、Codex binary/version/auth、backend capability。
- Save 后即使 launchd sync 失败也保留 definition，并在列表显示 `Needs attention` 与 Retry。

### Run review

- History 展示 trigger、status、scheduled/start/end、duration、thread id、review state。
- 成功与失败都可进入 unread Review；用户可 Mark reviewed。
- final message 作为主内容；stdout/stderr 只按 bounded tail 展示。
- 有有效 transcript 的 `thread_id` 提供 Resume，复用 Settings 中的 terminal adapter 和 transcript validation。
- Scheduled Review 不复用 Project/Attribution Inbox，避免把“结果待看”和“事实归属待修复”混为一谈。

## Recorder integration

- `codex exec` 使用正常 Codex config 与已信任 Hook；runner 不 bypass Hook trust。
- Hook 产生的 Source Session/Execution 进入现有 Recorder plane。
- `scheduled_runs.thread_id` 与 `(source = codex, external_session_id)` eventual correlation。
- Schedule 不自动创建 Task，也不自动把任何 Task 标成 done。
- 如果 Agent 明确通过现有 MCP/focus 操作推进 Task，Attribution 仍按记者模型规则建立。
- Dashboard 可在 Run detail 中显示关联 Project/Task，但无关联不是 Run 失败。

## 安全与隐私

- Browser 只提交 typed Schedule fields；不提交 argv、shell、plist 或 absolute log path。
- Public HTTP 保持 loopback Host/Origin guard；runner internal mutation 只经 0600 Unix socket。
- Scheduler DB、prompt、final message、spool、logs 全部位于 0700 directories / 0600 files。
- ordinary structured logger 只接受 job/run ID、状态、duration、error code，不记录 Prompt、final message、Workspace 或 stderr。
- log API 只允许已登记 Run 的 validated relative path，拒绝 traversal；tail 有硬性 bytes/lines cap。
- `danger-full-access` 需要显式风险确认；v1 不提供全局“一键默认 full access”。
- timeout 终止整个 process group，避免 Codex 启动的 shell 子进程泄漏。
- uninstall 只 bootout/remove owned schedule plists，保留 scheduler DB/history/logs；purge 是独立显式操作。

## 错误与恢复

| 故障 | 行为 |
| --- | --- |
| launchd sync 失败 | Job 保留，`sync_state=error`，UI 可重试，startup reconcile |
| taskd 暂不可达 | runner bounded retry；写 dispatch/completion spool；恢复后 replay |
| Codex binary missing | Run failed `CODEX_UNAVAILABLE`，不 fallback 到 shell lookup |
| Workspace missing | Run failed `WORKSPACE_NOT_FOUND`，Schedule 自动 Pause 需人工修复 |
| Codex auth/config rejected | Run failed typed error，保留 stderr bounded evidence |
| Lock busy | 不启动第二进程，记录 `skipped_overlap` |
| Runner crash | OS lock/PID/lease recovery；Run 最终 `lost`，不永久 running |
| taskd restart during Run | runner heartbeat 暂存/重试，completion spool 幂等收口 |
| Codex timeout | process-group TERM → grace → KILL，Run `timed_out` |
| System timezone change | v1 Schedule 跟随 system local timezone；taskd 重算 summary/next run 并 reconcile |
| Sleep misses occurrences | coalesce 为最多一次 catchup，不批量回放 |

## 模块边界

计划新增或扩展：

```text
server/src/scheduler/
├── cadence.mjs              # validate/summary/next occurrence/launchd calendars
├── scheduler-store.mjs      # scheduler.sqlite only owner façade
├── launchd-backend.mjs      # render/reconcile owned units
├── scheduler-service.mjs    # public domain operations
├── runner-protocol.mjs      # Unix socket claim/heartbeat/complete
├── runner-spool.mjs         # bounded fail-safe evidence
├── codex-model-catalog.mjs  # bounded/cached `codex debug models` source
└── codex-run-spec.mjs       # allowlisted immutable invocation spec

server/scheduled-runner.mjs  # independent supervisor entry
ui/src/scheduled-tasks.mjs   # Scheduled view/controller
ui/src/scheduled-task-editor.mjs
ui/src/scheduled-run-review.mjs
```

`taskd-runtime.mjs` 只做 composition；`api-server.mjs` 只做 typed transport mapping。不得把 Scheduler 重新塞回新的单文件 monolith。

## 测试策略

### Unit / contract

- cadence validation、DST/system timezone、monthly gaps、once window、next occurrence。
- plist XML escape、absolute paths、Prompt/Workspace 不出现、owned cleanup scope。
- scheduler schema/invariants、optimistic revisions、active-run uniqueness、soft delete history。
- runner lock、claim ordering、nonce、heartbeat、completion replay、process-group timeout。
- Codex args allowlist、stdin prompt、JSONL thread id/final message parser、bounded logs。
- API Host/Origin、typed error、traversal rejection、SSE publish after commit。
- UI view switch、filters/editor/review state、accessibility/focus、error/empty/loading。

### Integration

- fake launchctl + fake Codex 完成 create → reconcile → trigger → Review 全链路。
- taskd restart 与 completion spool replay。
- scheduled trigger 与 Run now race。
- Pause/Edit/Delete 与 active Run race。
- package/install/update/uninstall 对 stable current path 与 owned units 的处理。

### Real macOS gate

- 隔离 data directory/port，创建 2–3 分钟后的真实 Schedule。
- `launchctl print` 验证 unit loaded；等待真实 wake-up。
- 验证 Codex thread、Hook record、Run Review、Resume。
- sleep/wake 可用短期人工 gate；无法自动化的证据在 test report 明确记录。
- 使用 Playwright MCP 做 Scheduled 的 desktop/narrow、empty/loading/error/active/paused/running/success/failure 多状态视觉验证。

## 文档与发布影响

实施完成后必须同步：

- `README.md`：How it works、安装前提、创建/暂停/Review、权限、logs、故障诊断。
- authoritative journalist spec：明确 Automation plane 是并列扩展，不改 Fact/Semantic plane 语义。
- `install.sh`、release allowlist、package/runtime tests：包含 runner 与 Scheduler modules。
- CLI help：Schedule backend/status/reconcile diagnostics；不新增 arbitrary command surface。
- Security/Privacy 说明：Prompt 与 Agent output 只存在本机 scheduler storage，和 Recorder 的 metadata-only policy 分区。

## 明确决策

1. macOS launchd first，不做虚假跨平台抽象实现。
2. 独立 `scheduler.sqlite`，但仍由 taskd 单一写入。
3. launchd per Schedule unit，只持有 ID 与 stable runner path。
4. runner 通过 Unix socket claim，不从 plist/argv/SQLite读取 Prompt。
5. OS lock + DB claim/lease，Run now 与 scheduled trigger 走同一 supervisor。
6. Prompt stdin、Codex absolute path、shell false、process-group timeout。
7. unattended 默认 read-only；任何扩大权限由每个 Schedule 显式选择。
8. v1 standalone new thread；Review queue 聚合每次 Run。
9. missed occurrences 最多 catch up 一次。
10. Scheduled Review 与 Project/Attribution Inbox 分离。

## Written Spec 复核门槛

进入实施计划前，用户需确认：

- v1 产品范围与 Out of Scope；
- 独立 Automation plane / scheduler database；
- macOS launchd + independent runner；
- standalone new thread、system timezone、read-only default；
- real macOS scheduling 与视觉验证作为完成门槛。
