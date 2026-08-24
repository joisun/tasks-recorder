# SVAR Gantt Dashboard 替代实现设计

## 目的

在不改变 taskd、SQLite、REST、SSE、MCP、Hook 与 adapter contracts 的前提下，用另一个真正可开源的 Gantt/Timeline/Tree library 替换 DHTMLX Gantt，交付一个可与现有 v0.4.0 Dashboard 逐项比较、可独立运行和可回归验证的生产级版本。

如果本方案在 contract spike、完整测试或视觉验收中无法满足关键要求，则不把不稳定实现描述为完成；后续必须在第二个独立 worktree 中自研 Grid/Tree/Timeline renderer。

## 实施结论

SVAR 方案已通过 pinned-package contract、完整功能矩阵、1,000-task virtualization smoke、isolated taskd runtime、release packaging 与 PC 1440 × 900 visual-driven review。随后又按“desktop Agent 项目控制面”而不是“数据库字段表”的产品目标完成二次打磨：默认周视图、可切换日/周/月粒度、summary 时间包络、六列决策 Grid、30px 行高、分组 toolbar 与精确的今天定位。浏览器审计为 Critical 0 / High 0 / Medium 0，因此 fallback gate 未触发，不创建原生 renderer worktree。最新视觉证据记录在实施计划末尾和 `.vdr-log/20260816-product-redesign-pc/`。

## First Principles

### Goal

用户需要的不是换一个 npm 包，而是一个实时、可读、可操作的 Agent Task 控制面：

- root/child Task tree 与 Timeline 必须共享同一行模型和滚动位置。
- 用户必须能看到、复制和编辑推进任务所需的完整上下文。
- SSE refresh 不得打断当前阅读和操作状态。
- 开源安装不能要求 license key、外部 CDN、云服务或构建时私有依赖。
- UI 必须达到生产级视觉、keyboard、screen reader、错误恢复与真实 packaged runtime 标准。

### Facts

- taskd 是唯一 SQLite owner；Dashboard 通过 GET /api/v1/snapshot 与 SSE invalidation 获取 authoritative state。
- dashboard-api.mjs、task-details-sheet.mjs、execution-inbox.mjs、event-stream.mjs 与 snapshot-coordinator.mjs 已独立于 DHTMLX。
- DHTMLX coupling 集中在 ui/src/dashboard.mjs、dashboard-state.mjs 的 layout helpers、dashboard.css 的 .gantt_* selectors，以及 ui/build.mjs 的 DHTMLX assets。
- 当前正式数据模型只需要 root + 一层 child；Timeline 是 readonly projection，Task mutation 仍通过现有 status menu 与 Details Sheet。
- active filter 必须同时约束 Grid rows 和 Timeline bounds；被筛掉的历史任务不能继续扩大当前视图范围。
- summary 的产品语义是项目 scope，其时间范围必须包络自身与所有 descendants，而不是只使用 root 自己的 execution 时间。

### Assumptions

- React 仅作为主 renderer 的 island 引入，不接管整个 Dashboard。
- 增加 React runtime 与 SVAR transitive dependencies 可以接受，但 release archive、离线运行和 bundle 上限必须继续通过。
- 当前时间 marker 可以由应用 shell 绘制；不能为了使用 SVAR PRO marker 引入商业 license。

### Constraints

- 依赖固定为 @svar-ui/react-gantt@2.7.1、react@19.2.8、react-dom@19.2.8。
- library 与新增 runtime dependencies 必须允许开源再分发；SVAR/React 均为 MIT。
- 只监听 127.0.0.1，不新增 token、telemetry、CDN 或远程资源。
- Dashboard 仍由 ui/build.mjs 生成单个离线 ui/dist/index.html。
- 不启用 SVAR PRO-only features；本项目不存储 license key。
- Grid/Tree/Timeline renderer 必须 readonly；业务 mutation 继续走现有 REST optimistic concurrency。
- 不改变 schema v2、API route、MCP tool、Hook 或 importer semantics。
- Desktop 默认观测窗口以项目周期为主：周视图至少 8 周；日视图和月视图是显式切换的 detail/context modes。

