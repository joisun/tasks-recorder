# SVAR Gantt Dashboard Implementation Plan

**Execution status:** Tasks 1–9 are implemented in `experiment/svar-gantt-dashboard`. Task 9 supersedes the original ten-column/36px-row presentation assumptions while preserving the renderer and data contracts.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Do not dispatch subagents; this thread is configured for inline execution. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Replace DHTMLX Gantt with a pinned MIT SVAR React Gantt island while preserving every Dashboard contract and eliminating the known visual truncation/target-size defects.

**Architecture:** Keep taskd, REST/SSE, Details Sheet, Inbox, and the vanilla Dashboard controller. Add one React/SVAR renderer boundary plus pure projection/state helpers; the controller communicates only through a small renderer interface and stable data attributes.

**Tech Stack:** Node.js 24, esbuild 0.28.2, React 19.2.8, React DOM 19.2.8, @svar-ui/react-gantt 2.7.1, node:test, Playwright MCP.

## Global Constraints

- Work only in /Users/joi-com/Desktop/space/projects/tasks-recorder/.worktree/experiment-svar-gantt-dashboard on branch experiment/svar-gantt-dashboard.
- Before every edit/test, verify git rev-parse --show-toplevel equals that absolute worktree path.
- Do not commit or push; the user did not authorize Git commits for this phase.
- Do not modify ~/.config/tasks-recorder/tasks.sqlite; browser mutation tests must use an isolated temporary HOME/config/database/port.
- Do not enable SVAR PRO modules, markers, resources, calendars, grouping, baselines, or any license-key path.
- Do not use CDN, remote fonts, telemetry, tokens, or external runtime services.
- Keep one self-contained ui/dist/index.html and the 2 MiB bundle ceiling.
- Preserve schema v2, HTTP, MCP, Hook, adapter, importer, install, and release contracts.
- Apply TDD for every production behavior: focused test, observed expected failure, minimal implementation, focused green, then regression suite.
- Responsive testing remains excluded; final visual verdict is PC 1440 × 900 only.
- Critical/High/Medium visual findings block completion. Low findings must be fixed or backed by a specific production-safe rationale.

---

### Task 1: Prove the pinned open-source renderer contract

**Files:**
- Create: test/svar-gantt-contract.test.mjs
- Modify: package.json
- Modify: package-lock.json
- Create: ui/src/svar-gantt-renderer.jsx

**Interfaces:**
- Consumes: an isolated DOM spike mount point during this task; production #gantt_here remains on DHTMLX until the atomic controller cutover in Task 4.
- Produces: createSvarGanttRenderer(options) with render, refreshTask, setDisplayMode, setLabelsVisible, locateNow, captureState, and destroy methods.

- [x] **Step 1: Write the failing package/build contract test**

Create test/svar-gantt-contract.test.mjs:

~~~js
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('pins the MIT SVAR React Gantt runtime for the migration', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(pkg.dependencies['@svar-ui/react-gantt'], '2.7.1')
  assert.equal(pkg.dependencies.react, '19.2.8')
  assert.equal(pkg.dependencies['react-dom'], '19.2.8')
})

test('installed SVAR renderer is the expected MIT release', async () => {
  const metadata = JSON.parse(await readFile(
    new URL('../node_modules/@svar-ui/react-gantt/package.json', import.meta.url),
    'utf8',
  ))
  assert.equal(metadata.version, '2.7.1')
  assert.equal(metadata.license, 'MIT')
})
~~~

- [x] **Step 2: Run focused tests and verify RED**

Run:

    node --test test/svar-gantt-contract.test.mjs

Expected: FAIL because the pinned SVAR package is not declared or installed.

- [x] **Step 3: Install exact dependencies**

Run:

    npm install --save-exact @svar-ui/react-gantt@2.7.1 react@19.2.8 react-dom@19.2.8

Confirm package-lock records the exact versions and npm audit reports zero known vulnerabilities.

Keep DHTMLX installed during Tasks 1–3 so the production Dashboard remains runnable while the replacement is built and tested in isolation. Remove it only in the atomic cutover in Task 4.

