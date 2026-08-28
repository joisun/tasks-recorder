# task-09-view-switch-inbox

**所属 phase**：phase-4-scheduled-dashboard
**前置依赖**：phase-3 read API。

## 目标

在 nav 最左侧增加可访问的 Tasks/Scheduled switch，并交付 Scheduled loading/empty/error/filter/list shell，不破坏 Gantt state。

## 涉及范围

- 修改：`ui/src/index.html`、`ui/src/dashboard.mjs`、`ui/src/dashboard.css`、`ui/src/dashboard-api.mjs`
- 新建：`ui/src/scheduled-tasks.mjs`
- 新建/修改：Scheduled UI 与 Dashboard build tests。

## 验收标准

- [ ] leftmost visible labels、ARIA tabs、keyboard roving；Settings 始终保留。
- [ ] Scheduled 隐藏 status/inbox/timeline tools；切回 Tasks 保留 filter/zoom/tree/scroll。
- [ ] list 支持 loading/empty/unsupported/error/sync-error/search/All/Active/Paused/unread。
- [ ] escaped data、semantic sort、relative activity、SSE authoritative refresh。
- [ ] focused UI tests 和 `npm run build` 通过。

## 备注

Scheduled panel 不 mount 第二个 SVAR/Gantt。
