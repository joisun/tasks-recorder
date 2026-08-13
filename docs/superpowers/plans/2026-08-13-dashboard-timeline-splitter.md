# Dashboard Timeline Splitter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为展开状态下的 Dashboard Grid/Timeline 增加 Standard-compatible 拖拽 separator，扩大 Timeline 默认空间并持久化用户选择。

**Architecture:** 纯函数层负责默认值、边界 clamp、keyboard step 与数字 preference；Dashboard controller 只维护 `preferredGridWidth` / `effectiveGridWidth`，通过公开的 `gantt.config.layout + resetLayout()` 在拖拽结束时重排。separator 作为 custom HTML layout cell 存在，不使用 DHTMLX PRO resizer，也不读取 layout view 的 `$view` 私有字段。

**Tech Stack:** Node.js 24、vanilla JavaScript/CSS、DHTMLX Gantt Standard 9.1、Node test runner、esbuild、浏览器 `PointerEvent` / `localStorage`。

## Global Constraints

- 不修改 DHTMLX 源码，不使用 `{ resizer: true }`、`grid_resize` 或 column `resize: true`。
- 不开放 task bar drag、duration resize 或日期编辑。
- 默认 Grid/Timeline 约为 `65/35`；Grid 最小 `240px`；桌面尽量为 Timeline 保留 `320px`；separator 宽 `9px`。
- preference key 固定为 `dashboard-grid-width`；只保存有限且在 `1..10000` 范围内的数字。
- pointer move 只更新 visual guide；pointer up 最多执行一次 `gantt.resetLayout()`。
- 窗口 resize 只 clamp `effectiveGridWidth`，不得覆盖 `preferredGridWidth`。
- 不自动创建 Git commit；每个任务结束只记录验证结果和候选变更文件。

## File Structure

- `ui/src/dashboard-state.mjs`：宽度/persistence/layout 的纯函数，不访问 DOM。
- `ui/src/dashboard.mjs`：separator pointer/keyboard controller、layout reset 和 state restoration。
- `ui/src/dashboard.css`：separator、drag guide 和 resizing 全局状态。
- `test/dashboard-ui-state.test.mjs`：纯函数与 layout contract tests。
- `test/dashboard-build.test.mjs`：standalone bundle smoke contract。
- `README.md`：记录可拖拽面板宽度和 task bar 仍只读的公开行为。
- `ui/dist/index.html`：由 `npm run build` 生成，不手工编辑。

---

### Task 1: 宽度模型、数字 preference 与 layout contract

**Files:**

- Modify: `test/dashboard-ui-state.test.mjs`
- Modify: `ui/src/dashboard-state.mjs`

**Interfaces:**

- Consumes: browser-like storage `{ getItem(key), setItem(key, value) }`；`createGanttLayout({ showTimeline, gridWidth })`。
- Produces:
  - `gridPanelWidthBounds(containerWidth) -> { minimum: number, maximum: number }`
  - `effectiveGridPanelWidth({ containerWidth, preferredWidth? }) -> number`
  - `nextGridPanelWidth({ key, currentWidth, minimum, maximum, step? }) -> number | null`
  - `readNumberPreference(storage, key, fallback?) -> number | null`
  - `writeNumberPreference(storage, key, value) -> boolean`
  - expanded `createGanttLayout` 中的 custom HTML `.timeline-splitter` cell。

- [ ] **Step 1: 写 width/persistence 的失败测试**

在 `test/dashboard-ui-state.test.mjs` 增加直接行为断言：