- [x] **Step 4: Add the minimal real renderer mount**

Create ui/src/svar-gantt-renderer.jsx with React createRoot, SVAR Gantt, and a stateful wrapper:

~~~jsx
import React from 'react'
import { createRoot } from 'react-dom/client'
import { Gantt } from '@svar-ui/react-gantt'
import '@svar-ui/react-gantt/all.css'

export function createSvarGanttRenderer({ element, onReady = () => {} }) {
  const root = createRoot(element)
  let api = null
  let model = { tasks: [], columns: [], scales: [] }
  let view = { displayMode: 'all', gridWidth: 936, labelsVisible: false }

  function mount() {
    root.render(
      <Gantt
        tasks={model.tasks}
        columns={model.columns}
        scales={model.scales}
        readonly
        displayMode={view.displayMode}
        gridWidth={view.gridWidth}
        init={(nextApi) => { api = nextApi; onReady(nextApi) }}
      />,
    )
  }

  return {
    render(nextModel, nextView = view) { model = nextModel; view = nextView; mount() },
    refreshTask() { mount() },
    setDisplayMode(mode) { view = { ...view, displayMode: mode }; api?.exec('set-display-mode', { mode }) },
    setLabelsVisible(visible) { view = { ...view, labelsVisible: visible }; mount() },
    locateNow(date = new Date()) { api?.exec('scroll-chart', { date }) },
    captureState() { return { ...view } },
    destroy() { root.unmount(); api = null },
  }
}
~~~

- [x] **Step 5: Build and verify GREEN**

Run:

    node --test test/svar-gantt-contract.test.mjs

Expected: PASS with the pinned MIT package installed and no vulnerability finding.

The renderer lifecycle is intentionally not tested by grepping its source. Tasks 4–5 exercise each interface method through a fake controller boundary and a real browser DOM so the tests fail on broken behavior, not harmless source refactors.

- [x] **Step 6: Run a real package DOM spike**

Start an isolated taskd with a temporary config and database, open it with playwright-headless, and prove:

- SVAR renders at least one summary and one child row.
- disclosure changes visible row count using a real pointer click.
- api.exec('resize-grid', { width: 720 }) changes the Grid width.
- api.exec('set-display-mode', { mode: 'grid' }) hides Timeline and mode all restores it.
- api.exec('scroll-chart', { date }) scrolls to a specific date as documented by the pinned 2.7.1 changelog; if the installed contract differs, the application-owned overlay adapter must translate the date to a pixel offset before Task 2.
- console has zero errors/warnings.

If any item fails due the pinned library rather than integration code, record the evidence and trigger the fallback gate before Task 2.

### Task 2: Extract and test the renderer-neutral task/view model

**Files:**
- Create: ui/src/svar-gantt-state.mjs
- Create: test/svar-gantt-state.test.mjs
- Modify: ui/src/dashboard-state.mjs

**Interfaces:**
- Produces: createSvarTaskProjection(tasks, options), filterSvarTasks(tasks, filter), createSvarScales(bounds), normalizeRendererState(input, bounds), currentTimePosition(input), and SVAR_GRID_COLUMNS.
- Consumes: existing createTaskIndex, endOf, progressOf, progressPresentation, relativeActivity, contextPathPresentation, sessionIdPresentation, timelineBounds, and preference helpers.

- [x] **Step 1: Write failing projection tests**

Cover:

- parent comes before children and child parent points to stable root ID;
- history/root filters preserve only matching root subtrees;
- projection retains status, progress, session_id, workfolder, worktree, branch, note, active_agent_count, execution_count, last_activity, updated_at;
- root summary dates use existing start/end semantics;
- open IDs are explicit and no missing child is invented;
- columns exactly match the ten required headers;
- currentTimePosition hides outside bounds and returns a clamped viewport x inside bounds.

Example:

~~~js
assert.deepEqual(SVAR_GRID_COLUMNS.map(({ id }) => id), [
  'text', 'status', 'session_id', 'workfolder', 'worktree',
  'branch', 'note', 'active_agent_count', 'execution_count', 'activity',
])
assert.deepEqual(createSvarTaskProjection(tasks, { openIds: new Set(['root']) }).map(task => ({
  id: task.id, parent: task.parent, open: task.open,
})), [
  { id: 'root', parent: 0, open: true },
  { id: 'child', parent: 'root', open: false },
])
~~~

