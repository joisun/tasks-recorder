# task-11-run-review

**所属 phase**：phase-4-scheduled-dashboard
**前置依赖**：task-09 list、task-10 API wiring。

## 目标

实现独立 Scheduled Review queue：Run history、final result、bounded logs、Mark reviewed、thread copy 与 Resume。

## 涉及范围

- 新建：`ui/src/scheduled-run-review.mjs`
- 修改：`ui/src/scheduled-tasks.mjs`、`ui/src/dashboard-api.mjs`、`ui/src/dashboard.css`
- 新建：`test/scheduled-run-review.test.mjs`

## 验收标准

- [x] 所有 Run status/trigger/timestamps/duration/unread 显示一致。
- [x] final message 为主内容；stdout/stderr bounded tail 分栏、truncation、stale fetch cancellation。
- [x] Mark reviewed 显式；关闭后 list count authoritative refresh。
- [x] Resume 只发 Run ID；copy 完整 thread ID；invalid transcript typed error。
- [x] focus restore、escaping、loading/error/no-result states 通过。
- [x] phase-4 focused tests 与 build 全绿。

## 备注

不得展示 absolute log path 或 raw spec JSON。
