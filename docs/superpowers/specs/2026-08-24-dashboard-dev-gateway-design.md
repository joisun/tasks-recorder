# Dashboard Dev Gateway 设计

> 日期：2026-08-24（Asia/Shanghai）
> 状态：已批准，待实施
> 范围：Tasks Recorder Dashboard 的本地开发预览链路

## 结论

Tasks Recorder 应把日常 UI 开发与正式 Release 完全分离。新增源码命令 `npm run dev:ui`：它在 `http://127.0.0.1:43128` 提供当前 worktree 编译出的 Dashboard，监听 `ui/src`，在成功构建后自动刷新浏览器，并把 `/api/*` 与 `/health/*` 透明代理到已经运行的正式 taskd `http://127.0.0.1:43127`。

dev gateway 不是第二个 taskd，不读取 SQLite，也不改写已安装 Release。正式 `43127` 继续是唯一数据服务与 SQLite owner；`43128` 只负责开发态 UI、reload channel 和 loopback reverse proxy。

## 第一原则

### Goal

开发者保存 Dashboard 源码后，应在数秒内看到使用真实实时数据的新页面，而不需要发布 GitHub Release、运行 installer、复制文件或重启正式 taskd。

### Facts

- 当前 `npm run build` 只执行一次 esbuild，并把结果写入 `ui/dist/index.html`。
- taskd 启动时一次性读取该 HTML，后续请求返回内存中的内容；重新 build 不会改变正在运行的页面。
- 正式安装的 taskd 从 immutable release 目录启动，因此 source worktree 与安装态 UI 不相连。
- Dashboard 的 API 和 EventSource 均使用相对路径；独立 UI origin 若不做代理，会遇到同源边界，并需要修改 production API contract。
- taskd 已经通过 SSE 在数据变化后驱动 snapshot reload；dev gateway 不需要另造数据 polling。

### Assumptions

- 日常 UI 调试需要真实本机数据，但不要求同时运行第二个数据库服务。
- 自动整页 reload 足以满足当前单文件 Dashboard；组件级 HMR 不是现阶段的必要条件。
- Node.js 24 的原生 HTTP、filesystem watch 与现有 esbuild 足以实现，不需要引入 Vite 或新的 runtime dependency。

### Constraints

- 所有 listener 与 upstream 只能使用 `127.0.0.1`，不得扩大网络暴露面。
- `43127` 仍是唯一 taskd 和 SQLite writer；gateway 不导入 store/service 模块。
- production build、release archive 与安装态 HTML 不包含 dev reload client。
- API method、body、status、业务 headers 与 SSE stream 必须透明转发；gateway 只处理 loopback trust boundary 所需的 `Host`、`Origin` 与 hop-by-hop headers，不理解业务 payload。
- 编译失败不得覆盖最后一次成功页面，也不得使正式 taskd 退出。
- 不通过修改 `~/.local/share/tasks-recorder/releases/*` 预览源码。

### Success Criteria

1. 启动正式 taskd 后，运行 `npm run dev:ui` 即可访问 `http://127.0.0.1:43128`。
2. 修改 `ui/src` 中的 JavaScript、CSS 或 HTML 后，成功构建会触发已打开页面自动 reload，无需手动 build、重启或 Release。
3. dev 页面能读取 snapshot、接收 taskd SSE，并执行与正式 Dashboard 相同的 API 请求。
4. upstream 不可用时页面服务仍存活，API 返回明确的 `502`；upstream 恢复后无需重启 gateway。
5. 一次构建失败后仍能访问最后一次成功页面；修复源码后自动恢复并 reload。
6. `npm run build` 的产物不包含 dev endpoint、reload client 或 `43128` 字样。
7. gateway 和 upstream 端口冲突、非 loopback upstream、非法端口会在启动前被拒绝。
8. gateway 拒绝不匹配自身 loopback origin 的 `Host` / `Origin`；合法请求代理到 taskd 时使用 upstream `Host` / `Origin`，不会绕过或破坏 taskd 的同源校验。

## 方案比较

### A. 独立 dev gateway（采用）

复用现有 esbuild 编译逻辑，增加轻量 HTTP gateway、source watcher 和 reload SSE。它代理正式 taskd，因此 API 仍是同源相对路径。

