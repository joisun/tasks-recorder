# Tasks Recorder React + 21st.dev UI 迁移设计

**Date:** 2026-08-28
**Status:** Approved; implementation in progress
**Scope:** 在不改变 taskd、REST/SSE、SQLite、Runtime Registry 与 Agent adapter contract 的前提下，将现有 Dashboard 从 Vanilla DOM controller 迁移为 React + TypeScript UI，并建立可受控使用 21st.dev registry component 的前端基础。Agent Elements 集成属于下一份独立设计，不在本阶段实施。

## 1. 决策摘要

Tasks Recorder 将采用一个 React root 统一拥有 Dashboard DOM。目标技术栈为：

```text
React 19 + TypeScript
├── Tailwind CSS v4 + Tasks Recorder design tokens
├── shadcn-compatible primitives
├── curated 21st.dev source components
├── TanStack Query（REST server state + SSE invalidation）
└── SVAR React Gantt（现有 Tree / Timeline renderer）
```

21st.dev 不是运行时依赖或统一组件库。它是 shadcn-compatible source registry：被选中的源码在开发时写入仓库，经 license、dependency、accessibility 与 visual review 后成为 Tasks Recorder 自己维护的代码。安装、发布和运行不能依赖 21st.dev 网络、账号或 API key。

迁移采用 parallel replacement，而不是在生产 Dashboard 中混用大量 Vanilla/React islands：Legacy Dashboard 在迁移期间保持可用；新的 React Dashboard 使用独立 preview entry。通过功能、视觉和 packaged-runtime gates 后一次切换正式入口，再删除 Legacy DOM renderer。

## 2. First Principles

### Goal

建立一个统一、可维护、可验证的前端平台，使 Tasks Recorder 能持续承载：

- Project / Task Tree 与 Timeline；
- Scheduled Task、Run ledger 与设置；
- 实时 Session、tool process 与用户干预；
- keyboard、screen reader、responsive 与错误恢复；
- 后续 Agent Elements coding-agent UI。

成功不等于把 `.mjs` 改成 `.tsx`，而是让一个状态模型只拥有一份 DOM、一个 design system 和一个可测试的数据流。

### Facts

- 当前 UI 约 6,100 行；除 SVAR Gantt 外，大部分视图通过 `innerHTML` 重建并手工恢复 focus、draft、selection 与 open state。
- `dashboard.mjs`、Scheduled Run Review、Scheduled Editor、Task Details 与 Inbox controller 均已达到数百行，跨视图状态协调成本持续上升。
- React 19、ReactDOM、esbuild 与 SVAR React Gantt 已在正式 bundle 中，不是新的 runtime family。
- Dashboard 仍由 `ui/compiler.mjs` 生成单个离线 `ui/dist/index.html`；taskd 只监听 loopback 并提供 REST/SSE。
- 当前 `feature/scheduled-tasks` worktree 包含大量尚未提交的 Scheduler、Runtime Registry、Live Session 与 UI 变更。这些行为必须先成为稳定迁移基线，不能与 React 重写混成一个不可审查 diff。
- 21st.dev 官方将自身定义为 registry：不同作者、不同风格、源码复制进消费者仓库、没有上游版本自动升级。

### Assumptions

- Tasks Recorder 保留自己的产品身份，不把任意 21st Dashboard template 当成信息架构。
- 当前功能、API 语义、错误码、optimistic concurrency、privacy boundary 与本地单用户部署方式在本阶段保持不变。
- React 迁移期间允许增加开发依赖和 bundle 体积，但 release artifact 必须继续完全离线、自包含、无远程字体或 CDN。
- 21st component 只在确实减少复杂交互实现时引入；简单布局和产品特有 Tree/Timeline 不为“使用 registry”而套组件。

### Constraints