```js
test('allocates a wider default Timeline and clamps only the effective Grid width', () => {
  assert.deepEqual(dashboardState.gridPanelWidthBounds?.(1440), { minimum: 240, maximum: 1111 })
  assert.equal(dashboardState.effectiveGridPanelWidth?.({ containerWidth: 1440 }), 936)
  assert.equal(dashboardState.effectiveGridPanelWidth?.({ containerWidth: 1440, preferredWidth: 1040 }), 1040)
  assert.equal(dashboardState.effectiveGridPanelWidth?.({ containerWidth: 768, preferredWidth: 1040 }), 439)
  assert.equal(dashboardState.effectiveGridPanelWidth?.({ containerWidth: 375, preferredWidth: 1040 }), 240)
  assert.equal(dashboardState.effectiveGridPanelWidth?.({ containerWidth: 1440, preferredWidth: 1040 }), 1040)
})

test('steps separator width by keyboard within its current bounds', () => {
  assert.equal(dashboardState.nextGridPanelWidth?.({ key: 'ArrowLeft', currentWidth: 640, minimum: 240, maximum: 1111 }), 624)
  assert.equal(dashboardState.nextGridPanelWidth?.({ key: 'ArrowRight', currentWidth: 1104, minimum: 240, maximum: 1111 }), 1111)
  assert.equal(dashboardState.nextGridPanelWidth?.({ key: 'Home', currentWidth: 640, minimum: 240, maximum: 1111 }), 240)
  assert.equal(dashboardState.nextGridPanelWidth?.({ key: 'End', currentWidth: 640, minimum: 240, maximum: 1111 }), 1111)
  assert.equal(dashboardState.nextGridPanelWidth?.({ key: 'Escape', currentWidth: 640, minimum: 240, maximum: 1111 }), null)
})

test('safely persists a finite Grid width preference', () => {
  const values = new Map()
  const storage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) }
  assert.equal(dashboardState.readNumberPreference?.(storage, 'grid'), null)
  assert.equal(dashboardState.writeNumberPreference?.(storage, 'grid', 720), true)
  assert.equal(dashboardState.readNumberPreference?.(storage, 'grid'), 720)
  values.set('grid', 'NaN')
  assert.equal(dashboardState.readNumberPreference?.(storage, 'grid'), null)
  values.set('grid', '10001')
  assert.equal(dashboardState.readNumberPreference?.(storage, 'grid'), null)
  const denied = { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('denied') } }
  assert.equal(dashboardState.readNumberPreference?.(denied, 'grid'), null)
  assert.equal(dashboardState.writeNumberPreference?.(denied, 'grid', 720), false)
})
```

- [ ] **Step 2: 运行 focused tests 并确认 RED**

Run: `node --test test/dashboard-ui-state.test.mjs`

Expected: FAIL，原因是 `gridPanelWidthBounds`、`effectiveGridPanelWidth`、`nextGridPanelWidth`、`readNumberPreference` 或 `writeNumberPreference` 尚未定义；不是 syntax/import error。

- [ ] **Step 3: 写 layout separator contract 的失败测试**

把现有 “without PRO resizers” 测试扩展为：

```js
const expanded = createGanttLayout({ showTimeline: true, gridWidth: 640 })
assert.equal(expanded.cols[0].width, 640)
assert.match(expanded.cols[1].html, /class="timeline-splitter"/)
assert.equal(expanded.cols[1].css, 'timeline-splitter-cell')
assert.equal(expanded.cols[1].width, 9)
assert.equal(expanded.cols[2].rows[0].view, 'timeline')
assert.equal(JSON.stringify(expanded).includes('"resizer":true'), false)

const collapsed = createGanttLayout({ showTimeline: false, gridWidth: 640 })
assert.equal(JSON.stringify(collapsed).includes('timeline-splitter'), false)
assert.equal(collapsed.cols.some((cell) => JSON.stringify(cell).includes('timeline')), false)
```

- [ ] **Step 4: 运行 focused tests 并确认 layout assertion RED**

Run: `node --test test/dashboard-ui-state.test.mjs`

Expected: FAIL，因为当前 `expanded.cols[1]` 是 Timeline cell，不含 `html` separator。

- [ ] **Step 5: 实现最小纯函数与 layout cell**

在 `ui/src/dashboard-state.mjs` 中用下列边界实现替换旧 `gridPanelWidthFor` / `responsiveGridWidth`：

```js
const GRID_MIN_WIDTH = 240
const TIMELINE_MIN_WIDTH = 320
const TIMELINE_SPLITTER_WIDTH = 9

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value))
}

export function gridPanelWidthBounds(containerWidth) {
  const width = Math.max(0, Number(containerWidth) || 0)
  return {
    minimum: GRID_MIN_WIDTH,
    maximum: Math.max(GRID_MIN_WIDTH, width - TIMELINE_SPLITTER_WIDTH - TIMELINE_MIN_WIDTH),
  }
}

export function effectiveGridPanelWidth({ containerWidth, preferredWidth = null }) {
  const bounds = gridPanelWidthBounds(containerWidth)
  const fallback = Math.round((Number(containerWidth) || 0) * 0.65)
  const requested = Number.isFinite(preferredWidth) ? preferredWidth : fallback
  return Math.round(clamp(requested, bounds.minimum, bounds.maximum))
}

export function nextGridPanelWidth({ key, currentWidth, minimum, maximum, step = 16 }) {
  const candidates = {
    ArrowLeft: currentWidth - step,
    ArrowRight: currentWidth + step,
    Home: minimum,
    End: maximum,
  }
  return key in candidates ? Math.round(clamp(candidates[key], minimum, maximum)) : null
}

export function readNumberPreference(storage, key, fallback = null) {
  try {
    const value = Number(storage?.getItem(key))
    return Number.isFinite(value) && value >= 1 && value <= 10_000 ? value : fallback
  } catch {
    return fallback
  }
}

export function writeNumberPreference(storage, key, value) {
  if (!Number.isFinite(value) || value < 1 || value > 10_000) return false
  try {
    storage?.setItem(key, String(Math.round(value)))
    return Boolean(storage)
  } catch {
    return false
  }
}
```

