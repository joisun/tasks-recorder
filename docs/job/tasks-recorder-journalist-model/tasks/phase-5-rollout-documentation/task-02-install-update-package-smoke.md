# task-02-install-update-package-smoke

## 目标

证明 v3 service 与独立 Codex/Claude adapters 能从 release artifacts 安装、更新、启动和诊断，且不会覆盖现有数据库或依赖 source tree。

## Files / Interfaces

- `install.sh`、`server/control.mjs`、`scripts/package-release.mjs` 与对应 installer/package tests。
- `package.json`、adapter bundles、GitHub Actions/release metadata。
- isolated HOME/config、临时端口与临时 v3 database smoke harness。

## Contract

- release install 不执行 `npm install` / `npm ci`；prebuilt Dashboard 与 production dependencies 完整。
- reinstall/update 保留 config/database/logs；service readiness probe 有界且 status 可区分 ready/degraded。
- Codex 与 Claude adapters 独立安装，保持同一 Event Envelope、fail-open 与 MCP contract。
- 不写真实 LaunchAgent、真实用户 config 或真实数据库；所有 smoke 使用注入 runner、temp HOME 或 isolated taskd。

## 验收

- `npm run build:adapters`、`npm run package:release`、package allowlist/hash、installer update、isolated taskd health/SSE/Dashboard smoke 全部通过。