1. 不引入 Next.js、SSR、RSC、云端 deployment 或新的 Web server。
2. 保留现有 esbuild + single-file compiler；Tailwind 在 build time 编译并内联。
3. taskd 继续是唯一 server-state 与 mutation authority；browser 不直连 SQLite、CLI 或 transcript path。
4. 不在同一页面混用两套基础 primitive system。shadcn base、focus、portal、tooltip、dialog 与 menu 行为必须统一。
5. 21st source 必须逐项确认 license、依赖、tokens、motion、accessibility 与 provenance；不提交 membership token 或 `API_KEY_21ST`。
6. CI 与 release build 不从 registry 拉取组件；所有 source component 必须已提交并可离线构建。
7. 本阶段不引入 Agent Elements、Vercel AI SDK message model 或新的 Session persistence contract。

### Success Criteria

1. React preview 与 Legacy Dashboard 对全部正式能力达到 feature parity。
2. 正式入口切换后，不再由业务 controller 使用 `innerHTML` 重建页面或绑定全局 delegated event handlers。
3. REST、SSE、Run-specific SSE、revision conflict、Resume、Settings 与 Scheduler 行为保持现有 contract。
4. Tasks Tree、Timeline、splitter、resize、filter、open state、selection 与 scroll restoration 无回归。
5. Desktop、narrow desktop 与 mobile 的多状态 visual-driven review 为 Critical 0 / High 0 / Medium 0。
6. `npm run check`、server tests、UI component tests、build、release packaging、packaged runtime 与 `git diff --check` 全部通过。
7. 产物仍为离线单文件 Dashboard，不包含 remote asset、21st credential、remote font 或 build-time registry request。
8. React cutover 后删除或归档全部已替代 Legacy renderer，不能长期维护双实现。

## 3. Johari Review

### Open Area

- React runtime 和最复杂的 Timeline renderer 已经存在。
- taskd API/SSE 边界清晰，前端可以在不重写 backend 的情况下替换。
- 21st 与 Agent Elements 都建立在 React 19、Tailwind v4 和 shadcn conventions 上，先统一前端基础能降低后续集成成本。

### Hidden Area

- 用户尚未指定某个 21st theme、template 或作者作为视觉基线。本设计默认采用 Tasks Recorder 自有 design tokens，而不是选择任意社区 aesthetic。
- 21st membership/API key 是否可用不应影响架构；具体付费 component 只有在用户明确选择并提供合法访问方式后才允许进入候选集。

### Blind Spots

- Registry source 没有自动升级路径；复制代码意味着安全修复和 dependency update 由本项目维护。
- 两个 registry item 可能覆盖同名 `button.tsx`，或悄悄引入第二套 primitive、animation runtime 与 hard-coded colors。
- 全面 React 化如果同时全面重做信息架构，会把行为回归与产品变化混为一体，难以证明稳定性。
- 当前工作树尚未形成干净基线；在其上直接大范围改名会让历史功能无法审查、回滚或合并。

### Unknown Area and Validation

- 候选 21st component 的真实 dependency 与 focus/portal 行为：每个 component 先在隔离 catalog route 验证，再允许进入产品 feature。
- Tailwind v4 与当前 single-file compiler 的体积和 build performance：Phase 1 用最小 app shell spike 测量，不猜测。
- SVAR CSS 与 Tailwind/shadcn tokens 的 cascade：在 Tasks view spike 中验证 row height、font、popover z-index 与 responsive layout。
- Legacy 与 React snapshot projection 是否完全一致：用共享 fixtures 和 contract tests 比较，而不是只做截图判断。

## 4. 选型比较

### A. Parallel React replacement + curated registry（采用）

建立完整 React app，但在 cutover 前保留 Legacy 正式入口。React preview 逐个覆盖现有 surface；纯函数、API client 与 SVAR projection 尽量复用。21st 只提供经过审查的复合 component。

优点：

- 正式 Dashboard 在迁移期间持续可用；
- 每个 feature 都可做数据、交互和视觉对比；
- cutover 后只有一个 React ownership model；
- 为 Agent Elements 提供干净基础。

代价：迁移期间存在两套页面 entry，但只允许短期存在，并由明确 cutover gate 收口。

### B. 直接移植完整 21st Dashboard template（拒绝）

