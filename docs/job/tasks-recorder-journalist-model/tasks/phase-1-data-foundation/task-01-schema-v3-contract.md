# task-01-schema-v3-contract

## 目标

建立独立、可测试的 schema v3 builder。此 task 不修改 `initializeTaskSchema` 的 runtime cutover，因此既能验证目标 DDL，又不让现有 v2 store 在中间状态失效。

## 文件

- Create: `mcp/src/schema-v3.mjs`
- Create: `test/schema-v3.test.mjs`

## Contract

```js
import { SCHEMA_V3, createSchemaV3, checkSchemaV3Invariants } from './schema-v3.mjs'

createSchemaV3(db) // caller owns transaction; empty database only
checkSchemaV3Invariants(db) // { integrityCheck, foreignKeyViolations, invariantViolations }
```

必须创建 `projects`、`project_locations`、`source_sessions`、`observations`、`executions`、`work_segments`、`segment_attributions`、`execution_intents`、`tasks`、`task_events`、`plan_observations`，并设置 `PRAGMA user_version = 3`。

## TDD steps

- [ ] 在 `test/schema-v3.test.mjs` 写空库建表、status alias 排除、唯一 open Segment、唯一 accepted Attribution、同 Project parent 的最小 contract tests。
- [ ] 运行 `node --test test/schema-v3.test.mjs`，确认因 `ERR_MODULE_NOT_FOUND` 或 missing export 失败。
- [ ] 创建 `mcp/src/schema-v3.mjs`，只实现测试要求的 DDL 与 invariant query。
- [ ] 重跑 focused test，预期全部通过。
- [ ] 运行 `node --test test/schema-migration.test.mjs test/task-store.test.mjs`，确认 v2 runtime 未受影响。

## 验收

- 新 schema 能通过 `integrity_check` / `foreign_key_check`。
- DDL 不包含 prompt/tool IO/token/secret 字段。
- Task storage 只接受 `in_progress`，不接受 legacy `active`。
- Execution 表没有 canonical `task_id`。
- 未经用户确认不 commit。