- [x] **Step 2: Run focused test and verify RED**

Run:

    node --test test/svar-gantt-state.test.mjs

Expected: FAIL with ERR_MODULE_NOT_FOUND for ui/src/svar-gantt-state.mjs.

- [x] **Step 3: Implement minimal pure state module**

Move only renderer-neutral logic out of dashboard.mjs. Do not expose React or SVAR API objects from this module.

Use Date objects for SVAR start/end, numeric progress 0–100, type summary/task, parent 0/root ID, lazy false, and open from the captured ID set.

- [x] **Step 4: Verify focused GREEN and existing state regressions**

Run:

    node --test test/svar-gantt-state.test.mjs test/dashboard-ui-state.test.mjs test/dashboard-data.test.mjs

Expected: PASS with no changed task/status/date semantics.

### Task 3: Implement custom Grid cells and accessible Task tree

**Files:**
- Modify: ui/src/svar-gantt-renderer.jsx
- Create: ui/src/svar-gantt-cells.mjs
- Create: test/svar-gantt-cells.test.mjs
- Modify: ui/src/dashboard.css

**Interfaces:**
- Consumes: projected task fields and stable data attributes already handled by dashboard.mjs.
- Produces: TaskCell, StatusCell, SessionCell, ContextCell, NoteCell, AgentsCell, ExecutionsCell, ActivityCell, and TaskBar components.

- [x] **Step 1: Write failing cell source/markup contract tests**

Assert:

- TaskCell emits data-task-details-id and a text node, never raw HTML.
- StatusCell emits data-status-task-id with aria-haspopup=listbox.
- SessionCell renders the entire session ID and data-copy-session-id.
- ContextCell renders shortened text plus data-full-path and tabindex=0.
- every button has an accessible name.
- no component uses dangerouslySetInnerHTML.

The production change that makes the test fail is deleting any required stable data attribute or replacing React text nodes with raw HTML.

- [x] **Step 2: Run focused test and verify RED**

Run:

    node --test test/svar-gantt-cells.test.mjs

Expected: FAIL because ui/src/svar-gantt-cells.jsx does not exist.

- [x] **Step 3: Implement components**

Use React elements and props only. Reuse existing presentational helpers by passing already-normalized labels from svar-gantt-state.mjs. Preserve CSS class names used by delegated interactions where practical.

The text column remains the SVAR tree column. Verify the library continues to render its disclosure control around the custom cell; do not create a second visual chevron.

- [x] **Step 4: Define columns**

Pass fixed widths and custom cell components:

~~~js
[
  { id: 'text', header: '任务', width: 240, resize: true, cell: TaskCell },
  { id: 'status', header: '状态 / 进度', width: 142, cell: StatusCell },
  { id: 'session_id', header: 'Session ID', width: 276, cell: SessionCell },
  { id: 'workfolder', header: '工作目录', width: 180, cell: WorkspaceCell },
  { id: 'worktree', header: 'Worktree', width: 180, cell: WorktreeCell },
  { id: 'branch', header: 'Branch', width: 160, cell: BranchCell },
  { id: 'note', header: '说明', width: 160, cell: NoteCell },
  { id: 'active_agent_count', header: 'Active Agents', width: 92, cell: AgentsCell },
  { id: 'execution_count', header: 'Executions', width: 92, cell: ExecutionsCell },
  { id: 'activity', header: '活动', width: 72, cell: ActivityCell },
]
~~~

- [x] **Step 5: Verify focused GREEN**

Run:

    npm run build
    node --test test/svar-gantt-cells.test.mjs test/svar-gantt-contract.test.mjs

Then use a browser snapshot to verify treegrid/table semantics, disclosure accessible name, and ten aligned headers.

### Task 4: Replace DHTMLX controller calls with the renderer interface

