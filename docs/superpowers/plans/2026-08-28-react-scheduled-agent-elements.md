# React Scheduled and AI Elements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port Scheduled Tasks and Live Run control into the React Dashboard and render active assistant output with a reviewed, dotUI-compatible subset of AI Elements.

**Architecture:** React owns the Scheduled route, Run Review and ephemeral Live Run state while reusing existing taskd REST/SSE contracts. AI Elements owns conversation scrolling and streaming Markdown only; dotUI remains the sole generic control system and taskd remains the runtime owner.

**Tech Stack:** React 19.2.8, TypeScript 7.0.2, TanStack Query 5.102.8, dotUI/React Aria, Vercel AI Elements source, Streamdown, Tailwind CSS 4.3.3, Vitest 4.1.11, Playwright MCP.

**Spec:** `docs/superpowers/specs/2026-08-28-react-scheduled-agent-elements-design.md`

## Global Constraints

- Do not change taskd, SQLite, Runtime Registry, Schedule files, Run API/SSE, Terminal Resume, or privacy contracts.
- Do not install shadcn generic primitives, `@ai-sdk/react`, AI Gateway, or `useChat`.
- Keep dotUI/React Aria as the only generic control and overlay system.
- Vendor only reviewed AI Elements conversation/message source and keep its license notice.
- Keep `ui/dist/react.html` offline and self-contained.
- Keep Legacy Scheduled UI available until React parity passes.
- Do not add new test files; extend existing React/API tests.
- Do not persist live message, prompt, guidance, activity payload, or transcript content.

---

### Task 1: Add typed Scheduled and Run API contracts

**Files:**
- Modify: `ui/react/lib/api/types.ts`
- Modify: `ui/react/lib/api/dashboard-api.ts`
- Modify: `ui/react/lib/api/dashboard-api.test.ts`
- Modify: `ui/react/lib/query/keys.ts`

**Interfaces:**
- Consumes: existing taskd Schedule, Run, log, steer, Stop, review and Resume routes.
- Produces: `ScheduleRecord`, `RunRecord`, `RunEvent`, `RunLog` and typed `DashboardApi` methods.

- [x] **Step 1: Extend the existing API test**

Assert URL, method and body shapes for `schedules`, `schedule`, `scheduleRuns`, `scheduledRun`, `runScheduleNow`, `steerRun`, `stopRun`, `scheduledRunLog`, `markScheduledRunReviewed`, and `resumeScheduledRun`.

- [x] **Step 2: Verify the test fails for missing methods**

Run: `npm run test:ui -- ui/react/lib/api/dashboard-api.test.ts`

Expected: FAIL because the React client lacks Scheduled/Run methods.

- [x] **Step 3: Add exact public types and methods**

Reuse Legacy field names and request bodies. Add these query keys:

```ts
schedules: ['schedules'] as const,
schedule: (id: string) => ['schedules', id] as const,
runs: (scheduleId: string) => ['schedules', scheduleId, 'runs'] as const,
run: (runId: string) => ['runs', runId] as const,
```

- [x] **Step 4: Verify the client**

Run: `npm run test:ui -- ui/react/lib/api/dashboard-api.test.ts && npm run check`

Expected: PASS.

### Task 2: Add persisted React Scheduled routing and list

**Files:**
- Modify: `ui/react/app/dashboard-app.tsx`
- Modify: `ui/react/app/app-shell.tsx`
- Modify: `ui/react/app/navigation.tsx`
- Modify: `ui/react/app/app-shell.test.tsx`
- Modify: `ui/react/lib/preferences/dashboard-preferences.ts`
- Create: `ui/react/features/scheduled/scheduled-view.tsx`
- Create: `ui/react/features/scheduled/schedule-card.tsx`
- Create: `ui/react/features/scheduled/schedule-format.ts`
- Modify: `ui/react/styles/app.css`

**Interfaces:**
- Consumes: `DashboardApi.schedules()` and `DashboardView = 'tasks' | 'scheduled'`.
- Produces: live route switch and Schedule list actions for Run now, pause/resume, edit and review.

- [x] **Step 1: Extend app-shell tests for two routes**

Assert Scheduled is enabled, route switching renders the correct workspace, and the view persists.

- [x] **Step 2: Verify Scheduled is currently disabled**

Run: `npm run test:ui -- ui/react/app/app-shell.test.tsx`

Expected: FAIL on the disabled Scheduled control.

- [x] **Step 3: Implement controlled route state and Schedule list**

Lift `view` into `DashboardApp`, query only selected workspace data, port Legacy ordering/filter helpers into pure TypeScript, and use dotUI `Button`, `SearchField`, and `Select`.

- [x] **Step 4: Implement safe Run now and pause/resume mutations**

