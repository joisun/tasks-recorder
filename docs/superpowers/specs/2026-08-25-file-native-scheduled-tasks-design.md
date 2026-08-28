# File-native Scheduled Tasks Design

> **Historical / partially superseded (2026-08-27)**：Markdown definition 仍然有效，但本文中的 per-Schedule `launchd` / runner execution path 已退役。当前架构见 [`README.md`](../../../README.md) 与 [`Runtime Agent Registry 设计`](./2026-08-27-runtime-agent-registry-design.md)。

> 日期：2026-08-25
> 状态：已实施
> 基线：`docs/superpowers/specs/2026-08-24-scheduled-tasks-design.md`

## 目标

Schedule 定义必须是用户可读、可移动、可版本控制的 Markdown 文件。SQLite 不再是当前 Schedule 定义的 source of truth；它仅承担 Run ledger、manual dispatch、review、运行证据、日志引用与可重建的 scheduler operational state。

## 第一原则

- 用户真正需要掌控的是“将执行什么、何时执行、在哪里执行”，这些信息必须能脱离 Dashboard 阅读和修改。
- scheduler 仍需要可靠的 no-overlap、crash recovery、review 与历史查询；这些是运行事实，适合事务型 ledger。
- 同一事实不能同时由 Markdown 和 SQLite 决定。Markdown 决定未来执行，Run ledger 只记录已经发生的执行。
- 文件系统事件不是可靠队列，因此 watcher 只提供低延迟，startup scan 与周期性 rescan 才是正确性兜底。

## 文件格式

配置项 `schedule_definitions_dir` 指向单一 root，默认：

```text
~/.config/tasks-recorder/schedules
```

taskd 递归读取 `*.md`，但只识别带有以下 marker 的文件；其他 Markdown 完全忽略：

```md
---
type: tasks-recorder/schedule
id: 34826d22-b33b-4d1d-b9d0-8459d71009dc
title: Codex daily news
enabled: true
workspace: /Users/me/projects/example
schedule:
  kind: daily
  at: "09:00"
sandbox: read-only
model: gpt-5.6-sol
reasoning: ultra
timeout: 2h
---

检查 Codex 官方来源，整理今天的重要变化并给出链接。
```

### Front matter v1

| 字段 | 必需 | 语义 |
| --- | --- | --- |
| `type` | 是 | 固定为 `tasks-recorder/schedule` |
| `id` | 是 | 稳定 UUID；沿用 launchd ownership、runner lock 与 Run protocol 的安全身份边界 |
| `title` | 是 | 1–200 字符 |
| `enabled` | 否 | 默认 `true`；Pause/Resume 实际改写该字段 |
| `workspace` | 是 | 现有本机目录，保存 canonical absolute path |
| `schedule` | 是 | allowlisted structured cadence |
| `sandbox` | 否 | 默认 `read-only` |
| `model` | 否 | bounded Codex model slug；当前可用性由 taskd 的 Codex catalog preflight 判断 |
| `reasoning` | 否 | bounded reasoning identifier；当前支持范围由所选 Model 的 catalog entry 判断 |
| `timeout` | 否 | `60s`–`24h`，默认 `2h` |

Markdown body 是 Prompt，trim 后必须非空。Cadence 文件语法使用更适合手写的 `at: HH:mm`，解析后仍转换为现有内部 cadence：

- once：`{ kind: once, at: <ISO-8601 with offset> }`
- hourly：`{ kind: hourly, minute: 0..59 }`
- daily：`{ kind: daily, at: HH:mm }`
- weekly：`{ kind: weekly, on: [mon..sun], at: HH:mm }`
- monthly：`{ kind: monthly, day: 1..31, at: HH:mm }`

timezone v1 固定为 system timezone，与现有 launchd 语义一致。启用中的 `once` 必须指向未来 366 天以内；执行完成后 service 将定义改为 `enabled: false`。已停用的 `once` 即使时间已过也仍是有效历史定义，确保重启与外部编辑后的 scan 不会把正常完成误报为 invalid；重新启用时必须先改为新的未来时间。