通用 Admin template 的 sidebar、stat cards 和 table 无法表达 SVAR Gantt、密集 Task Tree、Run-specific SSE 与多层 Sheet。先套模板再塞回能力会制造大量结构性删除和重写，也会把信息架构交给与本产品无关的模板作者。

### C. 在 Legacy Dashboard 中持续添加 React islands（拒绝）

该方法短期 diff 小，但会长期保留两套 focus、portal、state、event delegation 和 styling ownership。Scheduled Run Review 已证明 `innerHTML` renderer 与 React subtree 的生命周期会相互破坏，不适合作为全面迁移终态。

## 5. Target Architecture

```text
ui/react-entry.tsx
  └── AppProviders
      ├── QueryClientProvider
      ├── Tooltip / Dialog / Toast providers
      └── DashboardApp
          ├── AppShell
          │   ├── GlobalNavigation
          │   ├── ConnectionStatus
          │   └── SettingsTrigger
          ├── TasksFeature
          │   ├── TaskToolbar
          │   ├── TaskGantt (SVAR)
          │   ├── TaskDetailsSheet
          │   └── Project / Execution Inbox
          └── ScheduledFeature
              ├── ScheduleList
              ├── ScheduleEditorSheet
              └── RunReviewSheet
```

### 5.1 Server State

TanStack Query 管理 REST query、mutation、cache 与 invalidation：

- 全局 taskd SSE 只把 domain event 映射为 query-key invalidation；
- mutation 仍携带 expected revision，并将 409 转为现有 typed conflict；
- active Run 的 Run-specific SSE 使用专门 hook 管理 append-only ephemeral events，terminal event 到达后 invalidates authoritative Run detail；
- 不用 Redux/Zustand 保存 server facts，不在 component tree 复制第二份 authoritative state。

### 5.2 Local UI State

- filter、zoom、grid width、timeline visibility 等持久 preference 由 typed localStorage hooks 管理；
- Dialog/Sheet open state 与 draft 放在其最近 feature boundary；
- URL 不承担新的公开 routing contract；Tasks/Scheduled 仍是同一 Dashboard 的 view state；
- 不增加全局 state library，除非迁移证据表明跨 feature state 无法由 query cache 与 component composition 表达。

### 5.3 Forms

Scheduled Editor 与 Settings 使用 React Hook Form + Zod schema，以 field-level validation、dirty state 和 conflict preservation 替代手工 focus/draft restore。Server 仍执行最终 validation；前端 schema 只改善交互，不能成为安全边界。

### 5.4 SVAR Gantt

SVAR 从 `createSvarGanttRenderer()` imperative island 收敛为普通 `TaskGantt` React component：

- `svar-gantt-state.mjs` 中已验证的纯 projection 先复用，再逐步类型化；
- open IDs、selection、scroll 与 grid width 使用 controlled adapter；
- current-time overlay、custom cells、status mutation 与 Details triggers 继续保持现有 product semantics；
- 不为了 React 重构更换 Gantt library。

## 6. Source and Folder Boundaries

```text
ui/
├── src/                         # Legacy，cutover 后删除已替代 renderer
├── react/
│   ├── app/
│   ├── components/
│   │   ├── ui/                  # shadcn canonical primitives
│   │   └── registry/            # reviewed/adapted 21st source
│   ├── features/
│   │   ├── tasks/
│   │   ├── scheduled/
│   │   ├── settings/
│   │   └── inbox/
│   ├── lib/
│   │   ├── api/
│   │   ├── events/
│   │   ├── preferences/
│   │   └── schemas/
│   ├── styles/
│   │   ├── tokens.css
│   │   └── app.css
│   └── entry.tsx
├── components.json
├── compiler.mjs
└── dist/
```

Rules：

