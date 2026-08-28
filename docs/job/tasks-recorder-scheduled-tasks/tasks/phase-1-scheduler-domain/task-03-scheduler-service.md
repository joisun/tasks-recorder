# task-03-scheduler-service

**所属 phase**：phase-1-scheduler-domain
**前置依赖**：task-01 cadence、task-02 store。

## 目标

实现 Schedule/Run domain service，让 persisted desired state、backend reconcile 与 Run coordination 的边界稳定可测。

## 涉及范围

- 新建：`server/src/scheduler/scheduler-service.mjs`
- 新建：`test/scheduler-service.test.mjs`
- 不涉及：HTTP mapping、真实 launchctl、Dashboard。

## 验收标准

- [ ] typed input normalization、Workspace/preflight、read-only default、thread_mode=new。
- [ ] create/edit/pause/resume/delete 使用 revision CAS；backend failure 保留 definition 并写 sync error。
- [ ] stale reconcile result 不能覆盖更高 generation。
- [ ] Run now 只调用统一 dispatcher；Pause/Edit/Delete 不改 active immutable spec。
- [ ] claim/overlap/heartbeat/complete/review/stale recovery 均有 stable domain errors。
- [ ] phase-1 三个 focused suites 通过。

## 备注

service 返回 domain data；SSE publish 属于 taskd composition。
