# React + 21st Tasks Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Use test-driven-development for each task. Before claiming completion, use verification-before-completion and visual-driven-review.

**Goal:** 在不影响现有 Dashboard 的前提下，建立可独立预览、可打包、可测试的 React UI，并完成 App Shell 与 Tasks 主视图的首个纵向切片。

**Architecture:** 保留现有 Vanilla Dashboard 作为生产入口 `ui/dist/index.html`；新增 React 源码树与 `ui/dist/react.html` 预览入口。React 通过现有 REST + SSE API 读取实时状态，TanStack Query 管理 server state，SVAR React Gantt 继续承担 timeline。Tailwind v4、shadcn-compatible primitives 与经审计的 21st.dev source component 只在 build time 参与，最终仍输出不依赖 CDN 的单文件 HTML。

**Tech Stack:** React 19.2.8、TypeScript 7.0.2、esbuild 0.28.2、Tailwind CSS 4.3.3、shadcn CLI 4.19.0、TanStack Query 5.102.8、SVAR React Gantt 2.7.1、Vitest 4.1.11、Testing Library、Playwright MCP。

**Spec:** `docs/superpowers/specs/2026-08-28-react-21st-ui-migration-design.md`

## Global Constraints

- 本计划只覆盖 React foundation、App Shell、Tasks/SVAR vertical slice。Scheduled、Settings、production cutover、legacy cleanup、Agent Elements 各自另写计划。
- 当前 `feature/scheduled-tasks` worktree 含大量未提交的 Scheduler/runtime/UI 变更。不得 stash、reset、覆盖或把 React migration 混进同一未审查 commit。
- 任一 commit 都必须先获得用户明确授权；只 stage 本任务文件，使用 Conventional Commits，不添加 Co-Author。
- legacy `npm run dev:ui`、`ui/dist/index.html` 与现有测试必须继续工作。React preview 使用独立命令与独立输出。
- CI、release package、运行时不得访问 21st.dev、npm CDN、Google Fonts 或其他远程 UI 资源。
- 21st.dev 是 source registry，不是 runtime dependency。每个引入组件必须记录来源 URL、license、获取日期、本地修改点与 owner。
- 不新增 Redux/Zustand。remote state 使用 TanStack Query；URL 与 localStorage 只保存 UI preference；局部交互使用 React state。
- 不安装本地 Playwright package。视觉验证使用现有 `playwright-headless` MCP。
- 每个任务先写失败测试，再实现最小代码，并单独运行相关测试。三次同因失败后停止、重新判断根因。

## Scope Gate and Follow-up Plans

本计划交付后，必须按顺序另写并执行以下计划，不能把它们临时塞进本计划：

1. `React Scheduled + Settings migration`：Scheduled list/editor/run review、runtime/model selector、settings panel。
2. `React production cutover`：完整 parity、正式入口切换、release packaging、legacy removal。
3. `Agent Elements integration`：在稳定 React runtime 上迁移 live session thread、tool events、steer/stop interaction。

---

### Task 0: Freeze the Scheduled Baseline and Create an Isolated Worktree

**Files:**
- Verify: all currently modified/untracked files in `feature/scheduled-tasks`
- Create later: `.worktree/feature-react-dashboard`

**Interfaces / invariants:**
- `feature/scheduled-tasks` must become a reproducible baseline before React work starts.
- React worktree must map one-to-one to branch `feature/react-dashboard`.
- No existing user changes may be silently included, dropped, or moved.

- [ ] **Step 1: Record the exact baseline and verify the current worktree**

Run:

```bash
git rev-parse --show-toplevel
git branch --show-current
git status --short
git diff --stat
git ls-files --others --exclude-standard
```

Expected: top-level is `.worktree/feature-scheduled-tasks`; branch is `feature/scheduled-tasks`; the complete scheduled/runtime/UI change set is visible.

- [ ] **Step 2: Verify the baseline before asking for commit authorization**

Run:

```bash
npm run check
npm test
npm run build
```

Expected: all commands exit 0. If a failure predates React work, record the failing test and stop; do not create the migration branch from an unverified baseline.

- [ ] **Step 3: Present the baseline diff and request explicit phase-commit authorization**

Report:

- changed and untracked file list;
- focused test/build evidence;
- proposed commit boundary for the existing scheduled/runtime phase;
- proposed Conventional Commit message.

Do not run `git add` or `git commit` before the user authorizes it.

- [ ] **Step 4: After authorization, commit only the reviewed baseline**

Run the exact staged-file list approved by the user, then:

```bash
git diff --cached --check
git commit -m "feat: add file-native scheduled agent runtime"
```

Expected: commit succeeds and `git status --short` is empty. If the user intentionally leaves unrelated changes, list them and do not carry them into the React worktree.

- [ ] **Step 5: Create and verify the isolated worktree**

Run from repository root:

```bash
git worktree list --porcelain
git branch --list feature/react-dashboard
git worktree add .worktree/feature-react-dashboard -b feature/react-dashboard feature/scheduled-tasks
git -C .worktree/feature-react-dashboard rev-parse --show-toplevel
git -C .worktree/feature-react-dashboard branch --show-current
git -C .worktree/feature-react-dashboard status --short
```

Expected: the new top-level is exactly `.worktree/feature-react-dashboard`, branch is `feature/react-dashboard`, and status is clean. Use that absolute worktree path for every remaining step.

---

### Task 1: Add a Deterministic React + TypeScript Test Toolchain

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `ui/react/test/setup.ts`
- Create: `ui/react/test/toolchain.test.ts`
- Create: `test/react-toolchain-contract.test.mjs`

