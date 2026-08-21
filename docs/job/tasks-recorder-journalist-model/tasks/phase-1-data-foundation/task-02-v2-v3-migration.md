# task-02-v2-v3-migration

## 目标

实现不猜测合并的 v2 → v3 migration engine，并证明 dry-run 零写入、apply 前备份、失败回滚和数据守恒。

## 文件

- Create: `mcp/src/schema-migration.mjs`
- Create: `test/schema-v3-migration.test.mjs`
- Modify: `mcp/src/task-schema.mjs`（仅暴露 migration-required gate；cutover 留到 task 05）

## Contract

```js
inspectV2Migration(db) -> report
backupDatabase({ databasePath, backupPath }) -> metadata
applyV2ToV3({ databasePath, backupPath, clock }) -> report
```

`report` 必须包含 legacy/migrated counts、provisional Projects、ambiguous rows、invariant result 与 backup metadata；dry-run 不改变 `user_version` 或任何 row。

## TDD steps

- [ ] 写 v2 fixture inventory failing tests，覆盖同名 project、精确 location、无 location、bound/unassigned executions。
- [ ] 验证 RED：`node --test test/schema-v3-migration.test.mjs`。
- [ ] 实现 deterministic inventory 与 report，不做写入。
- [ ] 写 backup/apply/rollback failing tests并验证 RED。
- [ ] 实现单事务 migration；`active` 映射 `in_progress`，legacy bound execution 生成一个 Segment + migration Attribution。
- [ ] 运行 focused tests与 `PRAGMA` invariants。

## 验收

- ambiguous data 只进入 provisional/Inbox。
- backup 可独立打开且保持 schema v2。
- 故障注入后原 DB 保持 v2、row count 不变。
- installer 无任何 migration side effect。