- `components/ui` 只有一份 Button、Dialog、Sheet、Tooltip、Menu 与 Form primitive；registry item 不得覆盖它们。
- `components/registry` 每个引入项记录 source URL、author、license、retrieved date 与本地修改说明。
- 21st component 必须使用 Tasks Recorder tokens；hard-coded zinc/slate/brand colors 在引入 commit 中归一化。
- feature 不直接 import registry implementation 的 internal file；通过本地 stable component facade 使用，方便后续替换。
- API DTO、presentation model 与 React component props 分层，不能让 UI registry type 泄漏进 taskd contract。

## 7. Design System Governance

### 7.1 Tokens

现有深色产品基线映射为语义 token：

- background / surface / elevated / overlay；
- foreground / muted / metadata；
- border / focus ring；
- accent / success / warning / danger；
- density、row height、radius、shadow、motion duration；
- body 与 mono typography。

所有 shadcn 和 21st component 只读取语义 token。Tasks Recorder 默认保持 compact desktop control-plane density；移动端通过 layout adaptation 增大 hit target，而不是全局放大桌面行高。

### 7.2 Registry Admission Gate

每个 21st component 必须回答：

1. 它解决了哪个现有 interaction，而不是仅提供装饰？
2. license 是否允许开源再分发与修改？
3. 它新增哪些 npm/registry dependencies？
4. 是否带 remote asset、telemetry、hard-coded theme 或第二套 portal primitive？
5. keyboard、focus、screen reader、reduced motion 与 mobile 是否通过？
6. 能否用更简单的已有 primitive 实现？

任一项不清楚，component 不进入产品。

### 7.3 Provenance and Updates

- Registry source 与本地代码一起 review、test、commit；不在 `npm install`、CI 或 release 时重新获取。
- 上游无自动升级。需要更新时，在独立 diff 中重新获取、比较、迁移本地修改并跑完整 gate。
- `API_KEY_21ST` 只能来自用户 shell，不进入 repo、log、screenshot、config 或 release archive。

## 8. Migration Sequence

### Phase 0 — Baseline Freeze

1. 在当前 `feature/scheduled-tasks` worktree 完成现有功能验证。
2. 记录 source preview、packaged runtime、tests 与 visual evidence。
3. 经用户授权后，将当前 Scheduler/Runtime/Live Session 工作按既有阶段提交或合并，形成 React migration base commit。
4. 从该 commit 创建唯一 `feature/react-dashboard` branch 与 `.worktree/feature-react-dashboard` worktree。

未形成干净 base commit 前，不开始批量 `.mjs` → `.tsx` 迁移。

### Phase 1 — Build and Design Foundation

- 增加 TypeScript typecheck、Tailwind v4 build、`components.json`、aliases 和 React entry；
- 保留 esbuild single-file compiler，将 Tailwind、shadcn、SVAR CSS 和本地 font 内联；
- 新增 React preview output/route，Legacy `index.html` 仍是正式入口；
- 建立 tokens、Button、Dialog、Sheet、Tooltip、Dropdown、Form、Toast 与 Error Boundary；
- 验证 build size、CSP、offline、dev reload 与 packaged runtime。

### Phase 2 — Shell and Tasks

- 迁移 App Shell、navigation、filter、toolbar、connection/freshness feedback；
- 把 SVAR renderer 转为 `TaskGantt` component；
- 迁移 status mutation、Details Sheet、context copy、project/execution inbox；
- 使用共享 snapshot fixtures 比较 Legacy/React task projection；
- 验证 Tree/Timeline resize、scroll、open/selection 与 responsive behavior。

### Phase 3 — Scheduled and Settings

- 迁移 Scheduled list、Run now、loading/error/empty/active/terminal states；
- 迁移 Schedule Editor、definition-directory relocation 与 runtime/model selection；
- 迁移 Run ledger、logs、Resume、Live Session 的现有 feature-parity UI；
- 迁移 Settings Dialog；
- 本阶段仍不安装 Agent Elements，不扩展 transcript/event contract。

### Phase 4 — Cutover and Cleanup