**Files:**
- Modify: ui/src/dashboard.mjs
- Modify: ui/src/svar-gantt-renderer.jsx
- Modify: ui/build.mjs
- Modify: ui/src/index.html
- Modify: test/dashboard-build.test.mjs
- Modify: package.json
- Modify: package-lock.json
- Modify: test/dashboard-ui-state.test.mjs
- Create: test/dashboard-renderer-controller.test.mjs

**Interfaces:**
- dashboard.mjs may call only the renderer interface from Task 1.
- renderer callbacks: onTaskOpenChange(id, open), onTaskSelected(id), onGridResize(width), onScroll(state).

- [x] **Step 1: Write a failing fake-renderer controller test**

The fake records calls but does not mock SVAR internals. Assert:

- initial snapshot calls renderer.render once with projected tasks;
- active tab change re-renders the matching root subtrees;
- status pending calls refreshTask for the affected ID;
- timeline toggle maps to all/grid display mode;
- label toggle and locate-now call their matching methods;
- snapshot refresh captures and restores open/scroll/width state.

- [x] **Step 2: Run focused test and verify RED**

Run:

    node --test test/dashboard-renderer-controller.test.mjs

Expected: FAIL because dashboard.mjs still reads window.gantt and invokes DHTMLX APIs.

- [x] **Step 3: Refactor dashboard.mjs minimally**

Replace:

- window.gantt with createSvarGanttRenderer;
- gantt.refreshData/render/refreshTask with renderer.render/refreshTask;
- gantt.getTask parent walking with createTaskIndex;
- onBeforeTaskDisplay with pure filter projection;
- DHTMLX layout/reset/scroll methods with captureState and renderer actions;
- addMarker/showDate with current-time overlay and locateNow.

In the same cutover, update ui/build.mjs/index.html to bundle JSX plus SVAR CSS, remove the DHTMLX global/style/script placeholders, run npm uninstall dhtmlx-gantt, and update dashboard-build.test.mjs to assert no DHTMLX bytes, embedded wx-gantt styles, no license/trial watermark path, and a bundle below 2 MiB. This atomic boundary keeps both the pre-cutover and post-cutover Dashboard runnable.

Keep status menu, Details, Inbox, delegated data-attribute interactions, error strings, and coordinator logic unchanged unless a test requires an adapter.

- [x] **Step 4: Verify GREEN and controller regressions**

Run:

    node --test test/dashboard-renderer-controller.test.mjs test/dashboard-ui-state.test.mjs test/dashboard-details.test.mjs test/execution-inbox.test.mjs

Expected: PASS with no DHTMLX global or API reference in ui/src.

### Task 5: Complete view-state, Timeline, splitter, and NOW behavior

**Files:**
- Create: ui/src/current-time-overlay.mjs
- Create: test/current-time-overlay.test.mjs
- Modify: ui/src/svar-gantt-renderer.jsx
- Modify: ui/src/svar-gantt-state.mjs
- Modify: ui/src/dashboard.css
- Modify: test/svar-gantt-state.test.mjs

**Interfaces:**
- renderer captureState returns displayMode, gridWidth, openIds, gridX, timelineX, verticalY, selectedTaskId, taskColumnWidth, labelsVisible.
- currentTimePosition accepts now, timelineStart, timelineEnd, contentWidth, scrollLeft, viewportWidth and returns visible/x.

- [x] **Step 1: Write failing state/overlay tests**

Cover:

- ArrowLeft/Right/Home/End width updates stay inside current bounds.
- all → grid → all preserves preferred width, open IDs, Grid x, Timeline x, and vertical y.
- current-time line is hidden outside range and correctly shifted by scrollLeft.
- task labels choose inside/right/left without leaving viewport.
- malformed localStorage state safely falls back.

- [x] **Step 2: Verify RED**

Run:

    node --test test/current-time-overlay.test.mjs test/svar-gantt-state.test.mjs

Expected: FAIL because overlay and complete renderer state do not exist.

- [x] **Step 3: Implement state wiring**

Use SVAR actions open-task, resize-grid, set-display-mode, scroll-chart, and select-task. Subscribe once in init and unsubscribe/destroy on renderer teardown.

