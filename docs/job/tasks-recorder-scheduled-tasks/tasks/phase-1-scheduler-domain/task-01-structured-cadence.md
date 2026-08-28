# task-01-structured-cadence

**所属 phase**：phase-1-scheduler-domain
**前置依赖**：无。

## 目标

建立唯一的结构化 Schedule 时间语义，使 UI summary、server next occurrence 与 launchd calendars 不会使用三套不同解析规则。

## 涉及范围

- 新建：`server/src/scheduler/cadence.mjs`
- 新建：`test/scheduler-cadence.test.mjs`
- 不涉及：SQLite、launchctl、API、UI。

## 验收标准

- [ ] 精确支持 `once/hourly/daily/weekly/monthly`，拒绝 unknown keys、非法范围、过去或超过 366 天的 once。
- [ ] weekly ISO weekdays 去重排序并正确映射 launchd Sunday。
- [ ] monthly 缺失日期跳过，不移动到月末。
- [ ] next occurrence、human summary 与 launchd calendars 使用 system timezone 语义。
- [ ] Asia/Shanghai 与 America/New_York subprocess-TZ/DST tests 通过。
- [ ] `node --test test/scheduler-cadence.test.mjs`、`node --check`、`git diff --check` 通过。

## 备注

详细 TDD 步骤和公开接口见 implementation plan Task 1。不得引入 cron/RRULE dependency。