- 完成功能矩阵、component tests、visual-driven review 与 packaged runtime smoke；
- 将正式 `index.html` 切换到 React entry；
- 删除被替代的 Vanilla markup/controller、delegated handlers 与无用 CSS；
- 保留仍有复用价值的纯 state/data helpers并迁移为 typed modules；
- 更新 README、`docs/architecture.md`、maintenance 文档、release notices 和 THIRD_PARTY_NOTICES；
- React 与 Legacy 不允许作为长期双 UI 发布。

### Phase 5 — Agent Elements（下一独立项目）

完成 React cutover 后，单独设计并实施：

- normalized SessionEvent / transcript capability；
- frontend Session adapter → `UIMessage[]`；
- AgentChat、Bash、Edit、Search、Plan、Subagent、MCP 与 ToolGroup；
- full-history、stream merge、steer/stop 与 privacy contract。

该阶段不得反向改变本迁移的 UI ownership 和 registry governance。

## 9. Error and Recovery Model

- App root 使用 Error Boundary；feature failure 不应让 taskd 或其他 view 不可用。
- Query error 区分 unavailable、stale、conflict 与 validation，不用统一 toast 掩盖语义。
- SSE disconnect 保留 last good data 并呈现 reconnecting；重连只 invalidates authoritative query。
- form mutation 失败保留用户 draft；revision conflict 显示现有差异/重试语义。
- React preview failure 不影响 Legacy 正式入口；正式 cutover 后的 rollback 是切回上一个已验证 release artifact，而不是运行时双实现开关。

## 10. Verification Strategy

### Automated

- 保留 Node server/API/contract tests；
- 增加 TypeScript `tsc --noEmit`；
- 使用 Vitest + React Testing Library 验证 component state、keyboard、form、query 与 SSE hooks；
- 使用共享 fixtures 对比 Legacy 与 React 的 task projection、filter counts、timeline bounds 和 Run presentation；
- build contract 验证 single HTML、CSP、无 remote URL、无 21st credential、无 runtime registry fetch；
- release/package tests 验证全部 copied source 与 license notices 被包含。

不安装本地 Playwright package；浏览器验收继续使用已配置的 `playwright-headless` MCP。

### Visual-Driven Review Matrix

- Desktop 1440×900、narrow desktop、mobile；
- Tasks：全部 filter、各 status、collapsed/expanded tree、grid-only、timeline-only、split view、day/week/month/auto、resize 与 long content；
- Details/Inbox：empty、loading、error、conflict、copy、focus restoration；
- Scheduled：empty、multiple jobs、paused、queued、running、success、failure、run-now disabled；
- Editor/Settings：loading、validation、dirty、relocation、runtime unavailable；
- Run Review：logs、resume、live reconnect、steer conflict、terminal refresh；
- keyboard-only、focus ring、reduced motion 与 200% zoom。

### Cutover Gate

正式入口只有在以下条件同时满足时切换：

1. 功能矩阵全部通过；
2. Critical/High/Medium visual findings 为 0；
3. 真实隔离数据库 smoke 不修改用户正式数据；
4. source preview 与 packaged release artifact 行为一致；
5. docs、license、release packaging 与 rollback evidence 完整。

## 11. Documentation Impact

迁移完成时必须同步：

- `README.md`：前端架构、source preview 与开发命令；
- `docs/architecture.md`：React ownership、query/SSE flow、registry governance 与 Agent Elements phase boundary；
- maintenance 文档：component admission、registry provenance、Tailwind/shadcn update、visual review；
- `THIRD_PARTY_NOTICES`：React、SVAR、shadcn primitives、21st source 及其直接依赖；
- release/package tests：离线产物和 copied source。

## 12. Sources

- [21st.dev — The living library of interfaces](https://docs.21st.dev/)（访问于 2026-08-28）
- [21st.dev — Registries With a CLI](https://21st.dev/blog/registries-with-a-cli)（访问于 2026-08-28）
- [21st.dev — Installing a Component From a Registry URL](https://21st.dev/blog/install-component-from-registry-url)（访问于 2026-08-28）
- [Agent Elements Introduction](https://agent-elements.21st.dev/docs)（访问于 2026-08-28；仅用于下一阶段边界验证）