Add an application-owned focusable separator overlay only if SVAR's native resizer is not keyboard-focusable. Its pointer path must delegate resize-grid; its keyboard path uses 16px steps and Home/End bounds. Do not duplicate the visible separator when the native handle already exists.

- [x] **Step 4: Implement NOW overlay**

Mount a div with class current-time-marker and child label NOW in the renderer shell. Set transform translateX from currentTimePosition and hidden when out of view. Recompute after render, resize, chart scroll, locate-now, and once per minute.

- [x] **Step 5: Verify focused GREEN**

Run:

    node --test test/current-time-overlay.test.mjs test/svar-gantt-state.test.mjs test/dashboard-ui-state.test.mjs
    npm run build

Use Playwright to verify pointer resize, keyboard resize, grid-only restore, label toggle, locate-now, and reload persistence.

### Task 6: Fix the known production visual defects

**Files:**
- Modify: ui/src/task-details-sheet.mjs
- Modify: ui/src/dashboard.css
- Modify: test/dashboard-details.test.mjs
- Create: test/dashboard-accessibility-style.test.mjs

**Interfaces:**
- Next action remains draft.next_action and PATCH next_action; only the control changes from input to textarea.
- Hit-area rules cover toolbar, row controls, Sheet, Inbox, status menu, and copy controls.

- [x] **Step 1: Write failing regression tests**

Assert Details markup contains:

~~~js
assert.match(html, /<textarea[^>]+name="next_action"/)
assert.doesNotMatch(html, /<input[^>]+name="next_action"/)
~~~

Read the built Dashboard in a browser and measure explicit 44px minimums for surface controls:

- .timeline-tool, .inbox-toggle
- .details-close, .details-tab, .details-actions button
- .inbox-actions button and filter inputs/selects

For the desktop Grid, measure a 36px row pitch with 30–36px row controls and preserved focus outlines.

- [x] **Step 2: Run tests and verify RED**

Run:

    node --test test/dashboard-details.test.mjs test/dashboard-accessibility-style.test.mjs

Expected: FAIL because Next action is a single-line input and current targets are 22–38px.

- [x] **Step 3: Implement minimal markup/CSS**

Render Next action as a textarea with at least 84px default height, overflow-wrap:anywhere, and vertical resize. Keep surface interaction boxes at 44px while using desktop-appropriate compact density inside the Grid.

Set renderer rowHeight to 36; use 30px status/progress controls and a 32px copy control. Keep focus-visible outlines and reduced-motion behavior.

- [x] **Step 4: Verify GREEN**

Run:

    node --test test/dashboard-details.test.mjs test/dashboard-accessibility-style.test.mjs
    npm run build

Browser-measure actual getBoundingClientRect values and confirm 36px rows, 30–36px row controls, 44px surface controls, and no row/header/bar collision.

### Task 7: Update packaging, attribution, public docs, and old contracts

**Files:**
- Modify: ui/THIRD_PARTY_NOTICES.md
- Modify: README.md
- Modify: package.json
- Modify: package-lock.json
- Modify: test/release-metadata.test.mjs
- Modify: test/release-package.test.mjs
- Modify: test/package-runtime.test.mjs
- Modify: test/dashboard-build.test.mjs
- Modify: docs/superpowers/specs/2026-08-12-dashboard-context-timeline-status-design.md
- Modify: docs/superpowers/specs/2026-08-13-dashboard-timeline-splitter-design.md

**Interfaces:**
- Release archives include every runtime dependency needed by the self-contained build/install workflow.
- Public docs describe SVAR as a renderer dependency, not as the data/service architecture.

- [x] **Step 1: Write failing metadata/package assertions**

Assert:

- package dependencies contain pinned SVAR/React and no DHTMLX;
- ui/THIRD_PARTY_NOTICES.md names SVAR React Gantt, React, React DOM, MIT, and source URLs;
- README How it works names REST snapshot + SSE and React/SVAR renderer;
- release archive/package runtime contains prebuilt Dashboard and does not build at install time;
- no DHTMLX attribution/footer remains.

- [x] **Step 2: Verify RED**