### Success Criteria

1. 全部 baseline tests 与新增替代 renderer contract tests 通过，新增行为均有 RED → GREEN 证据。
2. npm run check、npm run build、release packaging、packaged runtime 与 adapter tests 通过。
3. 单文件 Dashboard bundle 不含 DHTMLX、CDN、license key、watermark 或 PRO module。
4. 全部功能验收矩阵通过；没有 Critical/High/Medium 视觉 finding。
5. 真实 runtime smoke 使用隔离端口与数据库，不修改用户 ~/.config/tasks-recorder/tasks.sqlite。
6. PC 1440 × 900 完整 visual-driven review 通过；responsive 不属于本轮授权范围。
7. 1440px 首屏 Grid 无水平滚动；Toolbar 右侧保留至少 10px 安全边距；summary bar 在像素几何上包含全部可见 descendants。

## 选型

### 方案 A：SVAR React Gantt island（采用）

@svar-ui/react-gantt 的 open-source core 原生提供：

- hierarchical subtasks 与 open-task action；
- customizable Grid columns 与 React cell components；
- readonly mode；
- Grid/Timeline resizer 与 resize-grid action；
- all / grid / chart display modes；
- timeline scales、task templates、selection、scroll actions；
- MIT license 与持续发布。

应用只在 #gantt_here mount 一个 React root。外围 tabs、status menu、Details、Inbox、context popover、REST/SSE lifecycle 仍由现有 vanilla controller 管理。

风险：

- React/SVAR 增加 runtime 与 bundle 体积。
- open:true、custom cells、rapid data replacement 与 scroll restore 必须通过真实 package contract spike 验证。
- current-time marker 是 PRO-only feature，必须在 shell 中实现。

### 方案 B：jsGanttImproved（拒绝）

优点是 vanilla、ISC、近期仍发布，且自带 table/tree/timeline。

拒绝原因：公开 issue 已存在 “Columns shift apart when the left table is resized”，直接撞上本项目已经多次修复和验证的 Grid/Timeline alignment 风险；其 DOM 与 accessibility contract 也更弱。

### 方案 C：Frappe Gantt + 自研 Grid/Tree（拒绝作为第一方案）

Frappe Gantt 为 MIT、轻量、维护活跃，但只解决 SVG Timeline。Grid、Tree、shared vertical scroll、horizontal columns、splitter、keyboard disclosure 与 state restore 都要自研。这已经接近 fallback 方案，不能用于证明成熟 integrated library 是否可行。

### 排除项

- ApexGantt：官方明确为 commercial component，无 key 会显示 watermark。
- GSTC：使用 Free/Trial license terms 与 license key，不满足开源用户开箱即用。

## Architecture

    taskd snapshot + SSE
            |
    SnapshotCoordinator
            |
    DashboardController (vanilla)
      |        |             |
      |        |             +-- Details Sheet / Inbox
      |        +-- tabs / status menu / popovers / toolbar
      |
      +-- SvarGanttRenderer (React island)
              |
              +-- DashboardGantt component
              +-- custom Grid cells
              +-- task bar template
              +-- state adapter
              +-- NOW overlay

### 模块边界

#### ui/src/dashboard.mjs（controller）

保留现有入口文件并把它收敛为业务 controller，负责：

- snapshot/filter/status mutation；
- toolbar、Details、Inbox、popover 和 copy interactions；
- 把 filtered task projection 交给 renderer；
- 捕获/恢复 renderer view state；
- connection/freshness/mutation feedback。

它不读取 SVAR DOM class，不计算 timeline pixels，不直接 mount React。

#### ui/src/svar-gantt-state.mjs

纯函数边界，负责：

- Dashboard Task → SVAR Task projection；
- filter、tree order、status color、progress 与 end range；
- renderer view state normalization；
- Grid width bounds、Timeline label placement、NOW position；
- localStorage preference parsing。

该模块可在 Node test 中直接验证，不依赖 DOM/React。

#### ui/src/svar-gantt-renderer.jsx

