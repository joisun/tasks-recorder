# React dotUI Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the React Dashboard's shadcn/Radix and raw generic controls with one checked-in dotUI/React Aria component system using the official Vercel preset, while preserving the existing backend, SVAR Gantt, offline single-file build and Legacy Dashboard.

**Architecture:** Generate the official Vercel preset in an isolated temporary project, then selectively apply reviewed source and configuration to the existing React preview. dotUI owns generic controls and overlays; Tasks Recorder owns product layout/status mapping; SVAR remains the Tree/Timeline renderer. Migration proceeds surface-by-surface and removes the temporary Radix dependency only after all consumers use React Aria semantics.

**Tech Stack:** React 19.2.8, TypeScript 7.0.2, Tailwind CSS 4.3.3, dotUI Vercel preset, React Aria Components, tailwind-variants, TanStack Query 5.102.8, SVAR React Gantt 2.7.1, Vitest 4.1.11, Playwright MCP.

**Spec:** `docs/superpowers/specs/2026-08-28-react-dotui-ui-migration-design.md`

## Global Constraints

- Do not change taskd, REST/SSE, SQLite, Runtime Registry, Agent adapter, Session resume or Scheduler contracts.
- Keep `ui/dist/react.html` as an offline, self-contained single-file build; no remote font, CDN, runtime registry fetch or credential.
- Pin the official dotUI `Vercel · Geist · 8px · default` preset URL from the spec.
- Treat React Aria event, selection, disabled and overlay semantics as an API migration; do not only swap imports.
- Preserve SVAR ownership of Tree/Timeline rendering and row geometry.
- Do not add new test files in this migration; update and run the existing test suite.
- Preserve unrelated uncommitted work. Do not commit unless the user explicitly requests it.

## Execution Evidence — 2026-08-28

- Official dotUI Create preset confirmed as `Vercel · Geist · 8px · default`; the exact registry URL is pinned in `ui/components.json`.
- The shadcn CLI closed its connection while expanding the official init URL in three isolated attempts. Direct official registry JSON endpoints returned 200 and were reviewed before applying source through patches; no runtime registry call was introduced.
- Production React source contains no native `<button>` or `<select>`, Radix import, CVA import, or `event.target.value` select adapter. Test-only fixtures may still use native elements.
- `npm run test:ui`: 9 files, 39 tests passed. `npm run check`, `npm run build`, and `git diff --check` passed.
- The built `ui/dist/react.html` is self-contained and contains no dotui.org, Google Fonts, or Radix runtime URL.
- Playwright headless passed at 1440×840 and 1024×768: search/filter/select, scale switch and restore, NOW, Timeline label placement and persisted visibility, Task Details, Inbox, focus restoration, non-modal background access, stable 30px task rows, and splitter drag x=494 → 574 → 494. Fresh-tab console: 0 errors, 0 warnings.
- Visual evidence: `.playwright-mcp/page-2026-08-28T09-46-28-541Z.png`, `.playwright-mcp/page-2026-08-28T09-34-23-405Z.png`, `.playwright-mcp/page-2026-08-28T09-38-39-334Z.png`.

---

### Task 1: Capture and pin the official dotUI foundation

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `ui/components.json`
- Modify: `ui/react/styles/tokens.css`
- Modify: `ui/react/styles/app.css`
- Modify: `test/react-toolchain-contract.test.mjs`
- Modify: `ui/react/test/toolchain.test.ts`

**Interfaces:**
- Consumes: the pinned preset URL from the design spec and the existing `ui/compiler.mjs` single-file build.
- Produces: a checked-in dotUI registry configuration, dependency set and token/plugin foundation usable by every later task.

- [x] **Step 1: Generate official output outside the repository**

Create a temporary directory with `mktemp -d`, run the exact official command below there, and inspect rather than copying blindly:

```bash
npx shadcn@latest init 'https://dotui.org/r/init?preset=rVBrS8MwFP0r5frFQaJZO9fRf3PzWFuXNSGP6Rj97-a2qIggCuZCuI9z7uPcwEN3A4m6N-QE1GOO0AHnq8uP2VqYGSh3PuOkCRTT1RY0NDCXQqIU53FA7V64u5hg8Vqqojr412q7Lx_flS_08l5UZI-VeBC7DStuTZWmJszhO2a_AfbZWmHQ_9aXLqLFL9DVDKIxOlKISpmpXAR325aszJ9MTgEt5dqGDAhvjUqjmygrRFsfn6ijRHqg8urTBrDCTpR8iRKGLVZRihnXeDSBW0CxR6tSYn0fJ_E4NnJEueRD0Rd5V9YPTHs2A_pZ2rMMllD-PmDvOr3Kzp6_5XrnV82-SO9vDc'
```

