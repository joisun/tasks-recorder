# task-08-cli-install-release

**所属 phase**：phase-3-service-integration
**前置依赖**：task-07 runtime contract。

## 目标

保证 source/install/release 都有稳定 runner 与 Codex executable contract，且 CLI/卸载不会绕过 taskd 或误删非 owned units。

## 涉及范围

- 修改：`server/cli.mjs`、`server/control.mjs`、`install.sh`
- 修改：`scripts/package-release.mjs`
- 修改：CLI/control/install/release/package runtime tests。

## 验收标准

- [ ] CLI `scheduler status/reconcile` 只经 typed taskd client，JSON-only stdout。
- [ ] installer bounded 探测 absolute Codex path，保留用户显式设置和 scheduler data。
- [ ] stable current runner path 在更新后生效。
- [ ] uninstall 只移除 verified owned plists，保留 scheduler DB/history/logs。
- [ ] release archive 和 installed runtime smoke 包含/执行 runner，无 source-tree dependency。

## 备注

不增加 public arbitrary dispatch/exec CLI。