唯一 SVAR/React integration boundary，输出：

    createSvarGanttRenderer(options): {
      render(model, viewState): void;
      refreshTask(taskId): void;
      setDisplayMode(mode): void;
      setLabelsVisible(visible): void;
      locateNow(date): void;
      captureState(): RendererViewState;
      destroy(): void;
    }

React components 只渲染可见 cell/bar：

- Task cell：tree disclosure + Details trigger + status dot + ellipsis。
- Status/Progress cell：accessible pill 或 ring + remaining/total。
- Session cell：紧凑 ID、完整值 tooltip 与完整 copy payload。
- Workspace / Branch cell：Workspace 表示 source session cwd，Branch 独立成列；两者通过 keyboard/pointer popover 暴露并可复制完整值。
- Activity cell：分钟、小时、天级的人类可读新鲜度信号。
- Task bar：status color、progress、可选 label。

#### ui/src/current-time-overlay.mjs

在 renderer 提供的 timeline viewport 上方绘制 readonly NOW line/label：

- 由 timeline bounds、scale width 与 horizontal scroll 计算 x；
- 超出 viewport 时隐藏；
- resize、scroll、snapshot 与 minute tick 时重算；
- pointer-events:none，不遮挡 library controls。

## Data Flow

1. 页面创建 controller、API、Details、Inbox、SnapshotCoordinator 与 EventSource。
2. 初次 snapshot 生成 normalized Dashboard model。
3. controller 捕获旧 renderer state，再按 active root filter 生成 projection。
4. renderer 以 stable Task ID 更新 React props；SVAR 保持 Tree/Grid/Timeline 行对齐。
5. render 完成后恢复 open IDs、Grid width、Grid/Timeline scroll 与 selection。
6. Details/Inbox 如果仍打开，按原 task/execution identity refresh。
7. SSE changed 只触发 snapshot invalidation，不直接 patch UI。
8. status/Details mutation 成功后等待 authoritative snapshot；冲突继续使用现有错误语义。

## 功能验收矩阵

### Navigation 与 filtering

- Tabs：全部、已阻塞、进行中、等待中、待安排、历史；计数只统计 root。
- Active filter 在 snapshot refresh 后保留。
- 未绑定 Inbox count 与真实 snapshot 一致。

### Grid 与 Task tree

- 默认列顺序固定为：Task、Status/Progress、Execution Context、Session ID、Activity，总宽度与 792px 默认 Grid 一致。
- 首屏用于快速判断“做什么、进展、在哪里执行、属于哪个 session、多久没活动”；说明、executions 与其他低频字段进入 Details Sheet。
- 所有列 header 与 row cells 保持对齐；长内容 ellipsis，不逐字换行；Task title 提供完整 title。
- 默认 Grid 不产生 horizontal scroll；拖宽 Grid 后仍遵循 renderer resize contract。
- root disclosure 支持 pointer、Enter、Space、ArrowLeft、ArrowRight。
- root/child open state 在 filter、SSE refresh、Timeline toggle 与 reload 后保留。
- Task column 与 Grid panel 都支持 pointer resize；Grid panel separator 支持 ArrowLeft/Right/Home/End。
- Workspace 与 Branch 单元格垂直居中、独立展示，通过单一 custom tooltip 暴露完整值并支持各自复制；不渲染原生 `title`。

### Task context 与 mutation

- Session ID 默认展示 `前 8 位…后 4 位`，tooltip 与 copy payload 保留完整值；成功/失败都有 screen-reader feedback。
- leaf 显示 status text；root with children 显示 progress ring + 未完成 N / M。
- status/progress 不只靠颜色；status menu keyboard 与 optimistic conflict 保持。
- Task row 打开现有 Details Sheet，关闭后 focus 恢复到 replacement trigger。

### Timeline

- 同一 Task row 对齐同一 Timeline bar。
- 默认周视图至少展示 8 周，日视图至少 21 天，月视图至少 240 天；用户选择持久化。
- 周/月 header 可以聚合，但 task placement 始终保留 day-level 精度，不能把短任务量化成整周或整月。
- active filter 的 bounds 只来自当前可见 projection，不受隐藏 history 扭曲。
- summary start/end 是自身与全部 descendants 的时间包络；父 bar 在几何上包含所有子 bar。
- start/due/completed/runtime end 与现有 endOf semantics 一致。
- status color、progress fill、summary range 与 collapsed root 正确。
- Timeline 可折叠/恢复；label 可显示/隐藏；定位当前时间可自动展开 Timeline。
- NOW marker 在可视时间范围内准确定位，scroll/resize/refresh 后更新。
- Timeline horizontal scroll 与 Grid vertical scroll 不互相漂移。