注意：`getItem()` 返回 `null` 时 `Number(null) === 0`，会因 `< 1` 正确回退。expanded layout 的 `cols` 顺序必须为 `grid, separator, timeline, vertical`；collapsed 保持 `grid, vertical`。

- [ ] **Step 6: 运行 Task 1 tests 并确认 GREEN**

Run: `node --test test/dashboard-ui-state.test.mjs`

Expected: 全部 PASS，且 JSON contract 中不存在 `"resizer":true`。

- [ ] **Step 7: Review checkpoint（不 commit）**

Run: `git diff --check -- ui/src/dashboard-state.mjs test/dashboard-ui-state.test.mjs`

Expected: 无输出。记录候选变更：`ui/src/dashboard-state.mjs`、`test/dashboard-ui-state.test.mjs`。

---

### Task 2: Pointer/keyboard separator controller 与 responsive state

**Files:**

- Modify: `ui/src/dashboard.mjs`
- Modify: `ui/src/dashboard.css`
- Modify: `test/dashboard-build.test.mjs`

**Interfaces:**

- Consumes: Task 1 的 `effectiveGridPanelWidth`、`gridPanelWidthBounds`、`nextGridPanelWidth`、数字 preference、custom `.timeline-splitter` cell；现有 `captureState()` / `scheduleLayoutStateRestore()`。
- Produces: `preferredGridWidth` / `effectiveGridWidth` controller；pointer drag guide；keyboard separator；不含 `$view` 的 responsive layout。

- [ ] **Step 1: 写 bundle contract 的失败测试**

在 `test/dashboard-build.test.mjs` 增加：

```js
assert.match(html, /dashboard-grid-width/)
assert.match(html, /timeline-splitter/)
assert.doesNotMatch(html, /getLayoutView\?\.\('grid'\)\?\.\$view/)
```

- [ ] **Step 2: 构建并确认 RED**

Run: `npm run build && node --test test/dashboard-build.test.mjs`

Expected: FAIL，因为 bundle 尚不含 `dashboard-grid-width`，且仍含当前 `$view` Grid measurement 路径。

- [ ] **Step 3: 接入 preferred/effective state**

在 `ui/src/dashboard.mjs`：

```js
const GRID_WIDTH_KEY = 'dashboard-grid-width'
const preferenceStorage = resolvePreferenceStorage()
let preferredGridWidth = readNumberPreference(preferenceStorage, GRID_WIDTH_KEY)
let effectiveGridWidth = null

function containerWidth() {
  return document.getElementById('gantt_here').clientWidth
}

function resolveEffectiveGridWidth() {
  return effectiveGridPanelWidth({ containerWidth: containerWidth(), preferredWidth: preferredGridWidth })
}
```

所有 Timeline expanded layout 均使用 `effectiveGridWidth = resolveEffectiveGridWidth()`；collapsed layout 不写 width。删除旧 `gridPanelWidth()` 与 `responsiveGridWidth()` import/调用。

- [ ] **Step 4: 实现单次 layout width apply**

新增 `applyGridPanelWidth(preferredWidth, { restoreFocus = false } = {})`：

```js
function applyGridPanelWidth(preferredWidth, { restoreFocus = false } = {}) {
  preferredGridWidth = Math.round(preferredWidth)
  writeNumberPreference(preferenceStorage, GRID_WIDTH_KEY, preferredGridWidth)
  const nextWidth = resolveEffectiveGridWidth()
  if (!initialized || !showTimeline || nextWidth === effectiveGridWidth) return
  const state = captureState()
  effectiveGridWidth = nextWidth
  gantt.config.layout = createGanttLayout({ showTimeline: true, gridWidth: effectiveGridWidth })
  gantt.resetLayout()
  scheduleLayoutStateRestore(state, { restoreSplitterFocus: restoreFocus })
}
```

扩展 `scheduleLayoutStateRestore`，在 keyboard reset 后恢复到新 `.timeline-splitter`，并保持现有 scroll restoration。

- [ ] **Step 5: 实现 event-delegated pointer drag**

新增 `installTimelineSplitterInteractions()`，只注册一次到 `#gantt_here`：