Run:

    node --test test/release-metadata.test.mjs test/release-package.test.mjs test/package-runtime.test.mjs test/dashboard-build.test.mjs

Expected: FAIL on old dependency/attribution assertions.

- [x] **Step 3: Update docs and packaging**

Keep existing GPL-2.0-only project license unless the user separately chooses relicensing. Record MIT third-party notices without claiming the whole repository is MIT.

Update architecture specs only where they assert DHTMLX APIs/layout. Preserve taskd/API/SSE and Dashboard behavior wording.

- [x] **Step 4: Verify GREEN**

Run:

    npm run build
    node --test test/release-metadata.test.mjs test/release-package.test.mjs test/package-runtime.test.mjs test/dashboard-build.test.mjs

Expected: PASS and generated release artifacts remain self-contained.

### Task 8: Full automated, packaged-runtime, performance, and browser acceptance

**Files:**
- Create: test/fixtures/dashboard/svar-1000-tasks.json only if a deterministic generator cannot keep the test clearer.
- Create: test/dashboard-performance.test.mjs
- Modify: docs/superpowers/plans/2026-08-16-svar-gantt-dashboard.md checkboxes/evidence.
- Add: /.vdr-log/ to root .gitignore before visual artifacts.

**Interfaces:**
- Production gate consumes the exact acceptance matrix in the design spec.
- Produces a .vdr-log run with Markdown/HTML reports and original screenshots.

- [x] **Step 1: Add and verify a 1,000-row performance smoke**

Generate 1,000 root tasks in an isolated real task store/database, render the actual Dashboard, filter, and scroll through the virtualized result:

- first stable render under 2 seconds on the local test host;
- filtered update under 500ms;
- no console error/warning;
- no unbounded DOM row growth after ten updates.

The isolated browser run recorded 98ms DOMContentLoaded/load, 25ms blocked-filter update, 22 live DOM rows for 1,000 tasks, successful bottom scroll to task 0999, and zero console errors. This is browser-gate evidence rather than a Node test because project instructions prohibit installing a second local Playwright runtime.

- [x] **Step 2: Run the complete automated gate**

Run:

    npm run check
    npm run build
    npm test
    npm run build:adapters
    npm run package:release -- --output-dir release

Expected: every command exits 0; node:test reports zero fail/cancel/skip/todo unless a test explicitly documents a portable environment skip.

- [x] **Step 3: Run isolated packaged runtime smoke**

Use a temporary config/database/port and the packaged runtime, not source imports. Exercise:

- health/ready;
- snapshot and SSE ready/changed;
- root + child tree;
- status success and conflict;
- Details and Inbox reads;
- same-URL refresh state persistence;
- graceful service shutdown.

Confirm the user's real DB counts and integrity are unchanged before/after.

- [x] **Step 4: Execute visual-driven review**

Use playwright-headless at PC 1440 × 900. Cover every material state named in the design spec. For each state:

- capture viewport screenshot;
- inspect it at original resolution;
- sweep navigation, edges, primary content, repeated rows, overlays, bottom controls;
- run spacing, content/container, structural residue, and edge-spacing micro checks;
- record exact STEP and VISUAL markers.

Write:

    .vdr-log/20260816-svar-gantt-pc/report.md
    .vdr-log/20260816-svar-gantt-pc/report.html

- [x] **Step 5: Requirement-by-requirement completion audit**

Create a table mapping each design requirement to:

- source/test/browser evidence;
- pass/fail/unknown;
- remaining gap.

Any missing or indirect evidence counts as not complete.

- [x] **Step 6: Apply fallback gate**

If any fallback condition is true, do not patch around a library-level defect indefinitely. Create:

    branch: experiment/native-gantt-dashboard
    path: .worktree/experiment-native-gantt-dashboard

Verify worktree list/path/branch mapping, then write a native renderer plan that reuses the same acceptance matrix and repeat Tasks 2–8 there.

If every fallback condition is false and all production gates pass, retain this worktree as the successful product candidate. Report its absolute path, branch, changed files, verification evidence, visual report, and uncommitted Git status.

## Final Verification Evidence

### Automated and package gates