### Details 与 Inbox

- Summary、Executions、Activity tabs 与所有现有 actions 保持。
- Next action 改为 multiline textarea，默认能阅读完整值，允许 vertical resize。
- Toolbar 使用语义文本与分组 controls，并在 viewport 两侧保留 10px gutter；desktop Grid 使用 30px compact row、24px scale header，避免把 touch density 强加给桌面控制台。
- Inbox empty/list/filter/select/batch assign/non-work 与 focus trap/restore 保持。

### Realtime 与 failure

- SSE ready/changed/reconnect 行为不变。
- snapshot failure 保留 last good render 并显示 stale message。
- renderer initialization failure 显示可读 error state，不使 taskd 崩溃。
- no-op snapshot 不丢失 view state；快速连续 SSE refresh 仍由 coordinator 合并。

### Security、privacy 与 packaging

- 所有来自 Task/context 的字符串通过 React text nodes 或 escapeHtml 输出。
- 不注入 raw user HTML，不持久化 prompt/reasoning/tool output。
- ui/dist/index.html 离线、自包含、无 CDN/remote font/license key/watermark。
- ui/THIRD_PARTY_NOTICES.md 与 release metadata 记录 SVAR/React MIT attribution。

## Error Handling

| 场景 | 行为 |
| --- | --- |
| SVAR mount/render 失败 | React Error Boundary 在 #gantt_here 显示不泄露实现细节的 `role=alert`；下一次 render 可 reset，taskd 不受影响 |
| rapid snapshot during render | 只保留最新 model；完成后再恢复最新 view state |
| stale Task trigger | 按 stable task ID 查 replacement trigger，再 fallback 到 active tab |
| Grid width 超出 container | 按 240px minimum 与至少 320px Timeline clamp |
| NOW 超出 range | overlay hidden，不扩大 Timeline range |
| copy permission denied | 保留完整 selectable Session ID并显示失败反馈 |
| status revision conflict | 使用现有中文错误并 authoritative refresh |
| SVAR API action 不存在/异常 | contract test 失败，阻止本方案进入最终验收 |

## Testing Strategy

### TDD contract spike

先写会失败的测试，证明以下 library integration 尚不存在：

- package/build 不再包含 DHTMLX；
- Task projection 与 column definitions 覆盖完整字段；
- renderer exports 与 lifecycle contract；
- open-task、resize-grid、display mode、selection、scroll hooks 被正确接线；
- Next action textarea、语义 toolbar controls 与 30px compact Grid density。

再安装固定依赖、实现最小 integration，使 focused tests 逐项转绿。

### Unit

- pure state projection、filter/tree order、open IDs、view state、NOW x position。
- copy/context/status/progress/label semantics。
- controller ↔ renderer contract，使用小型 fake renderer，不 mock library internals。

### Integration/build

- esbuild JSX + CSS bundling。
- self-contained HTML 不包含 DHTMLX、CDN、watermark、PRO marker。
- package/release/adapters 保持 runtime completeness。
- third-party notice、license metadata、lockfile consistency。

### Browser

- isolated temporary taskd/database，覆盖 status success/conflict、SSE refresh、sheet/inbox state。
- real pointer/keyboard disclosure、copy、resize、toggle、locate、horizontal/vertical scroll。
- console/network clean；同一行 Grid/Timeline geometry 对齐。

### Visual

使用 visual-driven-review、playwright-headless、PC 1440 × 900：

- initial/filter/history/tree collapsed；
- Grid left/right horizontal states；
- widened/narrowed/hidden Timeline；
- Details Summary/Executions/Activity；
- Inbox empty/non-empty；
- status menu；
- stale/error boundary（isolated backend）。

