# Public Release and Native Adapters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish Tasks Recorder as an installable macOS service with GitHub Actions, a checksummed `install.sh`, separate native Codex and Claude Code adapters, and a public README explaining how the system works.

**Architecture:** `taskd` remains the only SQLite owner and exposes a localhost HTTP/SSE contract. The service is installed from an immutable GitHub Release into versioned directories, while Codex and Claude Code adapters are independent plugin roots that each ship their own hooks and bundled MCP client. Repository marketplace catalogs expose the adapters using each host's native format.

**Tech Stack:** Node.js 24 ESM, `node:sqlite`, esbuild, MCP SDK, macOS `launchd`, POSIX shell, GitHub Actions, GitHub CLI.

## Global Constraints

- Public repository is `https://github.com/joisun/tasks-recorder`.
- Service support in this release is macOS with Node.js 24 or newer.
- Persistent user data remains under `~/.config/tasks-recorder` and must survive upgrades/uninstall by default.
- Installed releases live under `~/.local/share/tasks-recorder/releases/<version>` with a `current` symlink.
- `install.sh` manages only the service; Codex and Claude Code adapters are installed separately through native marketplaces.
- Adapters may duplicate implementation and must not depend on a source checkout, project `node_modules`, or the service's internal install path.
- Project and distributed artifacts use GPL-2.0-only for the current DHTMLX-based release.
- Do not create commits, tags, or pushes without separate explicit user authorization.

---

### Task 1: Release package contract

**Files:**
- Create: `scripts/build-adapters.mjs`
- Create: `scripts/package-release.mjs`
- Create: `test/release-package.test.mjs`
- Modify: `package.json`
- Modify: `.gitignore`

**Interfaces:**
- Produces: `npm run build:adapters`, `npm run package:release`, and release files under `release/`.
- Runtime artifact: `release/tasks-recorder-macos.tar.gz` with a single `tasks-recorder-<version>/` root.
- Adapter artifacts: `release/tasks-recorder-{codex,claude}-adapter.tar.gz`.

- [ ] **Step 1: Write failing package behavior tests**

  Run the package command in a temporary output directory and assert the runtime archive contains `package.json`, `package-lock.json`, `server/`, only the `mcp/src/` modules required by `taskd`, `ui/dist/index.html`, `LICENSE`, and `ui/THIRD_PARTY_NOTICES.md`, while excluding `test/`, `.git/`, root MCP entrypoints, and source adapter dependencies.

- [ ] **Step 2: Run the focused test and verify RED**

  Run: `node --test test/release-package.test.mjs`

  Expected: FAIL because the packaging command and files do not exist.

- [ ] **Step 3: Implement deterministic build and packaging scripts**

  `scripts/build-adapters.mjs` bundles each adapter's own `mcp/server.mjs` entry into its plugin root `dist/mcp-server.mjs`. `scripts/package-release.mjs --output <dir>` builds UI/adapters, stages exact allowlists, and invokes system `tar` to create the three archives.

- [ ] **Step 4: Run focused and existing checks**

  Run: `node --test test/release-package.test.mjs && npm run build && npm run check`

- [ ] **Step 5: Record checkpoint without committing**

  Run: `git diff -- scripts package.json .gitignore test/release-package.test.mjs`

### Task 2: Prebuilt service installation mode

**Files:**
- Modify: `server/control.mjs`
- Modify: `test/control.test.mjs`

**Interfaces:**
- Consumes: a Release containing `ui/dist/index.html`.
- Produces: `TASKS_RECORDER_PREBUILT=1 node server/control.mjs install`, which validates the prebuilt dashboard instead of invoking esbuild.

- [ ] **Step 1: Write a failing test for prebuilt mode**

  Assert controller installation can use an injected prebuilt verifier without invoking a source build, and rejects a missing dashboard before writing/bootstraping the plist.

- [ ] **Step 2: Run the test and verify RED**

  Run: `node --test test/control.test.mjs`

- [ ] **Step 3: Implement the minimal prebuilt verifier**

  Keep source installs unchanged. When `TASKS_RECORDER_PREBUILT=1`, `main()` passes a build function that only checks `ui/dist/index.html` is readable.

- [ ] **Step 4: Run controller tests**

  Run: `node --test test/control.test.mjs`

- [ ] **Step 5: Record checkpoint without committing**

  Run: `git diff -- server/control.mjs test/control.test.mjs`