Expected: generated configuration identifies dotUI and the preset; output includes React Aria/Tailwind plugin dependencies and theme source without runtime network code.

- [x] **Step 2: Pin the registry and dependency contract**

Update `ui/components.json` so `registries.@dotui` resolves the exact preset:

```json
{
  "registries": {
    "@dotui": "https://dotui.org/r/{name}?preset=rVBrS8MwFP0r5frFQaJZO9fRf3PzWFuXNSGP6Rj97-a2qIggCuZCuI9z7uPcwEN3A4m6N-QE1GOO0AHnq8uP2VqYGSh3PuOkCRTT1RY0NDCXQqIU53FA7V64u5hg8Vqqojr412q7Lx_flS_08l5UZI-VeBC7DStuTZWmJszhO2a_AfbZWmHQ_9aXLqLFL9DVDKIxOlKISpmpXAR325aszJ9MTgEt5dqGDAhvjUqjmygrRFsfn6ijRHqg8urTBrDCTpR8iRKGLVZRihnXeDSBW0CxR6tSYn0fJ_E4NnJEueRD0Rd5V9YPTHs2A_pZ2rMMllD-PmDvOr3Kzp6_5XrnV82-SO9vDc"
  }
}
```

Add the generated runtime dependencies at exact lockfile versions. Remove `class-variance-authority` only after Task 4 removes its last import; remove `radix-ui` only after Task 4 removes its last import.

- [x] **Step 3: Merge tokens without overwriting product styles**

Bring in the official Tailwind imports/plugins and Vercel preset semantic variables. Keep Tasks Recorder aliases such as Timeline/NOW/status variables below the dotUI layer; delete only selectors proven to be generic control replicas.

- [x] **Step 4: Update existing toolchain assertions**

Extend the existing tests to assert:

```js
assert.match(componentsJson.registries['@dotui'], /^https:\/\/dotui\.org\/r\/\{name\}\?preset=/)
assert.equal(packageJson.dependencies['react-aria-components'] !== undefined, true)
assert.equal(packageJson.dependencies['tailwind-variants'] !== undefined, true)
```

- [x] **Step 5: Verify foundation compatibility**

Run:

```bash
npm run check
npm run test:ui -- ui/react/test/toolchain.test.ts
npm run build
```

Expected: all pass; `ui/dist/react.html` remains a single file and contains no `https://dotui.org` or remote font URL.

### Task 2: Replace Button, SearchField and Select primitives

**Files:**
- Modify: `ui/react/components/ui/button.tsx`
- Create: `ui/react/components/ui/search-field.tsx`
- Create: `ui/react/components/ui/select.tsx`
- Modify: `ui/react/components/system/icon-button.tsx`
- Modify: `ui/react/components/system/design-system.test.tsx`
- Modify: `ui/react/features/tasks/tasks-toolbar.tsx`
- Modify: `ui/react/styles/app.css`

**Interfaces:**
- Consumes: dotUI tokens and dependencies from Task 1.
- Produces: `Button`, `SearchField` and `Select` source components with React Aria props; toolbar callbacks remain `(value: string) => void` at the feature boundary.

- [x] **Step 1: Install and review source in the temporary project**

Run in the isolated generated project:

```bash
npx shadcn@latest add @dotui/button @dotui/search-field @dotui/select
```

Copy the generated source through reviewed patches. Preserve dotUI exports and styling; change only import aliases required by this repository.

- [x] **Step 2: Migrate Button consumers to React Aria semantics**

Use `onPress` for activation and `isDisabled` for disabled state:

```tsx
<Button onPress={onNow} size="xs" variant="quiet">NOW</Button>
```

`IconButton` continues to require an accessible label and delegates to dotUI Button.

- [x] **Step 3: Migrate the Tasks Toolbar**

Replace the search label/input with `SearchField`; replace status and timeline-scale native selects with dotUI `Select`. Convert React Aria selected keys to the existing typed callbacks:

