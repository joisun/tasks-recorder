# task-01-migration-cli-and-rehearsal

## 目标

把已验证的 v2→v3 migration engine 暴露为安全、可审计的 CLI；在隔离数据库副本上证明 dry-run 零写入、apply 前强制 verified backup、失败回滚和 backup 可恢复。

## Files / Interfaces

- `server/cli.mjs`：新增 `migrate --dry-run` 与显式 apply contract；保持 JSON stdout / diagnostic stderr。
- `mcp/src/schema-migration.mjs`：补充 path-level inventory façade，不放宽现有 transaction/invariant contract。
- `test/cli.test.mjs`、`test/schema-v3-migration.test.mjs`：parser、dry-run、apply、backup、restore 与错误边界。
- `README.md`：只在 CLI 与 rehearsal 通过后公开命令。

## Contract

- dry-run 必须 read-only，不创建 backup，不修改 `user_version` 或业务 rows。
- apply 必须要求显式 `--backup <path>`；backup 已存在、与 source 相同、service 仍在运行或 schema 非 v2 时 fail closed。
- 输出不包含 Task 原文、Session ID、路径外隐私或凭据；报告只含 counts、ambiguity/invariant summary 与 backup metadata。
- 本 Task 禁止操作真实 `~/.config/tasks-recorder/tasks.sqlite`；只使用 `.tmp/` 或系统临时目录中的 fixture/copy。

## 验收

- focused parser/migration tests、真实临时副本 dry-run/apply/restore rehearsal、full suite、syntax check 全部通过。
- rehearsal 产出可定位报告，但不保留包含用户数据的临时副本。
