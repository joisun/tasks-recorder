# task-10-schedule-editor

**所属 phase**：phase-4-scheduled-dashboard
**前置依赖**：task-09 shell 与 phase-3 mutation API。

## 目标

实现 production-grade Schedule Editor 和 create/edit/pause/resume/run-now/delete/retry-sync interactions。

## 涉及范围

- 新建：`ui/src/scheduled-task-editor.mjs`
- 修改：`ui/src/scheduled-tasks.mjs`、`ui/src/dashboard-api.mjs`、`ui/src/dashboard.css`
- 新建：`test/scheduled-task-editor.test.mjs`

## 验收标准

- [ ] fields/cadence/system timezone/next preview/sandbox/model/reasoning/timeout 完整。
- [ ] default read-only；workspace-write warning；danger-full-access explicit confirmation。
- [ ] create/edit/revision conflict/save/sync error/retry states 保留 draft 和 authoritative Job。
- [ ] focus trap/Escape/backdrop/focus restore/reduced-motion/keyboard 可用。
- [ ] Run now 无 override，delete 为 soft delete。
- [ ] focused tests 与 build 通过。

## 备注

Browser 不复制 server next occurrence 逻辑。