```tsx
<Select
  aria-label="任务状态"
  selectedKey={status}
  onSelectionChange={(key) => onStatusChange(String(key) as TaskStatusScope)}
/>
```

- [x] **Step 4: Remove toolbar control replicas**

Delete toolbar-specific input/select/button appearance rules. Retain only grid placement, width constraints, gaps and product-specific badge layout.

- [x] **Step 5: Update and run existing tests**

Update `design-system.test.tsx` to activate controls through user interaction and assert accessible names/selected values. Run:

```bash
npm run test:ui -- ui/react/components/system/design-system.test.tsx ui/react/features/tasks/tasks-view.test.tsx
npm run check
npm run build
```

Expected: all pass; no native `select` remains in `tasks-toolbar.tsx`.

### Task 3: Migrate remaining forms and domain status controls

**Files:**
- Modify: `ui/react/features/tasks/task-status-control.tsx`
- Modify: `ui/react/features/tasks/task-details-sheet.tsx`
- Modify: `ui/react/features/inbox/execution-inbox.tsx`
- Modify: `ui/react/features/inbox/project-inbox.tsx`
- Modify: `ui/react/features/tasks/tasks-view.test.tsx`
- Modify: `ui/react/styles/app.css`

**Interfaces:**
- Consumes: `SearchField` and `Select` from Task 2.
- Produces: typed domain adapters that map React Aria keys to `TaskStatus`, Task IDs and Inbox filter values without DOM event casts.

- [x] **Step 1: Replace every production native select**

Use controlled `selectedKey` and `onSelectionChange`; preserve existing option copy, disabled conditions and mutations. Verify with:

```bash
rg -n '<select|event\.target\.value' ui/react --glob '*.tsx'
```

Expected: no production match for generic select handling; test-only DOM controls may remain when they are fixtures.

- [x] **Step 2: Replace generic search/text inputs where dotUI has ownership**

Use `SearchField` for filtering and dotUI `TextField` for editable values. Keep checkbox/radio semantics native only until their dotUI counterparts are migrated in the same component.

- [x] **Step 3: Preserve mutation and conflict behavior**

Keep existing callbacks and `expected_revision` flows unchanged. Disabled/loading states use `isDisabled`/`isPending`, but error and conflict messages continue to come from the existing API layer.

- [x] **Step 4: Update and run existing feature tests**

Run:

```bash
npm run test:ui -- ui/react/features/tasks/tasks-view.test.tsx
npm run check
```

Expected: all pass; status, assignment and filters remain keyboard operable.

### Task 4: Replace navigation and overlay primitives

**Files:**
- Replace: `ui/react/components/ui/tabs.tsx`
- Replace: `ui/react/components/ui/tooltip.tsx`
- Replace: `ui/react/components/ui/dropdown-menu.tsx`
- Replace: `ui/react/components/ui/separator.tsx`
- Create: `ui/react/components/ui/drawer.tsx`
- Create: `ui/react/components/ui/dialog.tsx`
- Delete: `ui/react/components/ui/sheet.tsx`
- Modify: `ui/react/features/tasks/task-details-sheet.tsx`
- Modify: `ui/react/features/inbox/inbox-drawer.tsx`
- Modify: `ui/react/app/connection-status.tsx`
- Modify: `ui/react/features/tasks/context-cell.tsx`
- Modify: `ui/react/app/app-shell.test.tsx`
- Modify: `ui/react/features/tasks/context-cell.test.tsx`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Consumes: the dotUI foundation and Button from Tasks 1–2.
- Produces: one React Aria overlay/navigation system; Task Details and Inbox remain controlled by their existing `open`/`onOpenChange` feature props.

- [x] **Step 1: Install reviewed source**

Generate and review the primitives used by current product surfaces:

```bash
npx shadcn@latest add @dotui/tabs @dotui/tooltip @dotui/separator @dotui/drawer @dotui/modal
```

Use Drawer for contextual Task/Inbox panels and Modal/Dialog for blocking settings/editor interactions. The obsolete DropdownMenu source is removed rather than replaced speculatively because the current React surface has no menu consumer.

- [x] **Step 2: Migrate controlled state and selection**

Map current string tab values to React Aria `selectedKey`; map feature `open` to `isOpen`. Preserve accessible title/description and restore focus to the invoking control on close.