优点：production/runtime 边界清楚；不新增依赖；真实数据、SSE 和交互完整；不需要停止正式服务。缺点：使用整页 reload，而不是组件级 HMR。

### B. 引入 Vite（不采用）

Vite 能提供成熟 HMR 和 proxy，但当前 production 是自包含单文件 HTML。为一个本地 reload 需求引入第二套构建语义、依赖与配置，会增加 package、release 和安全审计成本。

### C. taskd 动态读取 source build（不采用）

可以让 taskd 每次请求重新读 HTML，或在源码变化时替换内存内容。这会把开发职责带进 daemon，并仍然需要解决 source taskd 与安装态 taskd 的端口、生命周期和 SQLite ownership 冲突。

## 架构与数据流

```text
ui/src ──watch/build──> last successful HTML
                              │
                              v
Browser ── GET / ─────> Dev Gateway :43128
   │                          │
   ├── EventSource /__tasks_recorder_dev/reload
   │                          │ build success -> reload event
   │                          │
   ├── /api/* ────────────────┼──stream proxy──> taskd :43127
   └── /health/* ─────────────┘                 │
                                                v
                                          canonical SQLite
```

页面只访问 `43128`。gateway 对页面 HTML 注入极小的 dev-only reload client；client 连接专用 SSE endpoint。源码构建成功后，gateway 向已连接浏览器发送 `reload` event。Dashboard 自身的 `/api/v1/events` 仍来自 `43127`，用于刷新任务数据；两个 SSE channel 职责不同。

## 组件设计

### 1. 可复用 Dashboard compiler

从 `ui/build.mjs` 提取无 CLI 副作用的 compiler：读取 template/CSS、调用 esbuild、执行现有 remote-font 校验并返回完整 HTML。production entry 负责原子写入 `ui/dist/index.html`；dev gateway 只把成功结果保存在内存中。

production compiler 默认不接受或注入 dev client。dev reload script 由 gateway 在响应 HTML 时插入，避免错误进入 release artifact。

### 2. Source watcher

监听 `ui/src`，对短时间内的连续 filesystem event 做 debounce，并串行执行构建：同一时刻最多一个 build；build 期间的新变化合并为下一轮。只有成功构建才替换 last-good HTML 并广播 reload。

初始构建失败时不启动 HTTP server，因为没有可服务的页面。运行期间失败则保留 last-good HTML，在 stderr 输出有界错误；后续文件变化继续重试。

### 3. Loopback HTTP gateway

默认绑定 `127.0.0.1:43128`，默认 upstream 为 `http://127.0.0.1:43127`。允许通过 `TASKS_RECORDER_DEV_PORT` 与 `TASKS_RECORDER_DEV_UPSTREAM` 覆盖端口和 upstream，以支持多个 worktree；解析阶段要求 HTTP、loopback、无 credentials、无 path/query/hash，且 listen port 不得等于 upstream port。

路由契约：

- `GET /`、`GET /index.html`：返回注入 reload client 的 last-good HTML；
- `GET /__tasks_recorder_dev/reload`：dev-only SSE channel；
- `/api/*`、`/health/*`：透明 streaming proxy；
- 其他路径：`404`；
- upstream 建连失败：返回 JSON `502`，不终止 gateway。

gateway 先执行与 taskd 相同的入口保护：`Host` 必须等于实际 dev listener，存在 `Origin` 时必须等于 dev origin。只有验证通过的请求才进入 proxy；proxy 移除 hop-by-hop headers，把 `Host` 重写为 upstream authority，并把合法的 browser `Origin` 重写为 upstream origin，使 taskd 继续执行自己的同源校验。没有 `Origin` 的非浏览器请求不凭空增加该 header。

除上述 trust-boundary headers 外，proxy 保持 method、query、request body、response status、业务 headers 与 response stream。不得缓存 API/SSE 响应，也不得为任意外部 origin 添加 CORS。

### 4. Developer command

根 `package.json` 增加：

```json
{
  "scripts": {
    "dev:ui": "node ui/dev-server.mjs"
  }
}
```

