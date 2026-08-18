# Tasks Recorder Dashboard Context, Timeline, and Status Design

> Historical baseline: 本文描述 v0.4.0 的 DHTMLX renderer。当前 renderer architecture 已由 [SVAR Gantt Dashboard 替代实现设计](2026-08-16-svar-gantt-dashboard-design.md) 取代；taskd、REST/SSE 与 mutation contracts 仍沿用本文。
>
> 当前 Grid 不再把九个存储字段全部平铺为独立列。SVAR 版本使用五列决策视图，并把工作目录、Worktree 与 Branch 合并为 Execution Context；完整值、复制和 mutation contracts 均保留。

> 日期：2026-08-12（Asia/Shanghai）  
> 状态：已实现并验证
> 适用项目：`/Users/joi-com/Desktop/space/projects/tasks-recorder`

## 目标

升级 standalone Tasks Recorder Dashboard，使它能够：

1. 直接展示任务最近活动 session 的 Session ID、工作目录、worktree 和 branch，并允许复制完整 Session ID。
2. 把右侧 Timeline 作为可展开/折叠的面板；折叠后 Grid 占满宽度。
3. 允许用户从 Dashboard 安全地修正任务状态，补偿会话被直接关闭、Stop Hook 没有触发等 lifecycle 漏洞。
4. 完全移除现有 auth token 与 Bearer authentication，采用明确的单用户 loopback trust model。

本轮只开放 status mutation，不开放标题、层级、日期、说明、Agent、Git context、Timeline task bar 日期拖动或其他任务 CRUD；后续面板分隔线只调整显示宽度。

## 第一原则

- **Goal**：Dashboard 既能解释任务正在什么工作上下文中执行，也能对 Hook 漏掉的状态收口做最小人工修正。
- **Facts**：`task_sessions` 已保存 `session_id`、`workfolder`、`worktree`、`branch` 和 `last_seen_at`；taskd 是唯一 SQLite owner；Dashboard 使用 REST snapshot + SSE invalidation；DHTMLX Gantt Standard 9.1 支持自定义列、custom layout、独立 scrollbar 和 Grid/Timeline view switching。
- **Assumptions**：任务的“当前上下文”定义为 `last_seen_at` 最新的有效 session，不代表实时扫描本机进程；本工具运行在单用户 macOS 环境，本机进程属于信任边界。
- **Constraints**：只监听 `127.0.0.1`；SQLite 仍是唯一真源；不引入 DHTMLX PRO、WebSocket、第二份业务状态、完整编辑器或账号系统。
- **Success Criteria**：Session ID 与三项 Git/路径上下文可见，完整 Session ID 可复制；Timeline 切换不丢 UI state；状态修改具备事务、并发、父子一致性与错误恢复；项目中不再存在 token/Bearer runtime contract。

## 已选方案

使用“受限写入 + 自定义 Status Pill 菜单 + 右侧 Timeline panel”方案：

- Gantt 保持 `gantt.config.readonly = true`，继续禁止内建 lightbox、inline editor、drag/drop 和日期 resize。
- 状态列使用自定义 button/menu，不启用 DHTMLX inline editor。
- 新增一个只更新 status 的窄 HTTP endpoint，不复用需要 Agent session context 的完整 upsert。
- 使用 custom layout 为 Grid 与 Timeline 提供各自的横向 scrollbar，并共享纵向 scrollbar。
- 在 expanded/collapsed 两个 layout 之间切换，不依赖 PRO resizer；后续版本使用 custom HTML separator 调整面板宽度。

没有选择 DHTMLX inline editor，因为它需要为 task 开放 editable exception，扩大只读边界；没有选择详情抽屉，因为路径需要直接作为独立展示列，状态修改也应保持一步操作。

### DHTMLX 能力依据