### Task 3: Checksummed service installer

**Files:**
- Create: `install.sh`
- Create: `test/install-script.test.mjs`

**Interfaces:**
- Consumes: GitHub Release assets `tasks-recorder-macos.tar.gz` and `SHA256SUMS`.
- Produces: versioned runtime, `current` symlink, default config, `~/.local/bin/tasks-recorder`, and a loaded LaunchAgent.
- Options: `--version <tag>`, `--no-start`, and `--uninstall`.
- Test override: `TASKS_RECORDER_RELEASE_BASE_URL` changes only the download origin.

- [ ] **Step 1: Write failing installer integration tests**

  Build a local release fixture and run `install.sh --no-start` with a temporary `HOME`. Assert checksum enforcement, preservation of an existing config/database, idempotent reinstall, a correct `current` symlink, and an executable management wrapper. Tamper with the archive and assert installation fails before switching `current`.

- [ ] **Step 2: Run focused tests and verify RED**

  Run: `node --test test/install-script.test.mjs`

- [ ] **Step 3: Implement the installer**

  Use `set -eu`, `mktemp -d`, an EXIT cleanup trap, exact platform/tool checks, safe tar member validation, SHA-256 verification, atomic symlink replacement, and data-preserving uninstall. Do not invoke `npm`, use `eval`, or execute downloaded code before verification.

- [ ] **Step 4: Run installer tests and shell syntax check**

  Run: `bash -n install.sh && node --test test/install-script.test.mjs`

- [ ] **Step 5: Record checkpoint without committing**

  Run: `git diff -- install.sh test/install-script.test.mjs`

### Task 4: Native Codex and Claude Code adapters

**Files:**
- Create: `.agents/plugins/marketplace.json`
- Create: `.claude-plugin/marketplace.json`
- Create: `adapters/codex/tasks-recorder/.codex-plugin/plugin.json`
- Create: `adapters/codex/tasks-recorder/.mcp.json`
- Create: `adapters/codex/tasks-recorder/hooks/**`
- Create: `adapters/codex/tasks-recorder/mcp/**`
- Create: `adapters/codex/tasks-recorder/skills/task-manager/SKILL.md`
- Create: `adapters/claude/tasks-recorder/.claude-plugin/plugin.json`
- Create: `adapters/claude/tasks-recorder/.mcp.json`
- Create: `adapters/claude/tasks-recorder/hooks/**`
- Create: `adapters/claude/tasks-recorder/mcp/**`
- Create: `adapters/claude/tasks-recorder/skills/task-manager/SKILL.md`
- Create: `test/plugin-adapters.test.mjs`

**Interfaces:**
- Codex marketplace ID: `tasks-recorder`; plugin ID: `tasks-recorder`.
- Claude marketplace ID: `tasks-recorder`; plugin ID: `tasks-recorder`.
- Both MCP clients consume only `~/.config/tasks-recorder/config.json`, `AGENT_TASKS_SERVER_URL`, and the localhost REST API.

- [ ] **Step 1: Write failing adapter contract tests**

  Assert each manifest and catalog has the correct native schema, plugin paths stay inside the plugin root, MCP config uses the correct root variable/schema, generated bundles start and complete MCP initialization against a temporary real `taskd`, and hooks report the correct host identity.

- [ ] **Step 2: Run focused tests and verify RED**

  Run: `node --test test/plugin-adapters.test.mjs`

- [ ] **Step 3: Implement Codex adapter**

  Create a self-contained plugin with Codex-native `${PLUGIN_ROOT}` paths, Codex manifest/catalog metadata, Codex hook scripts, adapter-local HTTP client, and adapter-local MCP server source.

- [ ] **Step 4: Implement Claude Code adapter**

  Create a self-contained plugin with Claude-native `${CLAUDE_PLUGIN_ROOT}` paths, wrapped `mcpServers` configuration, Claude manifest/catalog metadata, Claude hook scripts, adapter-local HTTP client, and adapter-local MCP server source.

- [ ] **Step 5: Build and validate adapters**

  Run:

  ```bash
  npm run build:adapters
  python3 /Users/joi-com/.dotfiles/dot.configs/ai/.agents/skills/.system/plugin-creator/scripts/validate_plugin.py adapters/codex/tasks-recorder
  claude plugin validate adapters/claude/tasks-recorder
  node --test test/plugin-adapters.test.mjs
  ```

