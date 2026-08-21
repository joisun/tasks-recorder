# task-05-v3-domain-facade

## 目标

把 Project、Task、Work stores 组合为可独立运行的 v3 JournalStore façade。为了避免在 ingestion/API/MCP 尚未就绪时让现有 taskd 失效，本 task 不切换 default runtime；cutover 移到 phase 3 compatibility contracts 全绿之后。

## 文件

- Create: `mcp/src/v3-task-store.mjs`
- Create: `mcp/src/journal-store.mjs`
- Create: `test/v3-task-store.test.mjs`
- Create: `test/journal-store.test.mjs`
- Modify: `test/v3-compatibility.test.mjs`

## Contract

- fresh JournalStore database 直接创建 v3。
- JournalStore 打开 v1/v2 返回 `SCHEMA_MIGRATION_REQUIRED`，不得静默改库或影响现有 v2 runtime。
- legacy `active` input 归一化为 `in_progress`。
- legacy execution `task_id` 是 current/recent accepted Attribution 的 lossy projection，并返回 warning。

## TDD steps

- [x] 写 fresh JournalStore 与 old DB migration-required failing tests。
- [x] 实现独立 JournalStore initializer/composition，验证 focused tests。
- [x] 写 v3 Task hierarchy/lifecycle/revision failing tests并改造 task store。
- [x] 写 canonical snapshot 与 active alias normalization failing tests并实现。
- [x] 跑 phase 1 focused suite，再跑 `npm test`，确认 v2 runtime 仍绿。

## 验收

- JournalStore 内 schema version 3 是 canonical；v2 runtime 未被提前切断。
- 当前外部 API tests 继续通过，v3 façade tests 独立通过。
- v3 canonical execution rows没有 direct task binding。
- phase 1 全部 tests 通过后进入 ingestion；default runtime cutover 由 phase 3 执行。
