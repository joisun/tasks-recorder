# phase-5-rollout-documentation 执行日志

> 只追加，不重写历史记录。

| 时间 | Task | 状态 | 证据 / 备注 |
| --- | --- | --- | --- |
| 2026-08-21 | phase-5 materialization | done | 基于已确认 phase 5 contract 物化 3 个不可变 Task；真实 DB migration 与 GitHub Release 明确留在授权 checkpoint。 |
| 2026-08-21 | task-01-migration-cli-and-rehearsal | in progress | migration engine 已存在，但缺少 user-facing CLI；从 parser/dry-run 零写入 failing tests 开始。 |
| 2026-08-21 | task-01-migration-cli-and-rehearsal | done | 新增 `migrate --dry-run` / guarded `--apply --backup`、active taskd guard 与 privacy-bounded report；真实 temp v2 copy dry-run/apply/backup restore rehearsal 通过。focused 18/18、full suite 280/280、85-file syntax check、package runtime 与 `git diff --check` 通过；未创建 commit（用户未授权）。 |
| 2026-08-21 | task-02-install-update-package-smoke | in progress | migration runtime dependency 已加入 release allowlist；继续验证 release archives、installer update preservation 与 isolated service smoke。 |
| 2026-08-21 | task-02-install-update-package-smoke | done | isolated installer preservation、tamper rejection、bounded readiness、packaged v2→v3 migration、taskd health/Dashboard/SSE、Codex/Claude MCP 与 import smoke 通过。focused 12/12、full suite 280/280、85-file syntax check、UI/adapter/release builds、三份 archive SHA-256/readability 与 `git diff --check` 全部通过；未写真实 HOME/LaunchAgent/DB，未创建 commit。 |
| 2026-08-21 | task-03-docs-and-release-checkpoint | in progress | 开始生成 04/05/06 测试文档并扫描 README、architecture、migration/deprecation、version/license/repository 与 release artifact contract；真实 DB migration、commit/merge 与 GitHub Release 保持授权边界。 |
| 2026-08-21 | task-03-docs-and-release-checkpoint | done | README 与实现逐项核对，补齐 structured log/spool/diagnostics 路径和 `0.5.x` legacy compatibility window；authoritative v3 spec 改为 release-candidate 已实现，v2 design 明确为 `0.4.0` 历史记录。release metadata focused 4/4 与 diff check 通过；真实 DB、commit/merge/release/local update 均未执行。 |
| 2026-08-21 | test-plan-and-report | done | 04/05/06 已生成；17/17 用例通过、P0 全绿。证据包含 full suite 280/280、package focused 12/12、metadata 4/4、85-file syntax、build/adapters/release、VDR 12/12、9-file Markdown links 0 missing 与 artifact/privacy scan。 |
| 2026-08-21 | release-authorization-checkpoint | waiting | 未执行真实 `~/.config/tasks-recorder` migration、Git commit/merge/tag/push/GitHub Release 或本机 service/adapters 更新；等待用户授权后分阶段执行。 |
| 2026-08-21 | real-database-migration-preview | done | 用户授权后对真实 `tasks.sqlite` 运行两次 read-only `migrate --dry-run`，结果一致：schema 2→3，303 Tasks、366 Executions、295 bound、71 unassigned、26 planned Projects、20 ambiguous Projects、6 组 `PROJECT_LOCATION_COLLISION`。service 前后均 ready，未 stop、未创建 backup、未 apply、未修改数据库。 |
| 2026-08-21 | real-database-migration-apply | waiting | proposed backup 为 `~/.config/tasks-recorder/backups/tasks-v2-before-v3-20260821.sqlite`，当前路径不存在且 parent mode 0700。apply 将 stop service、checkpoint WAL、创建 0600 verified v2 backup、单事务迁移并验证 invariants；等待显式授权。 |
| 2026-08-21 | release-version-correction | in progress | read-only remote audit 发现 `v0.5.0` 已于 2026-08-18 发布，而 branch 仍声明 0.5.0；以 failing metadata/package tests 锁定 schema v3 为 0.6.0，并将 legacy compatibility window 修正为 0.6.x / earliest removal 0.7.0。先完成本地 gates，再请求 Git/Release 授权。 |
| 2026-08-21 | release-version-correction | done | package、lockfile、Codex/Claude plugin metadata、MCP server metadata、README、spec 与 release archive root 已统一为 `0.6.0`；installer/metadata/package focused 11/11、full suite 280/280、85-file syntax check 与 `git diff --check` 通过。真实 DB apply、Git/Release 与本机更新仍保持授权边界。 |
| 2026-08-21 | release-rollout | in progress | 用户授权完整 v0.6.0 发布升级；按 fresh gate、feature commit、main merge/push、GitHub Release、verified backup/migration、本机 service/adapters 更新与最终验证的可回退顺序执行。 |
