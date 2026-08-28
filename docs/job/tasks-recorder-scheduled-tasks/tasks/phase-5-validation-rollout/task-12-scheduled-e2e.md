# task-12-scheduled-e2e

**所属 phase**：phase-5-validation-rollout
**前置依赖**：phase-1–4。

## 目标

用 fake launchctl 与 fake Codex 跨真实 taskd/runner 边界证明全链路、并发、重启、timeout 与 mutation race。

## 涉及范围

- 新建：`test/scheduled-runtime-e2e.test.mjs`
- 只在 E2E 证明 contract gap 时修改对应 focused implementation/test/docs。

## 验收标准

- [x] create→reconcile→trigger→thread/log/review/SSE/Recorder correlation 通过。
- [x] scheduled/manual race 仅一个 Codex process，另一个 skipped_overlap。
- [x] taskd restart completion spool replay 幂等；runner crash 可收口 lost。
- [x] TERM-ignoring process tree timeout 后无 surviving child。
- [x] Edit/Pause/Delete 不改 active spec/history，future desired state 正确。
- [ ] E2E、full tests、syntax/build/diff checks 全绿。

## 备注

fixture Prompt 必须验证不出现在 argv。