```js
ganttElement.addEventListener('pointerdown', (event) => {
  const splitter = event.target.closest?.('.timeline-splitter')
  if (!splitter || event.button !== 0 || !showTimeline) return
  event.preventDefault()
  const startX = event.clientX
  const startWidth = effectiveGridWidth
  const guide = document.createElement('div')
  guide.className = 'timeline-splitter-guide'
  ganttElement.appendChild(guide)
  document.documentElement.classList.add('is-resizing-timeline')
  let candidate = startWidth
  let frame = 0
  const move = (moveEvent) => {
    const bounds = gridPanelWidthBounds(containerWidth())
    candidate = Math.round(Math.min(bounds.maximum, Math.max(bounds.minimum, startWidth + moveEvent.clientX - startX)))
    if (!frame) frame = requestAnimationFrame(() => {
      frame = 0
      guide.style.left = `${candidate}px`
    })
  }
  const finish = (apply) => {
    if (frame) cancelAnimationFrame(frame)
    guide.remove()
    document.documentElement.classList.remove('is-resizing-timeline')
    document.removeEventListener('pointermove', move)
    document.removeEventListener('pointerup', up)
    document.removeEventListener('pointercancel', cancel)
    if (apply && candidate !== startWidth) applyGridPanelWidth(candidate)
  }
  const up = () => finish(true)
  const cancel = () => finish(false)
  document.addEventListener('pointermove', move)
  document.addEventListener('pointerup', up)
  document.addEventListener('pointercancel', cancel)
})
```

初始化 guide 时先设置 `left: effectiveGridWidth`，确保无 move 也不闪到左边。若 pointerdown 与 pointerup 之间 viewport 改变，move 与最终 apply 都再次经过当前 bounds。

- [ ] **Step 6: 实现 delegated keyboard 与 ARIA 同步**

在同一 installer 中处理 `keydown`；读取 `gridPanelWidthBounds(containerWidth())`，用 `nextGridPanelWidth()` 计算 Arrow/Home/End，调用 `applyGridPanelWidth(next, { restoreFocus: true })`。新增 `syncTimelineSplitterA11y()`：

```js
function syncTimelineSplitterA11y() {
  const splitter = document.querySelector('.timeline-splitter')
  if (!splitter || effectiveGridWidth === null) return
  const bounds = gridPanelWidthBounds(containerWidth())
  splitter.setAttribute('aria-valuemin', String(bounds.minimum))
  splitter.setAttribute('aria-valuemax', String(bounds.maximum))
  splitter.setAttribute('aria-valuenow', String(effectiveGridWidth))
}
```

在 `onGanttRender` 和 reset 后调用；不可把 event listener 直接绑定到会被 reset 销毁的 separator element。

- [ ] **Step 7: 替换 responsive resize 并移除 `$view`**

`applyResponsiveLayout()` 只比较 controller state：

```js
function applyResponsiveLayout() {
  if (!initialized || !showTimeline) return
  const nextWidth = resolveEffectiveGridWidth()
  if (nextWidth === effectiveGridWidth) return
  const state = captureState()
  effectiveGridWidth = nextWidth
  gantt.config.layout = createGanttLayout({ showTimeline: true, gridWidth: effectiveGridWidth })
  gantt.resetLayout()
  scheduleLayoutStateRestore(state)
}
```

窗口变窄再变宽期间 `preferredGridWidth` 保持不变。`applyLayout(true)` 在重建前重新计算 `effectiveGridWidth`；`applyLayout(false)` 保留两层 width state。

- [ ] **Step 8: 添加 separator CSS**

在 `ui/src/dashboard.css` 增加：

```css
.timeline-splitter-cell{position:relative!important;overflow:visible!important;background:var(--bg)!important}
.timeline-splitter{position:absolute;z-index:7;inset:0;cursor:col-resize;touch-action:none}
.timeline-splitter::before{position:absolute;top:0;bottom:0;left:4px;width:1px;background:var(--border);content:""}
.timeline-splitter:hover::before,.timeline-splitter:focus-visible::before{background:var(--accent-hover)}
.timeline-splitter:focus-visible{outline:2px solid var(--accent-hover);outline-offset:-2px}
.timeline-splitter-guide{position:absolute;z-index:30;top:0;bottom:0;width:1px;background:var(--accent-hover);box-shadow:0 0 0 3px color-mix(in oklab,var(--accent-hover) 18%,transparent);pointer-events:none}
html.is-resizing-timeline,html.is-resizing-timeline *{cursor:col-resize!important;user-select:none!important}
```

- [ ] **Step 9: 构建并运行 focused tests**