**Interfaces / invariants:**
- `npm run check` covers `.mjs` syntax and TypeScript type checking.
- `npm run test:ui` runs only React unit/component tests in jsdom.
- Existing `npm test` remains the Node integration suite.

- [ ] **Step 1: Write the failing toolchain contract test**

Create `test/react-toolchain-contract.test.mjs`:

```js
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('React UI toolchain is pinned and independently testable', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url)))
  assert.equal(pkg.scripts['check:types'], 'tsc --noEmit')
  assert.equal(pkg.scripts['test:ui'], 'vitest run')
  assert.equal(pkg.devDependencies.typescript, '7.0.2')
  assert.equal(pkg.devDependencies.vitest, '4.1.11')
  assert.equal(pkg.devDependencies.tailwindcss, '4.3.3')
  assert.equal(pkg.devDependencies['@tailwindcss/postcss'], '4.3.3')
  assert.equal(pkg.devDependencies['@testing-library/jest-dom'], '7.0.1')
})
```

- [ ] **Step 2: Run the contract test and confirm failure**

Run:

```bash
node --test test/react-toolchain-contract.test.mjs
```

Expected: FAIL because scripts and dependencies do not exist.

- [ ] **Step 3: Install exact build/test dependencies**

Run:

```bash
npm install --save-dev --save-exact typescript@7.0.2 @types/react@19.2.18 @types/react-dom@19.2.5 tailwindcss@4.3.3 @tailwindcss/postcss@4.3.3 postcss@8.5.26 vitest@4.1.11 @testing-library/react@16.3.3 @testing-library/user-event@14.6.6 @testing-library/jest-dom@7.0.1 jsdom@30.0.1
npm install --save-exact @tanstack/react-query@5.102.8 class-variance-authority@0.7.1 clsx@2.1.1 tailwind-merge@3.6.0 lucide-react@1.34.0
```

Update scripts to:

```json
{
  "check": "node scripts/check-syntax.mjs && npm run check:types",
  "check:types": "tsc --noEmit",
  "test:ui": "vitest run"
}
```

- [ ] **Step 4: Add strict TypeScript and Vitest configuration**

Create `tsconfig.json` with `strict: true`, `noEmit: true`, `moduleResolution: "Bundler"`, `jsx: "react-jsx"`, `allowJs: false`, DOM libraries, and `include: ["ui/react/**/*.ts", "ui/react/**/*.tsx", "vitest.config.ts"]`.

Create `vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'jsdom',
    setupFiles: ['./ui/react/test/setup.ts'],
    include: ['ui/react/**/*.test.{ts,tsx}'],
    restoreMocks: true,
  },
})
```

Create `ui/react/test/setup.ts`:

```ts
import '@testing-library/jest-dom/vitest'
```

Create `ui/react/test/toolchain.test.ts`:

```ts
import { expect, test } from 'vitest'

test('React UI test toolchain boots in jsdom', () => {
  const element = document.createElement('div')
  element.textContent = 'Tasks Recorder'
  document.body.append(element)
  expect(element).toHaveTextContent('Tasks Recorder')
})
```

- [ ] **Step 5: Run focused verification**

Run:

```bash
node --test test/react-toolchain-contract.test.mjs
npm run check:types
npm run test:ui
```

Expected: contract, strict type check, and the jsdom smoke test pass without enabling `passWithNoTests`.

- [ ] **Step 6: Prepare the phase commit**

After explicit authorization:

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts ui/react/test/setup.ts ui/react/test/toolchain.test.ts test/react-toolchain-contract.test.mjs
git diff --cached --check
git commit -m "build: add React dashboard toolchain"
```

---

### Task 2: Build a Dual-Entry Single-File React Preview

**Files:**
- Modify: `ui/compiler.mjs`
- Modify: `ui/build.mjs`
- Modify: `ui/dev-runtime.mjs`
- Modify: `ui/dev-server.mjs`
- Modify: `package.json`
- Create: `ui/react/index.html`
- Create: `ui/react/entry.tsx`
- Create: `ui/react/app/dashboard-app.tsx`
- Create: `ui/react/styles/app.css`
- Create: `test/react-dashboard-build.test.mjs`
- Test: `test/dashboard-build.test.mjs`

**Interfaces / invariants:**
- `compileDashboard()` and `writeDashboard()` retain legacy behavior.
- New `compileReactDashboard()` returns one complete HTML document with one inline style block and one inline module script.
- `writeReactDashboard()` writes atomically to `ui/dist/react.html`.
- `npm run dev:ui:react` serves the React preview through the existing REST/SSE proxy and live-reload gateway.

- [ ] **Step 1: Write failing compiler tests**

Create `test/react-dashboard-build.test.mjs` asserting:

```js
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { compileDashboard, compileReactDashboard } from '../ui/compiler.mjs'