- [ ] **Step 6: Perform local marketplace discovery smoke tests without installing persistently**

  Copy the repository to a temporary directory, run Codex/Claude validators or temporary-scope discovery where supported, and assert both catalogs resolve their adapter roots. Do not edit personal marketplace/config files.

- [ ] **Step 7: Record checkpoint without committing**

  Run: `git diff -- .agents .claude-plugin adapters test/plugin-adapters.test.mjs scripts/build-adapters.mjs`

### Task 5: CI, Release workflow, license, and public README

**Files:**
- Create: `.github/workflows/ci.yml`
- Create: `.github/workflows/release.yml`
- Create: `LICENSE`
- Rewrite: `README.md`
- Modify: `ui/THIRD_PARTY_NOTICES.md`
- Modify: `package.json`
- Create: `test/release-metadata.test.mjs`

**Interfaces:**
- CI runs build, checks, tests, adapter validation, package creation, and installer syntax/smoke tests.
- Release runs on `v*`, checks version parity, creates `SHA256SUMS`, and uploads three archives plus `install.sh`.

- [ ] **Step 1: Write failing metadata consistency tests**

  Assert `package.json`, both plugin manifests, marketplace versions, archive metadata, README install URL, workflow asset names, and GPL identifiers agree on the public contract.

- [ ] **Step 2: Run focused test and verify RED**

  Run: `node --test test/release-metadata.test.mjs`

- [ ] **Step 3: Add GPL-2.0-only license and notices**

  Add the complete GPL v2 text, set package/plugin license identifiers to `GPL-2.0-only`, and keep DHTMLX attribution/link in third-party notices.

- [ ] **Step 4: Add pinned, least-privilege workflows**

  `ci.yml` uses read-only permissions. `release.yml` grants only `contents: write`, validates `v${package.version}`, generates checksums with `shasum -a 256`, and creates the Release through `gh release create`.

- [ ] **Step 5: Rewrite README for public users**

  Include prerequisites, safe and one-line install variants, separate Codex/Claude plugin commands, hook trust behavior, dashboard/service commands, update/uninstall/data paths, troubleshooting, source development, security, license, and a **How it works** flow from prompt/tool/stop hooks through MCP/HTTP/taskd/SQLite/SSE.

- [ ] **Step 6: Run metadata and full project verification**

  Run: `npm test && npm run build && npm run check && npm run package:release && bash -n install.sh`.

- [ ] **Step 7: Record checkpoint without committing**

  Run: `git diff -- .github LICENSE README.md ui/THIRD_PARTY_NOTICES.md package.json test/release-metadata.test.mjs`

### Task 6: Documentation scan and GitHub repository setup

**Files:**
- Modify only docs found to reference changed paths/behavior.

**Interfaces:**
- Produces: a public, empty-or-unpushed GitHub repository remote at `joisun/tasks-recorder` without creating commits/tags/pushes.

- [ ] **Step 1: Scan structural documentation references**

  Run:

  ```bash
  git diff --name-only HEAD 2>/dev/null || git status --short
  find . -name '*.md' -not -path '*/node_modules/*' -not -path '*/.git/*'
  ```

  Update references to root `hooks/`, root `skills/`, installation, architecture, or publishing behavior where they are current public contracts. Preserve historical specs/plans as historical records unless they falsely claim to describe current operation.

- [ ] **Step 2: Run final verification from a clean dependency install**

  Copy tracked/project files to a temporary directory, run `npm ci`, then run the complete check/test/build/package suite there. This proves the result does not depend on the current checkout's existing `node_modules`.

- [ ] **Step 3: Create the public GitHub repository with `gh`**

  Run `gh repo create joisun/tasks-recorder --public --description "Local task control plane and real-time dashboard for coding agents"`, then add `origin` if `gh` did not do so. Do not push an unborn branch.

- [ ] **Step 4: Inspect final changes and external state**

  Run `git status --short`, `git diff --check`, `gh repo view joisun/tasks-recorder`, and report that Actions/Release begin only after the user authorizes a commit, push, and version tag.

- [ ] **Step 5: Prepare but do not yet create the permissive-Timeline branch**

  Record the agreed follow-up in the handoff: after this release work is committed, create a new branch to replace DHTMLX with a permissively licensed Timeline/Gantt component and compare the UI. A branch cannot be created safely before the repository has its initial commit.