Run now creates a unique idempotency key. Pause/resume preserves `etag` conflicts and keeps errors scoped to the affected Schedule.

- [x] **Step 5: Verify route and list**

Run: `npm run test:ui -- ui/react/app/app-shell.test.tsx && npm run check && npm run build`

Expected: PASS and Scheduled is visible in React preview.

### Task 3: Port Run Review facts and actions

**Files:**
- Create: `ui/react/features/scheduled/run-review-drawer.tsx`
- Create: `ui/react/features/scheduled/run-history.tsx`
- Create: `ui/react/features/scheduled/run-detail.tsx`
- Modify: `ui/react/features/scheduled/scheduled-view.tsx`
- Modify: `ui/react/app/app-shell.test.tsx`
- Modify: `ui/react/styles/app.css`

**Interfaces:**
- Consumes: typed Schedule/Run client and dotUI Drawer/Tabs/Button.
- Produces: controlled Run Review with selection, logs, copy, mark-reviewed and Terminal Resume.

- [x] **Step 1: Extend integration tests for the Run Review durable path**

Cover open, authoritative detail, files and explicit bounded log activation. Loading, error and empty states remain part of the final visual state audit.

- [x] **Step 2: Verify Run Review is absent**

Run: `npm run test:ui -- ui/react/app/app-shell.test.tsx`

Expected: FAIL on the missing Run Review.

- [x] **Step 3: Implement history and authoritative detail queries**

Sort Runs newest-first. Selecting a row fetches exact detail; logs fetch only on explicit tab activation and remain bounded to 32 KiB.

- [x] **Step 4: Implement safe terminal actions**

Copy returned Session ID, Resume with only Run ID, and invalidate affected queries after mutations.

- [x] **Step 5: Verify Run Review**

Run: `npm run test:ui -- ui/react/app/app-shell.test.tsx && npm run check`

Expected: PASS, including Escape close and focus restoration.

### Task 4: Vendor minimal AI Elements presentation

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `ui/react/components/ai-elements/conversation.tsx`
- Create: `ui/react/components/ai-elements/message.tsx`
- Modify: `ui/react/components/registry/README.md`
- Modify: `ui/THIRD_PARTY_NOTICES.md`
- Modify: `server/THIRD_PARTY_NOTICES.md`
- Modify: `ui/react/styles/app.css`
- Modify: `ui/react/test/toolchain.test.ts`

**Interfaces:**
- Consumes: official `conversation` and `message` registry source, dotUI Button/Tooltip and Streamdown styles.
- Produces: conversation scrolling and streaming Markdown without shadcn generic primitives.

- [x] **Step 1: Extend the toolchain contract**

Assert Streamdown dependencies/source scanning exist, `@ai-sdk/react` does not, and no parallel shadcn component directory or import exists.

- [x] **Step 2: Fetch and review upstream source outside the repository**

Inspect official `packages/elements/src/conversation.tsx` and `message.tsx`; record origin and Apache-2.0 notice. Do not run the all-components installer.

- [x] **Step 3: Add required source and dependencies only**

Adapt Button/Tooltip imports to repository dotUI. Exclude download, branching, attachments and unused actions. Add Streamdown's required Tailwind source directive.

- [x] **Step 4: Verify single-system and offline constraints**

Run: `npm run test:ui -- ui/react/test/toolchain.test.ts && npm run check && npm run build`

Then run:

```bash
rg -n "@ai-sdk/react|radix-ui|class-variance-authority|elements\.ai-sdk\.dev" ui/dist/react.html package.json ui/react --glob '!**/*.test.ts' --glob '!components/registry/README.md'
```

Expected: no forbidden runtime/dependency match.

### Task 5: Connect Live Run state and intervention

**Files:**
- Create: `ui/react/features/scheduled/live-run.ts`
- Create: `ui/react/features/scheduled/live-session.tsx`
- Reuse: `TextArea` from `ui/react/components/ui/input.tsx`
- Modify: `ui/react/features/scheduled/run-detail.tsx`
- Modify: `ui/react/app/app-shell.test.tsx`
- Modify: `ui/react/styles/app.css`

**Interfaces:**
- Consumes: Run SSE and AI Elements components.
- Produces: `useLiveRun({ run, api })` with connection, Turn revision, ordered entries, draft, steer and Stop behavior.

- [x] **Step 1: Extend integration tests with ordered live events**

Feed Turn, two deltas for one item, activity start/completion, disconnect/reset and terminal status. Assert ordering, merged text, composer state, typed errors and authoritative terminal refresh.

- [x] **Step 2: Verify Live Session is absent**

Run: `npm run test:ui -- ui/react/app/app-shell.test.tsx`

Expected: FAIL.