Model catalog 以安装时记录的 canonical Codex executable 的 `codex debug models` 为唯一来源。taskd 通过 shell-free argv、5 秒 timeout 与 2 MiB output bound 读取，过滤 `visibility !== list` 的内部条目，只向 Dashboard 暴露 slug、display name、description、default reasoning 与 supported reasoning levels，并缓存成功结果 5 分钟。Markdown codec 与 immutable Run snapshot 只验证安全 identifier shape；显式设置 Model 或 Reasoning 时，create/update/resume preflight 才验证当前 catalog compatibility，两项均为 Codex default 时不依赖 catalog。因此 Codex 升级不会让历史 definition 或已 claim snapshot 因过期的应用内枚举而失效。

## 组件边界

### `schedule-definition-codec.mjs`

纯函数 codec。负责 Front matter parse/serialize、字段 allowlist、human syntax 与 domain cadence 的双向转换、definition hash。使用成熟 YAML parser，不自行实现 YAML。

### `schedule-definition-repository.mjs`

唯一 Markdown writer。负责递归 scan、marker filtering、duplicate ID 检测、atomic create/update/delete、etag compare-and-swap、默认目录权限和外部目录安全边界。Repository 返回 domain Job：

```js
{
  id, title, prompt, workspace, cadence, enabled,
  sandbox_mode, model, reasoning_effort, timeout_seconds,
  source_path, etag, updated_at
}
```

UI 删除采用 recoverable move 到 root 下 `.trash/`；scanner 忽略 dot directories。

### `schedule-definition-monitor.mjs`

组合 debounced `fs.watch`、startup scan 与 30 秒 rescan。每次 refresh 产生 `{added, changed, removed, invalid}` diff。invalid/duplicate definition fail closed：对应 launchd unit 被移除，UI 展示具体 path 与 bounded error；不会继续执行 last-known-good definition。

### SQLite v2 ledger

删除 `scheduled_jobs` 中的当前定义职责。保留：

- `scheduled_runs.schedule_id`：无 Schedule FK，定义删除后历史仍可查询；
- `scheduled_runs.spec_json`：claim 时的 immutable execution evidence，不是可编辑定义；
- `scheduled_dispatches.schedule_id`：manual dispatch operational queue；
- `scheduled_sync_state(schedule_id, definition_etag, sync_state, error_code, updated_at)`：可删除并从文件与 launchd 重建的状态。

Ledger 不保存当前 definition 的 title、prompt、workspace 或 cadence。

### `scheduler-service.mjs`

Definition repository 处理 CRUD；ledger store 处理 Run/dispatch。Service 在返回列表时组合 definition、sync state、next occurrence 和 Run summary。claim 时重新按 ID 读取有效 definition，并把 immutable spec 交给 ledger；文件缺失、disabled、invalid 或 etag drift 均拒绝 claim。

### launchd reconcile

generation 改为 definition etag 派生的 monotonic in-process generation；desired state 由当前有效且 enabled 的 Markdown definition 计算。文件移除、invalid、disabled 或切换 root 都 bootout/remove 归属明确的 unit。

## API 与 UI

- 现有路由保留，避免无意义的 UI 重写。
- Job response 增加 `source_path` 与 `etag`，不再返回 integer `revision`。
- update/pause/resume/delete 使用 `expected_etag`，冲突返回 `SCHEDULE_VERSION_CONFLICT` 并重新加载磁盘内容。
- Settings 增加 Definitions directory。保存目录不是单纯修改 config，而是触发一次 runtime Schedule library relocation：迁移当前 definitions、热切换 repository/watcher、reconcile desired state，并在同一请求返回前生效；不要求用户重启 taskd。
- Create/Edit 直接写 Markdown；列表在 watcher 事件或 SSE invalidation 后刷新。
- 移除 decorative kicker/microcopy：`TASKS RECORDER`、`PREFERENCES`、`AUTOMATION CONTROL PLANE`、`Local control plane`、Editor/Review 内同类英文 eyebrow。保留页面标题、字段标签、状态与可操作错误。

## 迁移

首次启动检测 SQLite v1：

1. 只读加载所有未删除 `scheduled_jobs`。
2. dry-run 序列化并验证 round trip。
3. 若目标路径或 ID 冲突，保留 v1 数据并令 Scheduler degraded，绝不覆盖。
4. 逐文件 temp + fsync + rename 写入定义。
5. 全部文件重新 scan 成功后，在同一数据库事务迁移 ledger schema 到 v2。
6. 迁移只自动执行一次；日志仅记录数量、ID 与 bounded path，不记录 Prompt。