- [x] **Step 3: Remove Radix and CVA**

Run:

```bash
rg -n "from 'radix-ui'|class-variance-authority|--radix-" ui/react package.json
```

Expected: no source/CSS match. Remove both dependencies and refresh the lockfile.

- [x] **Step 4: Verify overlay behavior with existing tests**

Run:

```bash
npm run test:ui -- ui/react/app/app-shell.test.tsx ui/react/features/tasks/context-cell.test.tsx ui/react/features/tasks/tasks-view.test.tsx
npm run check
npm run build
```

Expected: all pass; Escape closes overlays, focus returns, menu and tabs work by keyboard.

### Task 5: Reduce CSS ownership and complete visual integration

**Files:**
- Modify: `ui/react/styles/tokens.css`
- Modify: `ui/react/styles/app.css`
- Modify: `ui/react/features/tasks/task-gantt.tsx`
- Modify: `ui/react/features/tasks/tasks-toolbar.tsx`
- Modify: `ui/react/app/app-shell.tsx`
- Modify: `ui/react/app/navigation.tsx`

**Interfaces:**
- Consumes: completed dotUI primitives and existing SVAR adapter.
- Produces: product-only CSS boundaries with unchanged Tree/Timeline geometry and NOW behavior.

- [x] **Step 1: Audit generic CSS debt**

Search for generic control, Radix and duplicated token selectors:

```bash
rg -n 'button|select|input|radix|focus-visible|popover|tooltip' ui/react/styles --glob '*.css'
```

Delete rules whose behavior is now owned by dotUI. Keep layout selectors and SVAR-specific selectors with explicit feature prefixes.

- [x] **Step 2: Align compact product density**

Use dotUI sizes rather than height overrides. Keep the toolbar one-row desktop layout, 11px metadata, 10px `NOW` label and stable Gantt row height. Do not shrink icon-button hit targets below the component's supported compact size.

- [x] **Step 3: Verify SVAR isolation**

Check Timeline grid, horizontal scroll, splitter, Tree/Timeline row alignment, NOW marker and resize behavior at 1440×840 and a narrow desktop viewport.

- [x] **Step 4: Run the full existing UI suite and build**

```bash
npm run test:ui
npm run check
npm run build
git diff --check
```

Expected: all pass.

### Task 6: Visual verification, offline audit and documentation sync

**Files:**
- Modify: `docs/superpowers/plans/2026-08-28-react-dotui-migration.md`
- Modify: `docs/superpowers/plans/2026-08-28-react-21st-tasks-foundation.md`
- Modify: `ui/react/components/registry/README.md`
- Modify: matching README/architecture/maintenance documents found by the required documentation scan.

**Interfaces:**
- Consumes: all migrated surfaces and existing development server.
- Produces: verification evidence, accurate maintenance guidance and an explicit list of any remaining cutover work.

- [x] **Step 1: Start the React preview**

```bash
npm run dev:ui:react
```

Use the URL printed by the server; do not publish a release for local preview.

- [x] **Step 2: Run Playwright verification**

With `playwright-headless`, verify at minimum:

- task search, status filter, scale selection and `NOW` action;
- keyboard focus and menu/select navigation;
- Task Details and Inbox open/close/focus return;
- Timeline row alignment, splitter and horizontal scroll;
- loading, empty, error and active states where fixtures/API expose them;
- desktop 1440×840 and narrow desktop width.

Expected: Critical 0, High 0; console has no error.

- [x] **Step 3: Audit the built artifact**

```bash
rg -n 'https://dotui\.org|fonts\.(googleapis|gstatic)\.com|radix-ui' ui/dist/react.html
```

Expected: no match.

- [x] **Step 4: Scan and update the documentation tree**

```bash
git diff --name-only HEAD
find . -name '*.md' -not -path '*/node_modules/*' -not -path '*/.git/*'
rg -n '21st|shadcn|Radix|dotUI|components\.json|react\.html' --glob '*.md' .
```

Update all matching current-behavior documents. Historical plans may retain completed facts only when clearly marked superseded.

- [x] **Step 5: Record evidence without committing**

Mark completed checkboxes in this plan, list exact commands/results and screenshot paths, then report changed files and remaining cutover phases. Do not commit until the user explicitly requests it.
