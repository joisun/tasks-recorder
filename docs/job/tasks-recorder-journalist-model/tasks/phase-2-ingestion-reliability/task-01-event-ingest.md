# task-01-event-ingest

## 目标

建立独立 v3 Event Envelope 与 ingest service/API：adapter 只能提交经过 allowlist 的机械事实；同一 source event 可安全 replay；Project 无法用强证据解析时进入 Project Inbox，而不是用 branch 猜测。

## 文件

- Create: `mcp/src/event-envelope.mjs`
- Create: `mcp/src/journal-service.mjs`
- Modify: `mcp/src/work-store.mjs`
- Modify: `server/src/api-server.mjs`
- Create: `test/event-envelope.test.mjs`
- Create: `test/event-ingest.test.mjs`

## Contract

- Event Envelope top-level fields与各 event type payload 都是严格 allowlist；未知字段、prompt、reasoning、raw tool input/output、token/secret material 一律在写库前拒绝。
- `source + external_event_id` 是 Observation 幂等键；identity 变化返回 conflict，纯 replay 不重复改变 Execution/Segment。
- Project 仅接受 explicit id、git common dir 或已登记 workspace 的 exact resolution；remote 只产生 suggestion，branch 不参与 resolver。
- `execution.started` 创建 Execution 与首个 Segment；heartbeat 只刷新 fact activity；`execution.ended` 只关闭 fact，不修改 Task lifecycle。
- v3 ingest 作为独立 service 接入，不提前替换默认 v2 runtime。

## TDD steps

- [x] 写 Event Envelope allowlist/privacy/normalization failing tests。
- [x] 实现 envelope parser，focused tests 变绿。
- [x] 写 start/replay/heartbeat/end 与 unresolved Inbox failing tests。
- [x] 实现 JournalService 与 WorkStore heartbeat。
- [x] 接入 `POST /api/v1/events`（与现有 SSE `GET` 按 method 共存），验证 Host/Origin、错误映射与 revision publish。
- [x] 跑 focused suite 与 full regression。

## 验收

- malformed、oversized 或隐私越界事件在任何持久化之前被拒绝。
- replay 后 observations/executions/segments 数量不增长。
- branch-only evidence 仍然 unresolved；强证据可以稳定绑定 Project。
- v2 API tests 不受影响。