### Definitions root relocation

`schedule_definitions_dir` 变化时，taskd 在一个 scheduler-level exclusive queue 中执行 relocation，期间新的 Schedule mutations 等待，读取继续使用旧 registry。该操作是一次性 library migration，不建立两个目录之间的长期同步关系。

1. canonicalize 并验证目标目录存在、非 symlink、可读写且不是当前 root。
2. refresh 旧 repository，并分别 scan 旧、新 root。旧 root 存在 invalid/duplicate marked definition 时整体拒绝；目标 root 中普通 Markdown 忽略。
3. 以 Schedule ID 和目标 relative path 做 preflight；目标已有相同 ID 或路径但内容不同则整体拒绝，绝不覆盖。无冲突的目标 definitions 可以与迁入集合合并。
4. 将旧 root 的有效 definitions 逐文件复制到目标 root 的 hidden staging directory，使用 `0600` temp file、fsync 与 rename；跨 filesystem 不依赖 atomic rename。
5. 构造 candidate repository，scan 后验证迁入 ID/etag 与旧 registry 完全一致，并验证目标原有 definitions 未改变。
6. 关闭旧 watcher 并等待在途 diff 完成；进入 exclusive queue 后再次校验 source etag，再原子替换 scheduler service 使用的 active registry。
7. 以旧/新 registry diff reconcile desired state，并以新 root 建立不重复 replay definitions 的 watcher baseline。Schedule ID/etag 不变，因此已有 Run ledger 与 locks/logs/spool 保持关联；目标目录原有 definitions 作为新增 desired state 处理。
8. config 只在 runtime switch、reconcile 与新 watcher 成功后 atomic persist。旧 definition files 随后移动到旧 root 的 `.trash/migrated-<timestamp>/`，保留可恢复副本但不再被 scanner 读取。

在 active registry swap 前任一步失败，都删除本次 staging 并继续使用旧 root。swap 后旧文件归档失败不回滚已生效的新 registry，也不删除未归档的旧文件；API 返回成功并附带 bounded cleanup warning，旧 root 已不再被监听，因此不会形成双 source of truth。SSE 在成功切换后发布一次 invalidation。

## 安全与错误处理

- 默认 root 创建为 `0700`、UI 写入文件为 `0600`；自定义 root 不被擅自 chmod。
- root 必须是本机 absolute directory，无 NUL、URL 或 traversal；realpath 后使用。
- atomic write 不跟随目标 symlink，不覆盖非 regular file。
- duplicate ID、非法 front matter、非法 workspace、unsafe file 都以独立 validation item 暴露；一个坏文件不阻断其他 Schedule。
- 外部编辑采用 stable-stat debounce，避免读取编辑器的中间态；最终仍以周期 rescan 收敛。
- relocation 不移动普通 Markdown、旧 `.trash`、logs、locks、spool 或 SQLite。跨 root mutation 和 root switch 由同一个 exclusive queue 串行化，防止 Create/Edit 与迁移看到不同 registry。

## 测试与验收

- codec round-trip、marker ignore、allowlist、cadence、duration、malformed YAML。
- repository create/update CAS/delete-to-trash、symlink、duplicate ID、nested scan。
- v1→v2 migration success/conflict/rollback/idempotency。
- service claim 使用磁盘最新定义，invalid/removed/paused 均 fail closed。
- watcher + rescan diff 和 launchd reconcile。
- API/UI editor 使用 `etag`；Settings directory relocation 覆盖无冲突迁移、目标 merge、ID/path conflict、invalid source、cross-filesystem copy、rollback、watcher swap 与 cleanup warning。
- Visual review 覆盖 desktop/mobile list、editor、settings、invalid definition 与 conflict state。
- 全量 `npm test`、`npm run check`、`npm run build`、`npm run build:adapters`、`npm run package:release`。

## Johari 复核

- Open：定义可读、可版本控制和运行历史可靠是已确认目标。
- Hidden：用户未指定多 root；v1 采用单 root，避免过早引入 registry layering。
- Blind spot：外部编辑冲突、坏文件继续旧任务、目录切换误停任务和迁移覆盖，均通过 CAS、exclusive queue、staged copy/verify/swap、fail closed 与 no-overwrite 处理。
- Unknown：真实用户数据库是否与目标文件冲突；迁移必须先只读验证，不能靠假设。
