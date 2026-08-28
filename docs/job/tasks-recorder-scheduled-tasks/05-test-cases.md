# 测试用例矩阵

> **Historical / superseded (2026-08-27)**：本矩阵保留早期测试证据，但其中的 dispatch / runner cases 不代表当前执行链路。现行架构见 [`README.md`](../../../README.md) 与 [`Runtime Agent Registry 设计`](../../superpowers/specs/2026-08-27-runtime-agent-registry-design.md)。

| 编号 | 回归点 | 操作 / 证据 | 预期结果 | 优先级 | 当前状态 |
| --- | --- | --- | --- | --- | --- |
| TC-01 | S01 | cadence suites 在 default TZ 与 UTC 下覆盖 once/hourly/daily/weekly/monthly、DST/366-day limit | next occurrence、summary、launchd calendars 一致；browser 不重算 | P0 | 通过 |
| TC-02 | S02 | Markdown codec/repository/monitor + scheduler schema/store tests | marker/strict YAML/etag CAS/atomic trash、无 current definition table、manual dispatch、one-active-Run、immutable spec、Review invariants 全绿 | P0 | 通过 |
| TC-03 | S02/S07 | migration + scheduler service tests | v1→v2 conflict/rollback/idempotency；create/edit/pause/resume/delete/run-now/review/reconcile 使用 authoritative file state | P0 | 通过 |
| TC-04 | S03/S13 | launchd backend ownership/generation tests | foreign/symlink/unsafe artifact 不触碰；newest generation 最终生效 | P0 | 通过 |
| TC-05 | S04/S13 | protocol/spool/privacy tests | socket 0600；Prompt/nonce/path 不泄漏；caps 与 replacement proof fail closed | P0 | 通过 |
| TC-06 | S05 | fake Codex supervisor/runner tests | stdin JSONL、no-overlap、heartbeat、TERM→KILL process group 与 bounded logs 正确 | P0 | 通过 |
| TC-07 | S06 | taskd restart during completed runner E2E | DB completion、receipt/evidence/spool 最终清空且 Run 只完成一次 | P0 | 通过 |
| TC-08 | S06/S13 | crash injection：pre-spool、post-ack/pre-cleanup、inode replacement、sidecar-only | 每个 crash point 可恢复或有 bounded safe degraded；不误删 replacement | P0 | 通过（focused recovery suites） |
| TC-09 | S07/S12 | Schedule/Run API、Host/Origin、typed errors、SSE tests | list privacy、CAS/idempotency、bounded log、explicit Review、Resume only Run ID | P0 | 通过 |
| TC-10 | S09/S11 | CLI/install/control/package focused gates | typed status/reconcile；Codex absolute path；owned uninstall；archive 外运行 runner | P0 | 通过 |
| TC-11 | S10/S14 | Scheduled list + Editor tests/browser smoke | active/unread/last result、invalid file errors、five cadence fields、Settings definitions root、desktop/mobile 无 overflow | P1 | 通过 |
| TC-12 | S10/S14 | Run Review tests/browser smoke | all statuses、final result、bounded logs、stale cancellation、focus、copy、Review、Resume | P0 | 通过（独立复审修复已验证） |
| TC-13 | S05–S08 | isolated create→reconcile→trigger→review cross-layer E2E | fake OS/Codex 完整链路、SSE、Hook correlation、mutation immutability | P0 | 通过 |
| TC-14 | S14 | `visual-driven-review` 多状态桌面/窄屏/keyboard/reduced-motion | Tasks/Scheduled/Editor/Review/error/unsupported/running/failure 无 Major findings | P1 | 通过；3 个 Medium finding 已修复并复验 |
| TC-15 | S03/S05/S08 | 真实 2–3 分钟 launchd/Codex read-only Schedule | OS trigger→thread→Run terminal→Hook facts→Review→Resume 全链路 | P0 | 未执行 |
| TC-16 | S01/S06 | sleep/wake catch-up | 多次错过最多补跑一次；无法实测则明确记录替代证据 | P1 | 未执行 |
| TC-17 | S11/S12/S15 | README/architecture/docs scan、privacy/path/link scan | 文档与行为一致，无 secret/user runtime artifact | P0 | 通过 |
| TC-18 | S09/S15 | full automated/build/package audit | full suite/check/UI/adapters/package/diff 全绿，archive allowlist 无运行数据 | P0 | 通过 |
| TC-19 | S07/S10 | 真实 `codex debug models` catalog/API/Editor | hidden entries 不暴露；Model 取本机 visible list；Reasoning 按所选 Model 收窄；无旧 hardcode | P0 | 通过 |
| TC-20 | S05/S07/S10/S12/S14 | fake `codex app-server` + Run SSE + steer/Stop E2E 与 PC VDR | active message/activity 有序；mouse Send 可用；steer/stop 202；terminal row/detail/Session/summary/logs/Resume 一致；`turnId`、guidance、tool payload 不持久化 | P0 | 通过；首轮 2 个 High finding 已修复并以 rerun-2 复验 |

## 状态定义

- `通过`：已有 fresh、可定位证据。
- `进行中`：实现或验证尚未完成，不计入 release gate。
- `失败`：已复现 contract violation；P0 失败阻止 release readiness。
- `未执行`：尚无直接 evidence，不能用设计或单元测试推断为通过。