test('React preview compiles to an offline single-file document', async () => {
  const html = await compileReactDashboard()
  assert.match(html, /id="root"/)
  assert.match(html, /Tasks Recorder/)
  assert.equal((html.match(/<script type="module">/g) ?? []).length, 1)
  assert.equal((html.match(/<style>/g) ?? []).length, 1)
  assert.doesNotMatch(html, /<script[^>]+src=|<link[^>]+href=/)
  assert.doesNotMatch(html, /https?:\/\//)
})

test('adding the React compiler does not change legacy compilation', async () => {
  const html = await compileDashboard()
  assert.match(html, /wx-gantt/)
  assert.match(html, /\/api\/v1\/snapshot/)
})

test('build command writes both legacy and React artifacts', async () => {
  const html = await readFile(new URL('../ui/dist/react.html', import.meta.url), 'utf8')
  assert.match(html, /id="root"/)
})
```

- [ ] **Step 2: Run and confirm failure**

Run:

```bash
node --test test/react-dashboard-build.test.mjs
```

Expected: FAIL because `compileReactDashboard` and `ui/dist/react.html` do not exist.

- [ ] **Step 3: Add the minimal React entry and HTML template**

`ui/react/entry.tsx`:

```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { DashboardApp } from './app/dashboard-app'
import './styles/app.css'

const root = document.getElementById('root')
if (!root) throw new Error('React Dashboard root is missing')

createRoot(root).render(
  <StrictMode>
    <DashboardApp />
  </StrictMode>,
)
```

`ui/react/app/dashboard-app.tsx` initially renders a semantic `<main>` with visible title `Tasks Recorder` and preview badge `React preview`.

`ui/react/index.html` contains `/*__REACT_CSS__*/` and `/*__REACT_JS__*/` replacement markers, no remote resources, and `<div id="root"></div>`.

- [ ] **Step 4: Extend the compiler without coupling the two builds**

Add named exports:

```js
export async function compileReactDashboard({
  sourceRoot = join(uiRoot, 'react'),
  buildImpl = build,
} = {})

export async function writeReactDashboard({
  outputPath = join(uiRoot, 'dist', 'react.html'),
  compile = compileReactDashboard,
} = {})
```

The React compiler must:

- bundle `entry.tsx` as ESM with esbuild;
- collect emitted JS and CSS;
- process `styles/app.css` with Tailwind/PostCSS in memory before inlining;
- reject remote font or asset URLs;
- use the same atomic temporary-file/rename strategy as legacy output.

Refactor the atomic writer into one private helper only after both paths are covered by tests.

- [ ] **Step 5: Add explicit build/dev entry points**

Update `ui/build.mjs` to write both outputs with `Promise.all`.

Add script:

```json
"dev:ui:react": "node ui/dev-server.mjs --entry=react"
```

Parse only the exact `--entry=legacy|react` argument. Pass the selected compiler and selected source roots to `startDashboardDevRuntime`; keep `dev:ui` defaulting to legacy.

Change `watchDashboardSources` to accept `sourceRoots: string[]`, open one recursive watcher per root, and expose one `close()` that closes all watchers. React mode watches `ui/react`; legacy mode watches `ui/src`.

- [ ] **Step 6: Verify dual build and live development**

Run:

```bash
npm run build
node --test test/react-dashboard-build.test.mjs test/dashboard-build.test.mjs
npm run check
```

Then launch:

```bash
npm run dev:ui:react
```

Expected: gateway prints one local URL, React shell loads at `/`, `/api/v1/meta` is proxied, editing a TSX file causes one rebuild/reload, and legacy build tests remain green.

- [ ] **Step 7: Prepare the phase commit**

After explicit authorization:

```bash
git add package.json ui/compiler.mjs ui/build.mjs ui/dev-runtime.mjs ui/dev-server.mjs ui/react/index.html ui/react/entry.tsx ui/react/app/dashboard-app.tsx ui/react/styles/app.css test/react-dashboard-build.test.mjs
git diff --cached --check
git commit -m "feat(ui): add isolated React dashboard preview"
```

---

### Task 3: Establish the Design System and 21st.dev Admission Boundary

**Files:**
- Create: `ui/components.json`
- Create: `ui/react/lib/cn.ts`
- Create: `ui/react/styles/tokens.css`
- Modify: `ui/react/styles/app.css`
- Create: `ui/react/components/ui/button.tsx`
- Create: `ui/react/components/ui/tooltip.tsx`
- Create: `ui/react/components/ui/tabs.tsx`
- Create: `ui/react/components/ui/separator.tsx`
- Create: `ui/react/components/ui/sheet.tsx`
- Create: `ui/react/components/ui/dropdown-menu.tsx`
- Create: `ui/react/components/registry/README.md`
- Create: `ui/react/components/system/design-system.test.tsx`
- Modify: `server/THIRD_PARTY_NOTICES.md`

**Interfaces / invariants:**
- Components use local CSS variables; no raw product color literals inside feature components.
- Default density is compact: 32px controls, 36px table rows, 12/13px metadata/body type.
- Focus visibility, keyboard navigation, reduced motion, and 4.5:1 body text contrast are enforced.
- Registry imports are copied source with provenance, not fetched at runtime.

- [ ] **Step 1: Write failing design-system tests**

`design-system.test.tsx` must verify:

- a default Button renders at least a 32px target and keeps an accessible name;
- icon-only Button requires `aria-label` in its public TypeScript props or wrapper contract;
- Tooltip content becomes available on focus;
- Tabs supports ArrowLeft/ArrowRight keyboard navigation;
- tokens expose `--surface-0`, `--surface-1`, `--border-subtle`, `--text-primary`, `--text-muted`, `--accent`, `--danger`, `--success`, `--row-height`, and `--control-height`.

Run:

```bash
npm run test:ui -- ui/react/components/system/design-system.test.tsx
```

Expected: FAIL because components and tokens do not exist.

- [ ] **Step 2: Configure shadcn for the existing esbuild app**

Create `ui/components.json` with:

```json
{
  "$schema": "https://ui.shadcn.com/schema.json",
  "style": "new-york",
  "rsc": false,
  "tsx": true,
  "tailwind": {
    "css": "react/styles/app.css",
    "baseColor": "neutral",
    "cssVariables": true
  },
  "aliases": {
    "components": "./react/components",
    "utils": "./react/lib/cn",
    "ui": "./react/components/ui",
    "lib": "./react/lib",
    "hooks": "./react/hooks"
  },
  "iconLibrary": "lucide"
}
```

Run from `ui/` and inspect every generated diff:

```bash
npx --yes shadcn@4.19.0 add button tooltip tabs separator sheet dropdown-menu
```

If the CLI attempts to replace build tooling, global styles, React versions, or path layout, abort and copy the official component source manually into the paths above. Do not accept generated changes outside the declared files.

- [ ] **Step 3: Define Tasks Recorder tokens and compact primitives**

`tokens.css` owns semantic colors, spacing, radii, typography, control height, row height, shadows, z-index, and motion duration for light/dark themes. `app.css` imports Tailwind first and tokens second:

```css
@import "tailwindcss";
@import "./tokens.css";

@source "../**/*.{ts,tsx}";
```

Use system font stacks; do not add external fonts. Keep primary surfaces neutral and reserve accent colors for selection, progress, and status.

- [ ] **Step 4: Add an explicit 21st.dev source admission record**

`ui/react/components/registry/README.md` defines one row per copied component:

```md
| Component | Source | Retrieved | License | Local owner | Local changes |
| --- | --- | --- | --- | --- | --- |
```

The initial table states that no 21st.dev component has yet passed admission. This is intentional: the foundation uses audited shadcn primitives, and a 21st component is admitted only when a concrete product interaction requires it.

Add the policy to `server/THIRD_PARTY_NOTICES.md`: shadcn component source and later 21st registry source must retain their upstream license/provenance. Do not claim that the entire UI is licensed by a registry.

- [ ] **Step 5: Run component, type, and offline-build verification**

Run:

```bash
npm run test:ui -- ui/react/components/system/design-system.test.tsx
npm run check
npm run build
node --test test/react-dashboard-build.test.mjs
```

Expected: all pass; `ui/dist/react.html` contains no remote URL or missing stylesheet.

- [ ] **Step 6: Prepare the phase commit**

After explicit authorization:

```bash
git add ui/components.json ui/react/lib/cn.ts ui/react/styles/tokens.css ui/react/styles/app.css ui/react/components/ui ui/react/components/registry/README.md ui/react/components/system/design-system.test.tsx server/THIRD_PARTY_NOTICES.md package.json package-lock.json
git diff --cached --check
git commit -m "feat(ui): establish dashboard design system"
```

---

### Task 4: Add Typed REST, Query, and SSE Infrastructure

**Files:**
- Create: `ui/react/lib/api/types.ts`
- Create: `ui/react/lib/api/dashboard-api.ts`
- Create: `ui/react/lib/query/keys.ts`
- Create: `ui/react/lib/query/client.ts`
- Create: `ui/react/lib/events/dashboard-event-source.ts`
- Create: `ui/react/app/app-providers.tsx`
- Modify: `ui/react/entry.tsx`
- Create: `ui/react/lib/api/dashboard-api.test.ts`
- Create: `ui/react/lib/events/dashboard-event-source.test.ts`

**Interfaces / invariants:**
- The React client reuses the current HTTP contract, not the legacy DOM controller.
- Every request has a typed success shape and one normalized `DashboardApiError`.
- SSE is a single connection per app; events invalidate targeted query keys rather than mutating duplicated caches.
- Reconnect uses browser `EventSource` behavior and exposes `connecting|open|closed` state.

- [ ] **Step 1: Write failing API and event tests**

Cover these cases:

- `/api/v1/snapshot` returns a typed `DashboardSnapshot`;
- non-JSON, HTTP error, server `{ ok: false }`, timeout, and network failure normalize to `DashboardApiError`;
- `updateTask` sends `expected_revision`, `patch`, and `actor: "user"` exactly once;
- one `tasks.changed` event invalidates `queryKeys.snapshot`, `queryKeys.task(id)`, and `queryKeys.executions`;
- closing the event source removes listeners and prevents later invalidation.

Run:

```bash
npm run test:ui -- ui/react/lib/api/dashboard-api.test.ts ui/react/lib/events/dashboard-event-source.test.ts
```

Expected: FAIL because the typed client does not exist.

- [ ] **Step 2: Define only server-backed types used by the Tasks slice**

Start with exact types for:

```ts
export type TaskStatus = 'planned' | 'active' | 'waiting' | 'blocked' | 'done' | 'archived'

export interface TaskRecord {
  id: string
  parent_id: string | null
  project: string
  title: string
  description: string | null
  status: TaskStatus
  start_date: string | null
  due_date: string | null
  next_action: string | null
  revision: number
  updated_at: string
  workspace: string | null
  branch: string | null
  session_id: string | null
}
```

Derive remaining fields from actual `/api/v1/snapshot`, `/api/v1/tasks/:id`, and `/api/v1/executions` response fixtures. Do not invent nullable fields to silence TypeScript.

- [ ] **Step 3: Implement the typed client and stable query keys**

Expose:

```ts
export interface DashboardApi {
  meta(): Promise<DashboardMeta>
  snapshot(): Promise<DashboardSnapshot>
  task(id: string): Promise<TaskDetailResponse>
  executions(filters?: ExecutionFilters): Promise<ExecutionRecord[]>
  updateTask(id: string, expectedRevision: number, patch: TaskPatch): Promise<TaskMutationResponse>
  resumeTask(id: string): Promise<TaskResumeResponse>
  archiveTask(id: string, expectedRevision: number): Promise<TaskMutationResponse>
  restoreTask(id: string, expectedRevision: number): Promise<TaskMutationResponse>
  updateExecutionAssignments(input: ExecutionAssignmentPatch): Promise<ExecutionAssignmentResponse>
  assignSourceSessionProject(sourceSessionId: string, projectId: string, expectedProjectId?: string | null): Promise<ProjectAssignmentResponse>
}
```

Keep `queryKeys` as functions returning readonly tuples; never concatenate cache keys in feature code.

- [ ] **Step 4: Add providers and one event invalidation coordinator**

`AppProviders` constructs one `QueryClient`, uses sane local defaults (`staleTime: 15_000`, `retry: 1`, no refetch on window focus), and mounts `DashboardEventSourceProvider` once.

Update `entry.tsx`:

```tsx
<AppProviders>
  <DashboardApp />
</AppProviders>
```

- [ ] **Step 5: Verify contract behavior**

Run:

```bash
npm run test:ui -- ui/react/lib/api/dashboard-api.test.ts ui/react/lib/events/dashboard-event-source.test.ts
npm run check
```

Expected: all cases pass, including cleanup and normalized errors.

- [ ] **Step 6: Prepare the phase commit**

After explicit authorization:

```bash
git add ui/react/lib/api ui/react/lib/query ui/react/lib/events ui/react/app/app-providers.tsx ui/react/entry.tsx
git diff --cached --check
git commit -m "feat(ui): add typed dashboard data layer"
```

---

### Task 5: Implement the App Shell and Global Navigation

**Files:**
- Modify: `ui/react/app/dashboard-app.tsx`
- Create: `ui/react/app/app-shell.tsx`
- Create: `ui/react/app/navigation.tsx`
- Create: `ui/react/app/connection-status.tsx`
- Create: `ui/react/app/app-shell.test.tsx`
- Create: `ui/react/lib/preferences/dashboard-preferences.ts`

**Interfaces / invariants:**
- Top navigation exposes `Tasks` and a labeled disabled migration state for `Scheduled`; Settings opens only after that route is migrated, not as a dead control.
- Global actions never sit flush against viewport edges; shell owns consistent horizontal/vertical safe padding.
- Connection state is concise and non-alarming: icon + accessible label, with detail in Tooltip.
- Selected top-level view is URL-backed (`?view=tasks`) so reload preserves context.

- [ ] **Step 1: Write failing shell behavior tests**

Test:

- `Tasks Recorder`, task count, and connection state are present;
- `Tasks` is selected and keyboard reachable;
- `Scheduled` has an accessible `aria-disabled="true"` migration state rather than opening incomplete UI;
- global action group has its own padding token and no absolute edge positioning;
- `?view=tasks` is stable across render and refresh.

Run:

```bash
npm run test:ui -- ui/react/app/app-shell.test.tsx
```

Expected: FAIL because the shell does not exist.

- [ ] **Step 2: Build the shell from local primitives**

Use semantic `<header>`, `<nav>`, `<main>`, and `<aside>` only where their landmark meaning is real. Use Lucide icons with visible Tooltip labels for icon-only actions. Avoid decorative eyebrow labels, fake status alerts, gradients, oversized cards, and gratuitous animation.

Layout targets:

- 48px global header;
- 12px outer inset on desktop, 8px at narrow width;
- 32px controls;
- muted 1px separators;
- one visually dominant content surface.

- [ ] **Step 3: Connect real meta/query and connection state**

Fetch `/api/v1/meta` and `/api/v1/snapshot` through Query hooks. The header must render stale cached content during reconnect and avoid replacing the entire page with a spinner.

- [ ] **Step 4: Verify shell behavior and responsive structure**

Run:

```bash
npm run test:ui -- ui/react/app/app-shell.test.tsx
npm run check
npm run build
```

Then use `playwright-headless` at 1440×900 and 1024×768 to verify no horizontal page overflow, clipped actions, edge-touching controls, or inaccessible tooltip-only labels.

- [ ] **Step 5: Prepare the phase commit**

After explicit authorization:

```bash
git add ui/react/app ui/react/lib/preferences/dashboard-preferences.ts
git diff --cached --check
git commit -m "feat(ui): add React dashboard app shell"
```

---

### Task 6: Port the Task Projection and SVAR Timeline as a React Feature

**Files:**
- Create: `ui/react/features/tasks/task-types.ts`
- Create: `ui/react/features/tasks/task-projection.ts`
- Create: `ui/react/features/tasks/task-projection.test.ts`
- Create: `ui/react/features/tasks/task-gantt.tsx`
- Create: `ui/react/features/tasks/task-gantt.test.tsx`
- Create: `ui/react/features/tasks/task-columns.tsx`
- Reference for parity: `ui/src/svar-gantt-renderer.jsx`
- Reference for parity: `ui/src/dashboard-renderer-controller.mjs`

**Interfaces / invariants:**
- Project is level 1; main task level 2; subtask level 3+.
- A parent bar spans the min child start to max child end and never visually crosses outside its children’s scope.
- Parent progress is a compact bar with `completed/total`; leaf tasks use status dots.
- All children done makes the displayed parent complete, while archival remains explicit/manual or server policy-driven.
- Stable row keys and explicit hierarchy prevent viewport width changes from changing row order or row count.
- Default time window expresses project control, not one-day detail: choose day/week/month scale based on visible domain and viewport.

- [ ] **Step 1: Write failing pure projection tests**

Cover:

- project → main task → subtask hierarchy;
- latest activity descending within siblings;
- all-child-done parent rollup;
- parent time scope contains every descendant;
- independent task retains full-size status treatment;
- leaf planned state maps to dash-dot visual token;
- changing viewport width changes scale density only, never row IDs/order/count;
- empty, archived, missing-date, and mixed-timezone fixtures.

Run:

```bash
npm run test:ui -- ui/react/features/tasks/task-projection.test.ts
```

Expected: FAIL because projection code does not exist.

- [ ] **Step 2: Extract a pure, typed projection**

Expose:

```ts
export function projectTaskSnapshot(
  snapshot: DashboardSnapshot,
  options: TaskProjectionOptions,
): TaskGanttModel

export function chooseTimelineScale(
  domain: TimelineDomain,
  viewportWidth: number,
): TimelineScale
```

No DOM, SVAR instance, localStorage, or network access is allowed in these functions.

- [ ] **Step 3: Render SVAR directly from React**

`TaskGantt` imports `@svar-ui/react-gantt` directly. Do not create a second `createRoot`, bridge DOM events through custom events, or retain the legacy React island lifecycle.

Pass projected rows/links/columns as props. Keep selected row, expanded groups, and scale preference in feature state or URL/local preferences. Use one callback boundary for task selection and one for column resize.

- [ ] **Step 4: Isolate column resizing**

Each grid column owns its own width. Dragging the right edge of Workspace changes only Workspace width; it must not mutate the left pane width or timeline width. The grid/timeline splitter is a separate control with its own preference key.

Add a component test that drags a mocked Workspace resize handle and asserts:

- Workspace width changes;
- adjacent column widths remain stable;
- global grid width remains stable unless the explicit splitter is dragged.

- [ ] **Step 5: Verify projection and renderer**

Run:

```bash
npm run test:ui -- ui/react/features/tasks/task-projection.test.ts ui/react/features/tasks/task-gantt.test.tsx
npm run check
npm run build
```

Expected: projection edge cases and resize isolation pass; bundle remains offline.

- [ ] **Step 6: Prepare the phase commit**

After explicit authorization:

```bash
git add ui/react/features/tasks
git diff --cached --check
git commit -m "feat(ui): port task timeline to React"
```

---

### Task 7: Complete the Tasks Toolbar, Mutations, Context Columns, and Details Sheet

**Files:**
- Create: `ui/react/features/tasks/tasks-view.tsx`
- Create: `ui/react/features/tasks/tasks-toolbar.tsx`
- Create: `ui/react/features/tasks/task-status-control.tsx`
- Create: `ui/react/features/tasks/task-details-sheet.tsx`
- Create: `ui/react/features/tasks/context-cell.tsx`
- Create: `ui/react/features/tasks/tasks-view.test.tsx`
- Create: `ui/react/features/tasks/context-cell.test.tsx`
- Modify: `ui/react/app/dashboard-app.tsx`

**Interfaces / invariants:**
- Toolbar supports status scope, hierarchy expand/collapse, Today, scale, and search without duplicating global navigation.
- Column order is Task, Last active, Progress/Status, Workspace, Branch, Session ID, Activity.
- Last active uses relative `xm/xh/xd ago` for recent values and absolute local date for older values.
- Workspace, Branch, and Session ID copy affordances use one Tooltip implementation and no native `title` attribute.
- Workspace copy is the session context directory used for resume; branch is a separate field/column.
- Leaf mutations use optimistic UI only when rollback and revision conflict are handled.

- [ ] **Step 1: Write failing interaction tests**

Cover:

- filter/search does not mutate server data;
- group expand/collapse preserves selection;
- leaf status selector exposes planned/active/waiting/blocked/done/archive actions;
- archive never happens automatically at render time;
- copy buttons produce exact plain text and show one Tooltip only;
- Workspace copy is one path line, Branch copy is one branch line, Session ID copy is exact ID;
- successful mutation invalidates snapshot/task queries;
- revision conflict restores prior UI and opens a concise conflict message in the sheet;
- Resume button calls `resumeTask(id)` only for records with session context.

Run:

```bash
npm run test:ui -- ui/react/features/tasks/tasks-view.test.tsx ui/react/features/tasks/context-cell.test.tsx
```

Expected: FAIL because Tasks interactions do not exist.

- [ ] **Step 2: Build the compact toolbar and context cells**

Use one 40px toolbar row on desktop and a wrapping two-row layout below 900px. Hide labels only when Tooltip and accessible name remain. Truncated content uses CSS ellipsis; the custom Tooltip owns full content. Never add `title`.

- [ ] **Step 3: Add task mutations through Query hooks**

Create mutation hooks colocated under `features/tasks` for update/archive/restore/resume. Use `onMutate` to snapshot only the affected query, `onError` to restore it, and `onSettled` to invalidate canonical keys.

Do not let a client-only parent status overwrite server data. The UI rollup is derived; explicit user mutation is the only write.

- [ ] **Step 4: Implement the details Sheet**

The Sheet shows title, status, description, next action, workspace, branch, session ID, activity timestamps, child summary, events, and resume/archive controls. It fetches task detail lazily on open and retains prior detail while refreshing.

- [ ] **Step 5: Verify component behavior**

Run:

```bash
npm run test:ui -- ui/react/features/tasks
npm run check
npm run build
node --test test/react-dashboard-build.test.mjs test/dashboard-build.test.mjs
```

Expected: mutations, copy behavior, responsive toolbar, and dual builds pass.

- [ ] **Step 6: Prepare the phase commit**

After explicit authorization:

```bash
git add ui/react/features/tasks ui/react/app/dashboard-app.tsx
git diff --cached --check
git commit -m "feat(ui): complete React tasks workspace"
```

---

### Task 8: Port Project and Execution Inbox Parity

**Files:**
- Create: `ui/react/features/inbox/project-inbox.tsx`
- Create: `ui/react/features/inbox/execution-inbox.tsx`
- Create: `ui/react/features/inbox/inbox-drawer.tsx`
- Create: `ui/react/features/inbox/inbox.test.tsx`
- Modify: `ui/react/features/tasks/tasks-view.tsx`
- Reference for parity: `ui/src/project-inbox.mjs`
- Reference for parity: `ui/src/execution-inbox.mjs`

**Interfaces / invariants:**
- Unassigned project/session executions remain visible and actionable.
- Inbox is a secondary sheet/drawer, not an always-visible competing dashboard.
- Assignment mutations use current server revision/expected project semantics.
- Counts in the toolbar and rows come from one canonical query result.

- [ ] **Step 1: Write failing inbox tests**

Test empty, loading, error, mixed unassigned records, project assignment, task assignment, conflict rollback, and keyboard closing/focus return.

Run:

```bash
npm run test:ui -- ui/react/features/inbox/inbox.test.tsx
```

Expected: FAIL because inbox components do not exist.

- [ ] **Step 2: Implement one unified Inbox drawer**

Use Tabs inside one Sheet for Project and Execution. The toolbar shows one total badge; the drawer owns empty/error/loading states. Avoid separate card stacks or alert banners.

- [ ] **Step 3: Wire assignment mutations**

Use `assignSourceSessionProject` and `updateExecutionAssignments` through the typed API. Invalidate inbox, execution, and snapshot keys only after mutation settles.

- [ ] **Step 4: Verify inbox parity**

Run:

```bash
npm run test:ui -- ui/react/features/inbox/inbox.test.tsx
npm run check
npm run build
```

- [ ] **Step 5: Prepare the phase commit**

After explicit authorization:

```bash
git add ui/react/features/inbox ui/react/features/tasks/tasks-view.tsx
git diff --cached --check
git commit -m "feat(ui): port task assignment inboxes"
```

---

### Task 9: Make React Preview a First-Class Development and Release Artifact

**Files:**
- Modify: `scripts/package-release.mjs`
- Modify: `test/release-package.test.mjs`
- Modify: `test/package-runtime.test.mjs`
- Modify: `README.md`
- Modify: `docs/architecture.md`
- Create: `docs/ui-component-sources.md`
- Modify: `docs/superpowers/specs/2026-08-28-react-21st-ui-migration-design.md`
- Create: `test/react-release-contract.test.mjs`

**Interfaces / invariants:**
- React remains preview-only in this phase; `index.html` is still legacy production.
- Release archive contains `ui/dist/react.html` for controlled preview, but server routing must not silently switch production users.
- README explains exact local preview commands, current migration status, and why publish is unnecessary during development.
- Architecture docs reflect dual UI entry points and the source-registry trust boundary.

- [ ] **Step 1: Write failing release contract**

Assert the release staging directory contains both `ui/dist/index.html` and `ui/dist/react.html`, both are offline single-file assets, and package generation does not invoke a registry/network command.

Run:

```bash
node --test test/react-release-contract.test.mjs
```

Expected: FAIL until packaging and test fixtures include the React preview.

- [ ] **Step 2: Package the preview artifact without changing production routing**

Extend only the existing `ui/dist` copy/allowlist. Do not add a server route redirect or replace `index.html` in this task.

- [ ] **Step 3: Update public and architecture documentation**

README development section must include:

```bash
npm ci
npm run taskd:run
npm run dev:ui:react
```

Explain that source preview rebuilds live and does not require `npm publish`, installer execution, or taskd reinstall.

`docs/architecture.md` documents:

- legacy production and React preview boundaries;
- REST/SSE data flow;
- build-time Tailwind/shadcn/21st source flow;
- TanStack Query cache/invalidation ownership;
- planned cutover gate.

`docs/ui-component-sources.md` becomes the human-readable provenance index and links to the machine-local registry README.

Update the design spec status to `Implemented: foundation and Tasks vertical slice; Scheduled/Settings/cutover/Agent Elements pending` only after all acceptance checks pass.

- [ ] **Step 4: Perform the required documentation tree scan**

Run:

```bash
git diff --name-only HEAD
find . -name "*.md" -not -path "*/node_modules/*" -not -path "*/.git/*"
rg -n "ui/dist/index\.html|dev:ui|dashboard\.mjs|SVAR|Scheduled|Settings|21st|React" --glob "*.md" .
```

Update every matching public contract affected by the dual-entry build. If no further file needs changes, report exactly: `扫描了文档树，无需同步`.

- [ ] **Step 5: Verify packaging and docs**

Run:

```bash
npm run check
npm test
npm run test:ui
npm run build
npm run package:release
node --test test/react-release-contract.test.mjs test/release-package.test.mjs test/package-runtime.test.mjs
```

Expected: all commands pass; release output includes both single-file UI artifacts; no runtime dependency on 21st.dev or shadcn CLI.

- [ ] **Step 6: Prepare the phase commit**

After explicit authorization:

```bash
git add scripts/package-release.mjs test/release-package.test.mjs test/package-runtime.test.mjs test/react-release-contract.test.mjs README.md docs/architecture.md docs/ui-component-sources.md docs/superpowers/specs/2026-08-28-react-21st-ui-migration-design.md
git diff --cached --check
git commit -m "docs: document React dashboard preview"
```

---

### Task 10: Run Product, Responsive, and Visual Acceptance

**Files:**
- Create: `.vdr-log/react-tasks-foundation/` screenshots and review notes; keep this directory ignored unless the repository explicitly tracks VDR evidence.
- Modify only if defects are found: files from Tasks 2–9.

**Interfaces / acceptance matrix:**
- Routes/states: healthy data, empty data, API unavailable, reconnecting SSE, task selected, inbox open, long workspace/branch/session values, all-child-done group, blocked leaf, archived scope.
- Viewports: 1440×900, 1280×800, 1024×768, 768×1024.
- Interactions: keyboard navigation, tooltips, copy, group collapse, filters, column resize, grid/timeline splitter, task mutation rollback, resume action.

- [ ] **Step 1: Start real local services from the React worktree**

Run in separate terminal panes:

```bash
npm run taskd:run
npm run dev:ui:react
```

Record the printed local preview URL. Do not test a previously installed/released Dashboard when validating source changes.

- [ ] **Step 2: Execute visual-driven-review with playwright-headless**

For every viewport:

- capture full page and focused component screenshots;
- inspect layout alignment, compact density, typography hierarchy, clipping, overflow, focus states, Tooltip positioning, row/timeline correspondence, and modal/sheet stacking;
- compare the same task IDs across widths and assert identical visible row order/count;
- verify controls have intentional margin/padding and do not touch container edges.

- [ ] **Step 3: Exercise real mutations safely**

Use a dedicated disposable test task created through the local API. Verify status change, archive/restore, copy, Sheet details, and Resume request. Do not mutate existing user tasks for test convenience. Remove only the disposable record through the supported API after verification.

- [ ] **Step 4: Record defects and fix root causes**

Classify each issue as projection, state ownership, component primitive, layout token, or API contract. Fix the owning layer and rerun its unit/component test before repeating the visual scenario. Do not add route-specific CSS patches to mask shared defects.

- [ ] **Step 5: Run final automated verification from a clean state**

Run:

```bash
git status --short
npm ci
npm run check
npm test
npm run test:ui
npm run build
npm run package:release
git diff --check
```

Expected: every command exits 0. `git status` before `npm ci` contains only the intended task changes; after verification no unexpected generated/untracked files remain.

- [ ] **Step 6: Johari completion review**

- **Open Area:** confirm all behaviors above with tests/screenshots and distinguish legacy production from React preview.
- **Hidden Area:** report any user-owned environment assumptions discovered during real service testing, especially local database data shape and terminal resume behavior.
- **Blind Spot:** check bundle size, long-lived SSE cleanup, large task datasets, narrow viewport interaction, copied-source license provenance, and release packaging.
- **Unknown Area:** explicitly list untested operating systems, browsers, accessibility assistive technologies, and future Scheduled/Agent Elements parity rather than implying completion.

- [ ] **Step 7: Present evidence and request final phase-commit authorization**

Report changed files, test command results, VDR screenshot paths, known limitations, and the exact proposed commit set. Only after user approval:

```bash
git add <exact-approved-files>
git diff --cached --check
git commit -m "feat(ui): deliver React tasks dashboard preview"
```

Do not merge, publish, update the installed local version, or switch production routing in this plan.

## Plan Self-Review

### Spec coverage

- React/TypeScript migration foundation: Tasks 1–2.
- Tailwind/shadcn design system and 21st.dev boundary: Task 3.
- REST/SSE/TanStack Query state architecture: Task 4.
- App Shell and navigation: Task 5.
- Tasks tree/timeline/progress/context/resume parity: Tasks 6–8.
- Offline single-file build, release artifact, docs, and development workflow: Task 9.
- Responsive, multi-state, interaction, and visual acceptance: Task 10.
- Scheduled, Settings, production cutover, legacy cleanup, and Agent Elements are deliberately split into follow-up plans.

### First-principles check

- **Goal:** give users a stable React foundation that improves Tasks control without disrupting the working Dashboard.
- **Facts:** the product already has REST/SSE APIs, esbuild, React/SVAR dependencies, a single-file release contract, and a large Vanilla UI; the current worktree is dirty.
- **Assumptions converted to tests:** Tailwind can be compiled/inlined by the existing build; React preview can reuse the gateway; task projection remains width-independent; release packaging can carry two HTML artifacts.
- **Constraints:** no runtime registry dependency, no production cutover in this slice, no silent commit or destructive Git operation, no local Playwright installation.
- **Success criteria:** dual builds pass, Tasks parity works against real local data, row/timeline structure is stable at four viewports, release remains offline, and VDR evidence exposes remaining gaps.

### Unresolved-marker and consistency scan

Before execution, run:

```bash
rg -n 'TB''D|TO''DO|FIX''ME' docs/superpowers/plans/2026-08-28-react-21st-tasks-foundation.md
rg -n "compileReactDashboard|writeReactDashboard|DashboardApi|TaskRecord|TaskGanttModel" docs/superpowers/plans/2026-08-28-react-21st-tasks-foundation.md
```

Expected: the unresolved-marker scan returns no matches; interface names are consistent across tasks.
