# task-07-runtime-api-resume

**所属 phase**：phase-3-service-integration
**前置依赖**：phase-1、phase-2。

## 目标

把 Scheduler 作为 Recorder 的 degradable sibling plane 组合进 taskd，并提供 typed public API、SSE 与可信 Scheduled Run Resume。

## 涉及范围

- 修改：`mcp/src/config.mjs`
- 修改：`server/src/taskd-runtime.mjs`、`server/src/api-server.mjs`
- 修改：`server/src/session-resume-service.mjs`、`server/src/journal-diagnostics.mjs`
- 修改：`ui/src/dashboard-api.mjs`
- 新建/修改相关 focused tests。

## 验收标准

- [x] scheduler paths/caps/Codex path 全部 validated under data directory 或 explicit absolute executable。
- [x] startup replay→stale recovery→reconcile；shutdown reverse-order；Scheduler failure 不拖垮 Journal ready。
- [x] Spec 全部 Schedule/Run routes、revision/errors/log tail/security/SSE contract 通过。
- [x] Resume route 只接收 Run ID，使用 canonical thread/workspace/title 并验证 transcript。
- [x] diagnostics 不泄漏 Prompt/Workspace/log path/nonce。

## 备注

`api-server.mjs` 只做 transport mapping，不吸收 domain logic。