| Gate | Fresh evidence | Result |
| --- | --- | --- |
| Syntax/contracts | `npm run check` | PASS |
| Dependency security | `npm audit` → 0 vulnerabilities | PASS |
| Standalone build | `npm run build` | PASS |
| Full regression | `npm test` → 183 pass, 0 fail/cancel/skip/todo | PASS |
| Adapter artifacts | `npm run build:adapters` emitted Codex + Claude MCP bundles | PASS |
| Release archives | explicit `package:release -- --output /tmp/tasks-recorder-svar-final-release.dF3L4z` emitted runtime + 2 adapters | PASS |
| Packaged runtime | full suite executed extracted runtime, importer, taskd lifecycle/API, CLI, and both adapter MCP bundles outside source tree | PASS |
| Diff hygiene | `git diff --check` | PASS |

### Requirement mapping

| Requirement group | Source/test/browser evidence | Verdict |
| --- | --- | --- |
| Tabs/filter/history/root counts | `svar-gantt-state.test.mjs`, controller tests, History VDR | PASS |
| Five decision Grid columns and complete context | projection/cell tests; 792px client/scroll width equality; complete context popover | PASS |
| Tree disclosure and state restore | open-task wiring; pointer + ArrowLeft/Right; filter/SSE persistence | PASS |
| Grid/Task column resizing | SVAR native pointer drag; application separator keyboard; reload/SSE width evidence | PASS |
| Session copy/status/progress | cell tests; copy/status mutation browser probes | PASS |
| Timeline/bar/labels/current time | day/week/month and restore-race tests; locate and VDR geometry | PASS |
| Details/Inbox + density | multiline Next action; 30px Grid rows; grouped toolbar; three-tab/empty-state VDR | PASS |
| Realtime/failure | coordinator/EventSource tests; taskd interrupt/recover VDR; React Error Boundary tests | PASS |
| Security/offline/license | escaped React text, no raw HTML, no CDN/font/key/watermark/DHTMLX bundle; MIT notices | PASS |
| Scale | isolated 1,000-task browser gate: 22 virtual rows, 98ms load, 25ms filter, bottom scroll | PASS |
| Visual production gate | PC 1440 × 900 multi-state VDR，Critical 0 / High 0 / Medium 0 | PASS |

### Fallback decision

All six fallback conditions are false: no library-level tree/sync/splitter defect, custom cells meet interaction/ARIA requirements, SSE state replacement is stable, no PRO/key path is needed, the standalone bundle remains below 2 MiB, and VDR has no Medium-or-higher issue. Therefore the native renderer worktree is intentionally **not created**.

Visual evidence: `.vdr-log/20260816-product-redesign-pc/report.md`.

### Task 9: Product-control-plane refinement

**Product intent:** Optimize for rapid project-cycle comprehension and intervention, not for exposing every database field at once.

- [x] Replace the day + six-hour default with persisted day/week/month presets. Default week covers at least 56 days; day covers 21 days; month covers 240 days.
- [x] Keep day-level task placement under week/month headers so short tasks do not inflate to whole scale cells.
- [x] Compute Timeline bounds from the visible projection only; hidden historical roots cannot distort active work.
- [x] Compute every summary range as the complete descendant time envelope.
- [x] Replace the ten-column horizontal-scroll default with a 792px five-column decision view: Task, Status/Progress, Execution Context, Session ID, Activity.
- [x] Merge working directory, Worktree, and Branch into a scannable context cell while preserving all complete values in the keyboard/pointer popover.
- [x] Compact Session IDs visually while retaining the complete copy payload.
- [x] Establish a 30px row / 24px scale rhythm, status-aware bars, summary scope brackets, grouped semantic toolbar controls, and 10px viewport gutters.
- [x] Fix the render/restore/locate race so changing scale reliably leaves today inside the viewport.
- [x] Format stale activity in days/hours instead of unbounded hour/minute strings.
- [x] Verify at 1440 × 900: zero Grid horizontal overflow, one disclosure control, collapse/expand, labels, Timeline visibility, status menu, context popover, zoom persistence, day locate, and summary containment.

Latest visual evidence: `.vdr-log/20260816-product-redesign-pc/`.