启动后终端明确打印 dev URL、upstream URL，以及“dev 页面中的 mutation 会写入当前正式数据库”的提示。进程收到 `SIGINT`/`SIGTERM` 时关闭 watcher、reload clients 和 HTTP server。

## 数据安全与交互语义

gateway 自身没有写数据库的能力，但它会透明代理 Dashboard mutation。因此在 `43128` 修改 Task 状态与在 `43127` 修改的结果完全相同。README 必须明确：视觉浏览是只读的；使用编辑、归属或状态操作会更新真实本机数据。

本阶段不增加 sandbox database。sandbox 需要 fixture lifecycle、独立 taskd 与数据初始化，是另一个目标；把它绑进最初的 UI preview 会重新引入双服务复杂度。若后续需要破坏性 UX 测试，再单独设计 `dev:sandbox`。

## Error Handling

| 场景 | 行为 |
| --- | --- |
| 初始 build 失败 | 输出错误并以非零状态退出，不监听端口 |
| 后续 build 失败 | 保留 last-good HTML，不 reload，等待下一次变化 |
| upstream 未启动/重启中 | 对该请求返回 `502`；gateway 与 watcher 继续运行 |
| dev SSE client 断开 | 移除 client，不影响其他连接 |
| 非法配置或端口冲突 | 启动前失败，错误包含字段与可修正原因 |
| gateway 被终止 | 停止监听与 watch，关闭连接，正常退出 |

错误输出不得包含 API payload、Task 内容或数据库路径；compiler 错误只展示 source-relative location 与 esbuild message。

## 测试与验证

按 TDD 实施，至少覆盖：

1. compiler：production HTML 与现有 bundle contract 一致，且不含 dev client；
2. config：默认值、合法 override、loopback restriction、端口冲突；
3. gateway：HTML、404、upstream 502、GET/POST body/status/header 代理，以及非法 `Host` / `Origin` 拒绝；
4. streaming：upstream SSE chunk 能在连接不结束时到达浏览器侧；
5. rebuild state：失败保留 last-good，下一次成功替换 HTML并广播一次 reload；
6. shutdown：watcher、server 与 SSE clients 可确定性关闭；
7. full regression：syntax、全量 tests、production UI/adapters/release build 与 `git diff --check`；
8. Playwright headless：实际 `43128` 页面加载、snapshot 200、taskd SSE 与 dev reload 均可观察，console 0 error/0 warning。

## 文档影响

- README 增加 Development 小节，区分 `43127` installed Dashboard 与 `43128` source preview。
- README 明确 dev 页面 mutation 使用真实数据，以及 upstream/port override 方法。
- Release/install/How it works 文档不改变；dev gateway 不属于分发 runtime contract。

## Johari Review

- **Open Area**：现有 build 是一次性的、taskd 缓存 HTML、Dashboard 使用相对 API/SSE 路径，均已由代码确认；独立同源 gateway 能在不触碰数据库 ownership 的前提下闭合开发链路。
- **Hidden Area**：开发者是否经常需要安全地尝试 destructive mutation 尚无证据；当前只承诺视觉与真实交互预览，并显式提示 mutation 影响。
- **Blind Spot**：把 proxy 当成“只读预览”可能让人误以为按钮没有真实副作用，因此启动输出和 README 必须同时警示；自动打开浏览器也可能放大误操作，本阶段不自动打开。另一个已关闭的 Blind Spot 是端口不同导致 taskd 拒绝 browser `Origin`：gateway 必须先验证 dev origin，再定向重写为 upstream origin，不能原样转发或无条件改写。
- **Unknown Area**：大规模 UI 模块增长后整页 reload 是否仍足够，需要以实际 build latency 验证；当前不预先引入 Vite。验收记录初始构建与变更后 reload 延迟，若稳定超过 2 秒再重新评估 HMR。

## 非目标

- 不改变 taskd、SQLite schema、MCP、Hooks 或 adapters。
- 不改变正式 Dashboard 的 API、SSE 或 auth model。
- 不向 release archive 安装 dev server。
- 不实现公网访问、LAN 访问或 remote debugging。
- 不实现 sandbox data、mock backend、fixture editor 或组件级 HMR。