Run: `npm run build && node --test test/dashboard-ui-state.test.mjs test/dashboard-build.test.mjs`

Expected: PASS；bundle 含 preference/separator contract；不再含 `$view` Grid measurement expression。

- [ ] **Step 10: Review checkpoint（不 commit）**

Run: `git diff --check -- ui/src/dashboard.mjs ui/src/dashboard.css test/dashboard-build.test.mjs ui/dist/index.html`

Expected: 无输出。记录候选变更文件，不执行 `git commit`。

---

### Task 3: 文档同步、完整验证与真实浏览器验收

**Files:**

- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-08-13-dashboard-timeline-splitter-design.md`
- Modify: `docs/superpowers/plans/2026-08-13-dashboard-timeline-splitter.md`
- Verify generated: `ui/dist/index.html`

**Interfaces:**

- Consumes: 完成的 separator UI、`dashboard-grid-width` preference 和 standalone bundle。
- Produces: 对用户可见的行为文档、项目级自动测试证据与浏览器验收证据。

- [ ] **Step 1: 更新 README 的公开行为**

把 Timeline 描述更新为：

```md
- 右侧 Timeline 可以折叠；展开时可拖动 Grid/Timeline 分隔线调整宽度，浏览器会记住上次设置。Grid 与 Timeline 各自横向滚动并共享纵向滚动。
```

把 “Timeline drag/resize” 改为 “Timeline task bar drag/date resize”，明确面板 splitter 不会编辑任务日期。

- [ ] **Step 2: 扫描文档树并同步冲突描述**

Run:

```bash
git diff --name-only HEAD
find . -name "*.md" -not -path "*/node_modules/*" -not -path "*/.git/*"
rg -n "Timeline drag|PRO resizer|without PRO resizer|不依赖 PRO resizer|dashboard-show-timeline" --glob "*.md" .
```

只更新将“面板拖拽”与“task bar 日期拖拽”混淆的现行公开文档；历史 plan 中已经执行过的 checkbox/code 不重写。若无其他冲突，交付时明确报告“扫描了文档树，无需同步”或列出同步文件。

- [ ] **Step 3: 运行完整自动验证**

Run:

```bash
npm run build
npm test
npm run check
git diff --check
```

Expected: build exit 0；全部 Node tests PASS；所有 `node --check` PASS；diff check 无 whitespace error。

- [ ] **Step 4: 使用现有 runtime 做真实浏览器验收**

先使用 `visual-driven-ui-test-skill@joi`，通过已有 Playwright MCP `playwright-headless` 检查：

- 1440px 下 `.timeline-splitter` 可见，`aria-valuenow` 约为容器 `65%`（若 localStorage 已有偏好则先在隔离 context 清除该 key）。
- pointer drag 结束后 Grid 宽度改变，`localStorage['dashboard-grid-width']` 与新宽度一致。
- reload 后宽度恢复；折叠后 separator 不存在；再次展开后恢复。
- keyboard `ArrowLeft`、`ArrowRight`、`Home`、`End` 更新 `aria-valuenow` 且保持 focus。
- 768px/375px 下无 `document.documentElement.scrollWidth > clientWidth`，Grid/Timeline 内部滚动仍可用。
- task bar 没有获得日期拖拽/resize 能力；状态菜单仍可打开。

若 runtime 未启动，只执行项目内已有的安全启动命令；不安装新的 Playwright package，不修改用户浏览器 profile。

- [ ] **Step 5: 完成 spec/plan 状态**

将 design spec 状态改为“已实现并验证”，将本 plan 已完成的 checkbox 勾选。记录自动测试数量、browser viewport 和任何剩余限制；不创建 commit。

- [ ] **Step 6: Final review checkpoint（不 commit）**

Run:

```bash
git status --short
git diff --stat
git diff --check
```

Expected: 仅报告本任务与既有未提交变更；不 stage、不 commit、不回滚其他修改。

## Execution Result

- 完成日期：2026-08-13（Asia/Shanghai）。
- 自动验证：`npm run build`、`npm test`（61/61）、`npm run check`、`git diff --check` 全部通过。
- Browser：`playwright-headless`，isolated runtime `127.0.0.1:43129`，viewport `1440×900`、`768×1024`、`375×812`。
- Browser 结果：8 planned PASS、0 FAIL、0 SKIP；9 `VISUAL_CLEAR`、0 finding、0 visual skip。
- 报告：`.vdut-log/20260813-timeline-splitter/report.md` 与 `report.html`。
- Git：项目没有有效 `HEAD`，未创建 worktree、branch 或 commit。