每个 material state 保存原始截图并执行 spacing、content/container、structural residue 与 edge-spacing micro-sweep。Critical/High/Medium finding 阻止完成；Low finding 必须修复或有明确、可验证且不影响生产的依据。

## Fallback Gate

满足任一条件即判定 SVAR 方案不合格，并在新的 branch/worktree 进入自研 renderer：

1. open/collapse、Grid/Timeline row sync 或 splitter 在 pinned version 上存在无法绕过的 library bug。
2. custom cell 无法提供完整交互、ARIA/focus contract。
3. SSE data replacement 无法稳定恢复 open/scroll/selection/sheet state。
4. 必须使用 PRO/license key 才能满足关键功能。
5. self-contained bundle 超过 2 MiB 且无法通过 tree-shaking/按需 import 降低。
6. 视觉验收仍有 library-caused Medium/High/Critical defect。

Fallback worktree 必须独立于本 branch，复用本 spec 的验收矩阵，但 renderer 改为：

- semantic CSS Grid treegrid；
- 自研 virtual row model；
- SVG Timeline；
- shared vertical scroll + independent horizontal scroll；
- application-owned splitter、NOW marker 与 state store。

## Documentation

实现完成时同步：

- README.md 的 How it works、Dashboard feature list 与 license attribution。
- ui/THIRD_PARTY_NOTICES.md。
- package.json / package-lock.json dependencies。
- docs/superpowers/specs 中 DHTMLX-specific architecture references。
- release/package tests 中的 runtime allowlist 与 bundle assertions。

## Johari Review

### Open Area

- taskd/API/SSE/Details/Inbox contracts 已有测试与真实运行证据。
- SVAR open-source core 明确提供 tree、custom columns、readonly、resizer、display modes 与 actions。
- React island 可以把 framework 影响限制在 renderer boundary。

### Hidden Area

- 没有外部设计稿；视觉判断以当前 dark UI、已确认交互与通用 accessibility guideline 为准。
- responsive 已在上一轮由用户明确排除，因此本轮只对 PC 下结论。

### Blind Spot

- 官方示例不等于 pinned package 在本数据/refresh 模式下稳定；必须通过 contract spike 和真实 browser state replacement 验证。
- MIT core 与 PRO docs 混在同一站点，容易误用 marker 等 PRO feature；代码和 bundle test 必须明确禁止。
- library renderer 可能转义 string template，但 custom cells 仍必须避免 dangerouslySetInnerHTML。

### Unknown Area

- open:true 与 rapid replacement 在 2.7.1 上是否触发共享 store bug，尚不能从文档证明；第一个 implementation task 必须用真实 package/browser spike 给出确定证据。
- 真实数据量目前只有 33 Tasks；需要 synthetic 1,000-row performance smoke，不能从小数据流畅外推生产性能。

## Primary Sources

- [SVAR licenses](https://svar.dev/licenses/)：open-source Gantt core 为 MIT。
- [SVAR React Gantt repository](https://github.com/svar-widgets/react-gantt)：hierarchy、custom columns、virtualization、React 19 support。
- [SVAR columns](https://docs.svar.dev/react/gantt/guides/grid/columns/)：custom cell components。
- [SVAR resizer](https://docs.svar.dev/react/gantt/guides/appearance/resizer/)：Grid panel resize API。
- [SVAR open-task](https://docs.svar.dev/react/gantt/api/actions/open-task/)：tree disclosure action。
- [SVAR compact/display modes](https://docs.svar.dev/react/gantt/guides/compact_mode/)：all/grid/chart modes。
- [SVAR markers](https://docs.svar.dev/react/gantt/api/properties/markers/)：marker 是 PRO-only，不能使用。
- [jsGanttImproved issue #381](https://github.com/jsGanttImproved/jsgantt-improved/issues/381)：resize 后 columns shift 风险。
- [ApexGantt licensing](https://apexcharts.com/apexgantt/)：commercial component 与 watermark。
- [GSTC repository](https://github.com/neuronetio/gantt-schedule-timeline-calendar)：Free/Trial license key terms。

以上来源访问日期均为 2026-08-16。
