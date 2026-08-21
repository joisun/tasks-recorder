# task-03-compatibility-cutover

## 目标

提供 legacy API/MCP compatibility projection，明确标注 deprecated/lossy；在新旧 contract 回归全部通过后，把 default taskd runtime 原子切换到 v3。

## Contract

- legacy execution `task_id` 只投影当前或最近 accepted Attribution，并返回 `deprecated`、replacement 与 lossy warning。
- legacy `active` input 只在 boundary normalization 接受，canonical storage 保持 `in_progress`。
- compatibility wrapper 不恢复 `context + list + full sync_tree` heartbeat。
- runtime cutover 同时接通 v3 store/service/API/startup diagnostics；不得产生“schema 已升级但服务入口仍只懂 v2”的中间态。

## 验收

- compatibility shape、warning、v2 client fixtures、v3 runtime integration 与 rollback gate tests 全部通过。

## 完成证据

- `test/v3-compatibility.test.mjs` 覆盖 A→B→A lossy projection、legacy context/sync、assignment/classification、Task visibility 与 v2 zero-write gate。
- packaged runtime 在 source tree 外以 schema v3 启动；release allowlist 包含全部 v3 modules 与 spool runtime。
- full suite 259/259；`npm run check` 与 `git diff --check` 通过。
