# Schedule Capability Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let every Markdown Schedule decide whether Codex Skills and integrations enter its Run context, with new Schedules defaulting to an isolated context.

**Architecture:** Persist a generic two-field capability policy in the Schedule and immutable Run snapshot. The Codex adapter resolves integration disables before spawning app-server, discovers Skill paths before `thread/start`, and applies only trusted per-Run overrides without modifying global Codex configuration.

**Tech Stack:** Node.js 24 ESM, Codex app-server JSON-RPC, Markdown/YAML Schedule definitions, React 19, React Aria Components, Node test runner, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-31-schedule-capability-isolation-design.md`

## Global Constraints

- `CapabilityMode` is exactly `inherit | disabled`.
- Existing definitions without `capabilities` normalize to both fields `inherit`.
- New Dashboard drafts default both fields to `disabled`.
- `integrations` means MCP servers, plugin MCP, and Apps/Connectors; it does not include Web Search.
- No persistent Codex config or profile is written.
- Capability isolation fails closed before `thread/start`.
- All process execution uses argv with `shell: false`, bounded output, and bounded timeout.
- Do not commit without an explicit user request.

---

### Task 1: Schedule and REST capability contract

**Files:**
- Modify: `server/src/scheduler/schedule-definition-codec.mjs`
- Modify: `server/src/scheduler/schedule-definition-repository.mjs`
- Modify: `server/src/scheduler/scheduler-service.mjs`
- Modify: `server/src/api-server.mjs`
- Modify: `test/schedule-definition-codec.test.mjs`
- Modify: `test/schedule-definition-repository.test.mjs`
- Modify: `test/definition-schedule-service.test.mjs`
- Modify: `test/scheduled-api.test.mjs`

**Interfaces:**
- Produces: `capabilities: { skills: 'inherit' | 'disabled', integrations: 'inherit' | 'disabled' }` on every normalized Schedule.
- Produces: exact REST create/update support for the same nested object.

- [x] Write failing codec tests proving absent fields inherit, explicit fields round-trip, unknown keys fail, and invalid modes fail.
- [x] Run the focused tests and verify they fail because `capabilities` is unsupported.
- [x] Add one exact nested validator and serializer path; add the field to repository/service/API allowlists.
- [x] Run focused tests and verify the complete Schedule contract passes.
- [x] Confirm Run creation retains the object through existing `snapshot_json` persistence.

### Task 2: Codex capability resolver and app-server boundary

**Files:**
- Create: `server/src/runtime/codex-capability-policy.mjs`
- Modify: `server/src/runtime/codex-app-server-client.mjs`
- Modify: `server/src/runtime/adapters/codex.mjs`
- Modify: `server/src/runtime/adapters/codex-interactive-session.mjs`
- Create: `test/codex-capability-policy.test.mjs`
- Modify: `test/codex-app-server-client.test.mjs`
- Modify: `test/codex-interactive-session.test.mjs`
- Modify: `test/codex-runtime-adapter.test.mjs`

**Interfaces:**
- Produces: `createCodexCapabilityPolicyResolver({ execFileImpl, runtimeEnvironment })` with `resolveLaunch({ executable, cwd, capabilities }): Promise<{ configOverrides: string[], disabledFeatures: string[] }>`.
- Consumes: `configOverrides` in `createCodexAppServerClient` and turns each trusted string into `-c <value>` before `--listen stdio://`.
- Produces: `skillsThreadConfig(skillsListResponse)` returning the exact per-thread `skills.config` object.

- [x] Write failing resolver tests for bounded `codex mcp list --json`, exact config keys, plugin/app disables, inherited no-op, malformed output, timeout, and duplicate identities.
- [x] Run resolver tests and verify missing implementation failures.
- [x] Implement the shell-free bounded resolver and stable errors.
- [x] Write and run failing client tests proving only trusted override arrays affect spawned argv.
- [x] Add validated config override support to the app-server client.
- [x] Write and run failing interactive-session tests proving Skills are enumerated before `thread/start`, disabled paths enter only thread config, inherited Skills cause no list request, Web Search config is untouched, and discovery failure prevents Thread creation.
- [x] Refactor interactive startup so capability resolution precedes client creation and abort remains prompt before/after preflight.
- [x] Advertise Codex isolation support in runtime capabilities and run the focused runtime suite.

### Task 3: React Schedule editor controls

**Files:**
- Modify: `ui/react/lib/api/types.ts`
- Modify: `ui/react/features/scheduled/schedule-draft.ts`
- Modify: `ui/react/features/scheduled/schedule-editor-dialog.tsx`
- Modify: `ui/react/styles/app.css`
- Modify: `ui/react/features/scheduled/schedule-draft.test.ts`
- Modify: `ui/react/features/scheduled/schedule-editor-dialog.test.tsx`

**Interfaces:**
- Consumes: normalized Schedule `capabilities` and runtime capability metadata.
- Produces: REST mutation payload with exact capability modes.

- [x] Write failing draft tests proving new drafts default disabled, existing definitions map exactly, and mutation payloads preserve both modes.
- [x] Run focused Vitest tests and verify the missing fields fail.
- [x] Add typed draft mapping and validation.
- [x] Write failing interaction tests for two accessible switches, explanatory copy, and edit/create states.
- [x] Add the compact Context controls using the existing design system; do not introduce a new component dependency.
- [x] Run focused UI tests, typecheck, and production Dashboard build.

### Task 4: End-to-end isolation verification and documentation

**Files:**
- Modify: `test/scheduled-runtime-e2e.test.mjs`
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-08-27-runtime-agent-registry-design.md`

**Interfaces:**
- Consumes: the complete Markdown → Run snapshot → app-server argv → thread config path.
- Produces: user-facing Markdown examples and runtime isolation guarantees.

- [x] Write a failing integration fixture whose fake Codex exposes MCP identities and Skill paths, then assert the actual Run receives explicit integration disables and per-thread Skill disables while no Web Search key is changed.
- [x] Run the integration test and verify it fails at the first missing isolation boundary.
- [x] Complete only the plumbing needed for the fixture to pass.
- [x] Update README Schedule frontmatter and execution-model sections with `capabilities` semantics and compatibility defaults.
- [x] Update the runtime registry design to include per-Run context isolation as an adapter capability.
- [x] Run `npm test`, `npm run test:ui`, `npm run check`, and `npm run build`.
- [x] Inspect `git diff --name-only HEAD`, scan the Markdown tree for affected contracts, and report whether further documentation synchronization is required.

## Self-review

- Spec coverage: Tasks 1–4 cover persistence, runtime isolation, UI, failure behavior, compatibility, Web Search exclusion, and documentation.
- Placeholder scan: no `TBD`, deferred implementation, or unspecified error handling remains.
- Type consistency: the Schedule and Run contract use `capabilities`; Codex-specific launch resolution uses `configOverrides`; UI maps checked to `inherit` and unchecked to `disabled`.
- Execution choice: the user explicitly requested implementation in this session, and team instructions prohibit unrequested sub-agent delegation, so execution is inline with `executing-plans`.