- [x] **Step 3: Port the proven EventSource reducer into an isolated hook**

Keep sequence in memory, reconnect with `since`, merge by `item_id`, discard content when Run changes, and never persist content.

- [x] **Step 4: Render AI Elements plus dotUI composer**

Map assistant entries to `MessageResponse`; render bounded activity summaries separately. Keyboard submit calls steer, failures retain draft, and no optimistic user bubble is created.

- [x] **Step 5: Reconcile Stop and terminal state**

Stop submits public Turn revision only. Terminal SSE closes the stream and fetches authoritative Run detail.

Implementation note: the optional `@streamdown/code` plugin was evaluated and removed after the production single-file bundle grew from roughly 1.3 MiB to 11.5 MiB. Its public configuration exposes themes but no language allowlist and imports Shiki's complete bundled-language registry. Streamdown, the CJK plugin, fenced code blocks and product-owned code styling remain; the verified production bundle is 1,853,407 bytes.

- [ ] **Step 6: Verify Live Session**

Run: `npm run test:ui -- ui/react/app/app-shell.test.tsx && npm run check && npm run build`

Expected: PASS.

### Task 6: Port the Schedule editor and reach parity

**Files:**
- Create: `ui/react/features/scheduled/schedule-editor-dialog.tsx`
- Create: `ui/react/features/scheduled/schedule-draft.ts`
- Modify: `ui/react/features/scheduled/scheduled-view.tsx`
- Modify: `ui/react/lib/api/types.ts`
- Modify: `ui/react/lib/api/dashboard-api.ts`
- Modify: `ui/react/app/app-shell.test.tsx`
- Modify: `ui/react/styles/app.css`

**Interfaces:**
- Consumes: Runtime Registry/model catalog and Schedule create/update contracts.
- Produces: create/edit flow with cadence, sandbox, model, reasoning, timeout and `etag` semantics.

- [ ] **Step 1: Extend integration tests for editor behavior**

Cover create/edit, cadence fields, model catalog, danger confirmation, validation, conflict retention and focus restoration.

- [ ] **Step 2: Verify editor actions are incomplete**

Run: `npm run test:ui -- ui/react/app/app-shell.test.tsx`

Expected: FAIL on Create/Edit.

- [ ] **Step 3: Port normalization and payload logic as pure TypeScript**

Preserve exact Legacy limits, cadence shape, catalog checks, timeout bounds and danger confirmation.

- [ ] **Step 4: Build the editor from dotUI primitives**

Use a controlled form, inline errors, saving state and `expected_etag`. Agent changes refresh the model catalog without taskd restart.

- [ ] **Step 5: Verify editor parity**

Run: `npm run test:ui -- ui/react/app/app-shell.test.tsx && npm run check`

Expected: PASS.

### Task 7: Visual verification, audit and documentation

**Files:**
- Modify: `docs/superpowers/plans/2026-08-28-react-scheduled-agent-elements.md`
- Modify: `README.md`
- Modify: `docs/architecture.md`
- Modify: matching maintenance docs found by the documentation scan.

**Interfaces:**
- Consumes: complete React Scheduled vertical slice and local taskd data.
- Produces: visual evidence, public documentation and a Legacy cutover decision.

- [ ] **Step 1: Run the full gate**

```bash
npm run test:ui
npm run check
npm run build
git diff --check
```

Expected: all pass.

- [ ] **Step 2: Verify a real local flow with Playwright headless**

At 1440×840 and 1024×768 verify Tasks/Scheduled persistence, filtering, Run now, Review, streaming, steer, Stop/terminal convergence, logs, Session copy/Resume, editor validation, keyboard focus, reduced motion and overflow. Use the real local `codex update report` Schedule when available without committing its content.

- [ ] **Step 3: Audit boundaries**

```bash
rg -n "@ai-sdk/react|radix-ui|class-variance-authority|elements\.ai-sdk\.dev|fonts\.(googleapis|gstatic)\.com" ui/dist/react.html package.json
rg -n "localStorage.*(message|prompt|guidance|transcript)|persist.*(message|prompt|guidance|transcript)" ui/react server
```

Expected: no forbidden match.

- [ ] **Step 4: Scan and synchronize docs**

```bash
git diff --name-only HEAD
find . -name '*.md' -not -path '*/node_modules/*' -not -path '*/.git/*'
rg -n "Legacy|Scheduled|Live Session|AI Elements|React Dashboard|react\.html" --glob '*.md' .
```

Update every current README, architecture and maintenance statement affected by React Scheduled and ephemeral transcripts.

- [ ] **Step 5: Record evidence and decide cutover**

Mark exact commands/results and screenshot paths. Remove the React migration label only after parity; retain Legacy files until a later explicit deletion task.