- 官方文档支持通过 layout configuration 组合 Grid、Timeline、scrollbar 与 shared vertical scroll：[Layout Configuration](https://docs.dhtmlx.com/gantt/guides/layout-config/)。
- 官方示例支持切换 Grid/Timeline view；本设计因需要独立横向 scrollbar，采用两个 custom layout，而不是只修改 `show_chart`：[Toggle Grid/Chart](https://docs.dhtmlx.com/gantt/guides/how-to/#howtotogglegridchart)。
- Grid 可配置额外列与横向 scrollbar：[Specifying Columns](https://docs.dhtmlx.com/gantt/guides/specifying-columns/#horizontalscrollbar)。
- 官方同时提供 inline editing 与 readonly mode；本设计保留全局 readonly，仅用应用自有 Status menu 发起受限 mutation：[Inline Editing](https://docs.dhtmlx.com/gantt/guides/inline-editing/)、[Readonly Mode](https://docs.dhtmlx.com/gantt/guides/readonly-mode/)。

## Snapshot 数据契约

`GET /api/v1/snapshot` 中每个 task 增加：

```ts
interface DashboardTask {
  id: string;
  parent_id: string | null;
  title: string;
  status: "planned" | "active" | "waiting" | "blocked" | "done";
  agent: string;
  start: string;
  end: string | null;
  last_activity: string | null;
  next_action: string | null;
  session_id: string | null;
  workfolder: string | null;
  worktree: string | null;
  branch: string | null;
  updated_at: string;
}
```

Snapshot 顶层同时增加 `home_directory: string`。它只用于把 Grid 中位于当前用户 `$HOME` 下的 `workfolder` / `worktree` 显示为 `~/…`；task 字段继续保留绝对路径，tooltip 也使用绝对路径。

### Session 选择规则

对每个 task：

1. 过滤掉 `last_seen_at` 非法的 session。
2. 按 `last_seen_at DESC` 选择一条最近 session。
3. `session_id`、`workfolder`、`worktree`、`branch` 和 `last_activity` 全部来自这同一条 session。
4. `agent` 仍允许回退到最近一条具有非空 Agent 的 session，兼容旧数据。
5. 没有有效 session 时，Session ID 与三项上下文为 `null`，`last_activity` 回退到 task `updated_at`。

不能分别选择最近的非空 worktree/branch，否则可能把不同 session 的上下文拼成不存在的组合。

## Grid 与路径展示

Grid 列顺序固定为：

```text
任务 | 状态 | Session ID | 工作目录 | Worktree | Branch | 说明 | Agent | 活动
```

以上是 DHTMLX historical layout。当前 SVAR layout 为 `任务 | 状态/进度 | 执行上下文 | Session ID | 活动`，总宽度匹配默认 792px Grid，不产生首屏横向滚动。

- Session ID 与三项上下文使用独立列；Session ID 展示最近 session 的完整值，并提供复制按钮和成功反馈。
- `workfolder` 和 `worktree` 默认宽度 180px、最小宽度 140px；`branch` 默认宽度 160px、最小宽度 120px。
- 使用 snapshot 顶层 `home_directory` 判断 `$HOME` 前缀，只在显示文字中缩写为 `~`；DOM `title`、accessible label 与 hover/focus popover 保留绝对值。
- 单元格内容垂直居中；单行省略时可通过 hover/focus popover 读取完整值；空值显示 `—`。
- 所有 task-controlled 字符串必须 HTML escape。
- Grid 自己拥有横向 scrollbar；Timeline 使用另一条横向 scrollbar；二者共享一条纵向 scrollbar，使行始终对齐。
- 现有任务列自定义 resizer 继续只调整任务列，不依赖 DHTMLX PRO column/grid resizer。

## Timeline panel

工具栏增加 Timeline toggle，状态写入 `localStorage`：

```text
dashboard-show-timeline
```

首次访问默认展开；折叠时 Timeline label toggle disabled，Locate 仍可用并负责先展开 Timeline。

### Expanded layout

- 左侧为可横向滚动 Grid。
- 右侧为 Timeline。
- 两侧共享纵向 scrollbar。
- Timeline 保留 NOW marker、Locate、label toggle、scale、scroll 与 readonly bars。

### Collapsed layout

- Grid 占满可用宽度。
- Grid 横向 scrollbar 保留。
- Timeline view 与其横向 scrollbar不渲染。
- Locate 操作先展开 Timeline，再定位到当前时间。

切换前捕获并在 layout reset 后恢复：

- active status tab；
- task tree open IDs；
- Grid 横向 scroll；
- Timeline 横向 scroll；
- shared vertical scroll；
- 任务列宽；
- Timeline labels preference。

Snapshot 刷新也继续保留这些状态。不得因 layout toggle 重新读取或改写业务数据。

## 状态修改交互

状态 Pill 改为 button：

- `aria-haspopup="listbox"`；
- `aria-expanded` 反映菜单状态；
- 菜单包含 `planned | active | waiting | blocked | done` 五项；
- 当前项有 selected state；
- 支持 Enter/Space 打开、方向键移动、Enter 选择、Escape 关闭；
- 点击外部关闭菜单。

选择新状态后立即提交，不增加第二次确认：

1. 关闭 menu。
2. 当前 Pill 进入 pending 并禁止重复提交。
3. 发送 status PATCH。
4. 不在客户端提前伪造 task status。
5. 成功后等待 SSE/snapshot authoritative refresh；也允许使用响应中的 revision 主动 invalidate，加快单页面反馈。
6. 失败后恢复交互，保留旧 snapshot 值，并通过现有 `aria-live` 区域显示原因。

同一时刻每个 task 只允许一个 status request；不同 task 可以各自提交。

## Status API

新增：

```http
PATCH /api/v1/tasks/:id/status
Content-Type: application/json
Origin: http://127.0.0.1:43127

{
  "status": "planned | active | waiting | blocked | done",
  "expected_updated_at": "2026-08-12T07:57:23.351Z"
}
```

成功响应：

```json
{
  "ok": true,
  "persisted": true,
  "changed": true,
  "task": {},
  "affected_parent": null,
  "change": {
    "server_instance_id": "...",
    "revision": 1
  }
}
```

### Store 接口

新增：

```ts
updateStatus(input: {
  id: string;
  status: TaskStatus;
  expected_updated_at: string;
}): {
  task: Task;
  affected_parent: Task | null;
  changed: boolean;
}
```

该方法不创建或更新 `task_sessions`，因为人工 Dashboard mutation 不是 Agent session activity。

### 并发规则

- `expected_updated_at` 必填且必须是合法 instant。
- 事务内读取 task 并比较版本。
- 不匹配时返回 `409 TASK_VERSION_CONFLICT`，不能覆盖 Agent 或另一页面的新写入。
- 即使目标 status 与当前相同，也先校验版本；版本一致时返回 `persisted: false`、`changed: false` 和当前 task，不改 `updated_at`、不返回 `change`、不发布 SSE。

### 时间规则

- 切换到 `done`：`completed_at = now`；如果历史数据已有 `completed_at` 且任务本次没有离开过 done，不重写。
- 从 `done` 切换到其他状态：`completed_at = null`。
- 发生真实状态变化：`updated_at = now`。
- 只产生一次 transaction commit 和一次 SSE `changed`。

### 父子规则

- 父任务存在任一非 `done` 子任务时，禁止把父任务设为 `done`，返回 `409 CHILD_TASKS_INCOMPLETE`，并在 details 返回未完成 child IDs。
- 重新打开一个 child（`done` → 非 `done`）时，如果 parent 当前为 `done`，同一事务自动把 parent 改为 `active`、清空 parent `completed_at` 并更新 parent `updated_at`。
- 自动恢复 parent 与 child 属于一次业务 mutation，只发布一次 SSE change。
- 完成最后一个 child 时不强制改 parent status；现有 `isArchivedGroup` 规则仍会把所有 leaves 已完成的 group 放入 History。
- 不做级联完成，不隐式修改 sibling。

## 移除认证

彻底删除现有 token/Bearer contract：

- 删除 `server/src/auth-token.mjs` 与 token tests。
- 删除 config 中 `tokenPath`、`AGENT_TASKS_TOKEN_PATH`。
- 删除 controller 的 `ensureToken` 和 install token lifecycle。
- 删除 taskd/MCP/Hook 读取 token 的代码。
- 删除 task client 的 `Authorization` header。
- API server 不再接收 token，也不再对 Agent routes 执行 Bearer validation。
- 删除 `~/.config/tasks-recorder/auth-token`。
- README 的用户状态目录只包含 `config.json` 与 `tasks.sqlite`。

### Loopback trust model

- Server 只绑定 `127.0.0.1`，拒绝 wildcard/LAN bind。
- `Host` 必须是配置的 `127.0.0.1:<port>`。
- 有 `Origin` 时必须与 Server origin 完全一致；浏览器 mutation 必然携带同源 Origin。
- 不返回 CORS headers。
- mutation 继续要求 non-simple method + `application/json`；request body 上限 64 KiB。
- 本机 native client 可以不带 Origin；所有能访问本机 loopback 的进程被视为受信任。

明确接受的风险：同一台机器上的其他进程可以读取和修改 Tasks Recorder 数据。这是单用户 local-first 工具的产品 trust boundary，不声称提供同用户进程隔离。

## 错误处理

| 场景 | HTTP / code | UI 行为 |
| --- | --- | --- |
| task 不存在 | `404 TASK_NOT_FOUND` | 关闭 menu，刷新 snapshot，提示任务已不存在 |
| status 非法 | `400 TASK_STATUS_INVALID` | 保留旧值，提示请求无效 |
| 版本冲突 | `409 TASK_VERSION_CONFLICT` | 立即刷新 snapshot，提示任务已被其他 Agent 或页面更新 |
| 父任务有未完成子项 | `409 CHILD_TASKS_INCOMPLETE` | 保留旧值，提示先完成列出的子任务 |
| Host / Origin 不合法 | `403 HOST_REJECTED / ORIGIN_REJECTED` | 不修改数据，显示安全拒绝提示 |
| taskd/network 不可用 | connectivity error | 保留最后一次 snapshot，菜单恢复可用，沿用 SSE 重连 |

Server error message 不包含任务正文之外的新敏感信息；未完成 child details 只包含 IDs。

## 组件边界

- `mcp/src/dashboard-data.mjs`：选择最近 session，产出 Session ID、context 与 `updated_at`。
- `mcp/src/task-store.mjs`：实现 status transaction、版本比较、完成时间和父子规则。
- `mcp/src/task-service.mjs`：封装 status change notification，不重复发布事件。
- `server/src/api-server.mjs`：新增 PATCH route，移除 Bearer gate，保留 Host/Origin/content-type/body guards。
- `mcp/src/task-client.mjs`：移除 token；增加 status client method 只用于 contract 完整性，MCP tools 本轮不新增人工 status tool。
- `ui/src/dashboard-state.mjs`：纯函数处理 Session ID/路径显示、clipboard boundary、layout/status state helpers。
- `ui/src/dashboard.mjs`：列、Session ID copy interaction、custom layout、Timeline toggle、menu event delegation、pending/error 和 snapshot invalidation。
- `ui/src/dashboard.css`：Session ID/路径列、独立 scrollbar、toggle、menu、pending 与 focus styles。

## 测试与验收

### Store 与 service

- 合法五状态 transition。
- `done` 设置 `completed_at`，reopen 清空。
- no-op 不改版本、不发布 SSE。
- stale `expected_updated_at` 返回 conflict。
- 未完成 child 阻止 parent done。
- child reopen 自动恢复 done parent，但不修改 sibling。
- child + parent 同事务只发布一次 change。

### Snapshot

- Session ID 与三个 context 字段来自同一条最近 session。
- 最近 session 字段为空时保持 null，不拼接旧 session。
- Agent fallback 仍兼容 legacy session。
- `updated_at` 被暴露且非法 task 仍安全过滤。

### HTTP 与安全

- PATCH method、path、JSON、status 与 expected version contract。
- 400/404/409 mapping。
- 所有既有 Agent routes 在无 Bearer header 时正常工作。
- production code 与 build 不包含 `Authorization: Bearer`、token path 或 auth-token lifecycle。
- wrong Host/Origin 仍失败；no CORS 仍成立。

### Dashboard

- Session ID 完整展示与复制反馈，以及三列 context 的 `~` display、absolute tooltip 与 HTML escaping。
- Grid/Timeline 独立横向 scroll、共享纵向 scroll。
- expanded/collapsed toggle 与 local preference。
- toggle 和 snapshot refresh 保留 tab、tree、scroll、task width 与 labels state。
- Locate 从 collapsed 自动展开并定位。
- Status menu mouse/keyboard/ARIA。
- pending prevents duplicate submit。
- success、network failure、conflict、incomplete children 的 authoritative recovery。
- 360 / 768 / 1440 viewport 无页面级横向 overflow；横向滚动限制在 Grid/Timeline 内。

### 运行时验收

- `npm run build && npm test && npm run check` 全绿。
- 重装 LaunchAgent 后 `/health/ready` 成功。
- 无 token 的 MCP client 可以写入临时 taskd。
- 实际 Dashboard 修改状态后只收到一次 `changed`，snapshot 与 SQLite 一致。
- taskd 重启后 Timeline preference 与 Dashboard 数据恢复。
- `~/.config/tasks-recorder/auth-token` 不存在。

## 文档更新

结构性/public contract 变化要求扫描完整 Markdown 树，并同步：

- `README.md`：数据目录、loopback trust model、可写 Dashboard、Timeline toggle、API 示例与无 token 安装。
- `skills/task-manager/SKILL.md`：删除任何 token 假设；继续要求 Agent 经 taskd/MCP 操作，Dashboard 人工 status correction 不替代 semantic task maintenance。
- 现有 standalone migration spec/plan 作为历史执行记录保留，不重写已经发生的迁移事实。

## 不做

- 标题、说明、Project、层级、日期、Agent 或 Git context 编辑。
- Timeline bar drag、duration resize、dependency links。
- 自动扫描当前 process/cwd 来覆盖 session context。
- 父任务级联完成、自动完成 parent 或修改 sibling。
- 账号、TLS、LAN/公网访问、cookie、CSRF token 或 Bearer token。
- DHTMLX PRO resizer、resource view 或 inline editor。

## Johari 自审

- **Open Area**：三独立 context 列、右侧 Timeline toggle、Pill 下拉、无确认状态写入、父任务完成 guard、child reopen 恢复 parent、彻底移除 token 均已确认。
- **Hidden Area**：用户接受同一台机器其他进程属于 trust boundary；没有要求多用户或同用户进程隔离。
- **Blind Spot**：顶层 `done` 会让整组进入 History，已用 parent guard 和 child reopen parent recovery 防止任务被错误隐藏。
- **Unknown Area**：custom layout 在 DHTMLX Standard 实际 bundle 中的 scroll/state behavior，需要实现阶段的 browser multi-state 验证，不能只以 unit tests 代替。
