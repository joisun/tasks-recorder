# task-04-work-journal

## 目标

实现事实平面的 append-only Observation 与 Execution/Work Segment/Attribution state machine。

## 文件

- Create: `mcp/src/work-store.mjs`
- Create: `test/work-segment.test.mjs`
- Create: `test/segment-attribution.test.mjs`

## Contract

```js
workStore.appendObservation(envelope)
workStore.startExecution(input)
workStore.focus({ execution_id, task_id, provenance, rationale_code })
workStore.endExecution(input)
workStore.correctAttribution(input)
```

## TDD steps

- [ ] 写 observation dedupe 与 execution start replay failing tests。
- [ ] 验证 RED 后实现 append/start。
- [ ] 写 A → B → A 产生三个 Segment failing test。
- [ ] 实现 focus transaction 与 accepted Attribution uniqueness。
- [ ] 写 correction audit、Stop close、stale 不等于 interrupted failing tests并实现。
- [ ] 跑 focused tests和 foreign-key/invariant checks。

## 验收

- 同一 external event replay 不重复写事实。
- 一个 execution 最多一个 open segment。
- 一个 segment 最多一个 accepted attribution。
- 用户 correction 不被 current_focus heartbeat 覆盖。
