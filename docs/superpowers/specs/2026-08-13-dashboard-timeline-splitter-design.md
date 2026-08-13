# Tasks Recorder Dashboard Timeline Splitter Design

> 日期：2026-08-13（Asia/Shanghai）
> 状态：已实现并验证
> 适用项目：`/Users/joi-com/Desktop/space/projects/tasks-recorder`

## 目标

让展开状态下的 Grid 与 Timeline 支持拖拽调整宽度，解决 Timeline 默认过窄的问题，同时保持现有 Timeline 展开/折叠、独立横向滚动和纵向对齐行为。

用户已确认：

- 采用 DHTMLX Gantt Standard 9.1 compatible 的自定义 separator，不升级 PRO。
- 默认布局由当前约 `76/24` 调整为约 `65/35`，优先给 Timeline 更多空间。
- 用户拖拽后的 Grid 宽度写入浏览器 `localStorage`，刷新后继续使用。

## 第一原则

- **Goal**：用户可以直接分配 Grid 与 Timeline 的可见空间，并且刷新或折叠后不会丢失自己的选择。
- **Facts**：当前 Dashboard 使用 custom layout；Grid 和 Timeline 已有独立横向 scrollbar；DHTMLX Standard 9.1 的内建 layout resizer 与 `grid_resize` 属于 PRO-only；custom HTML layout view、`gantt.config.layout`、`gantt.resetLayout()` 和 `gantt.scrollLayoutCell()` 可用。
- **Assumptions**：用户需要的是面板比例调整，不是 Timeline task bar 的日期 resize；绝对像素宽度比保存比例更符合“恢复我上次设置”的直觉。
- **Constraints**：不修改 DHTMLX 源码；不使用 `{ resizer: true }`；不开放 task bar drag；不让 Grid 或 Timeline 在常规桌面宽度下被完全挤没。
- **Success Criteria**：鼠标、触控笔和键盘均可调整；松手后布局稳定重排；刷新、折叠/展开与窗口 resize 后宽度行为可预测；现有 tree/scroll/filter state 不丢失。

## 方案比较

### A. 自定义 layout separator，松手后重排（采用）

在 custom layout 的 Grid 与 Timeline 之间插入一个 custom HTML cell。pointer move 期间只移动视觉 guide，pointer up 时计算最终宽度并通过 `gantt.config.layout + gantt.resetLayout()` 重排一次。

优点：兼容 Standard；拖动跟手；避免每帧重建 Gantt；使用公开 layout contract。缺点：内容不会在拖动的每一帧同步伸缩，而是在松手后更新。

### B. 自定义 separator，每帧重排

pointer move 的每个 animation frame 都执行 layout reset。

优点：内容实时伸缩。缺点：`resetLayout()` 会重建 layout，任务较多时容易卡顿、闪烁，并增加 scroll/tree state 恢复压力。

### C. DHTMLX PRO 原生 resizer

将 `{ resizer: true }` 放入 layout，使用官方拖拽实现。

优点：原生交互和事件。缺点：需要改变授权与分发模型，不符合当前 Standard/GPL 技术约束。

## Layout 结构

展开状态使用以下逻辑结构：

```text
Grid + gridScroll | custom separator | Timeline + timelineScroll | sharedScroll
```

separator 是固定窄宽的 custom HTML layout cell，不是 DHTMLX PRO resizer：

```js
{
  html: '<div class="timeline-splitter" role="separator" ...></div>',
  css: 'timeline-splitter-cell',
  width: 9,
}
```

折叠状态不渲染 separator 和 Timeline，Grid 继续占满可用宽度。

## 宽度模型

应用维护两个不同含义的宽度：

- `preferredGridWidth`：用户希望使用的绝对像素宽度；写入 `dashboard-grid-width`。
- `effectiveGridWidth`：根据当前容器计算并 clamp 后实际传给 layout 的宽度。

没有保存偏好时，`preferredGridWidth` 取容器宽度约 `65%`。实际宽度遵循：

- Grid 正常最小宽度 `240px`。
- 桌面环境尽量为 Timeline 保留至少 `320px`。
- separator 自身宽度计入可用空间。
- 当 viewport 太窄、无法同时满足两侧最小值时，Grid 保持 `240px`，Timeline 使用剩余空间；两个面板各自通过已有内部横向 scrollbar 访问完整内容。
- resize 只改变 `effectiveGridWidth`，不覆盖 `preferredGridWidth`；窗口重新变宽后恢复用户目标值。

当前基于 DHTMLX `getLayoutView('grid').$view` 测量 Grid 宽度的 responsive 路径将被应用自有的 `effectiveGridWidth` state 取代。拖拽功能不新增 DHTMLX 私有 DOM/API 依赖。

## 交互

### Pointer

1. 主按钮在 separator 上按下后记录 `startX` 与 `effectiveGridWidth`。
2. pointer move 使用 `requestAnimationFrame` 更新视觉 guide，并把候选宽度 clamp 到当前边界。
3. pointer up/cancel 清理 guide 和全局 resizing 状态。
4. pointer up 在宽度确实改变时只执行一次 layout reset，并保存 `preferredGridWidth`。

separator 使用 `touch-action: none`，避免拖拽被页面手势接管。拖动期间使用 `col-resize` cursor，并禁止意外文本选择。

### Keyboard 与 accessibility

- separator 使用 `role="separator"`、`aria-orientation="vertical"` 和可聚焦 `tabindex="0"`。
- `ArrowLeft` / `ArrowRight` 每次调整 `16px`，立即应用并保存。
- `Home` 移到允许的最小 Grid 宽度；`End` 移到允许的最大 Grid 宽度。
- 每次 layout render 后同步 `aria-valuemin`、`aria-valuemax` 和 `aria-valuenow`。
- Timeline 折叠时 separator 不存在，不产生不可见 focus target。

## Layout 重排与状态恢复

宽度应用复用现有 layout state capture/restore 流程：

1. 捕获 task tree open IDs、Grid/Timeline 横向 scroll、共享纵向 scroll、任务列宽。
2. 更新 `effectiveGridWidth` 和 layout config。
3. 执行一次 `gantt.resetLayout()`。
4. 重新渲染 toolbar，并在 DHTMLX resize delay 后恢复 scroll state。

Timeline 折叠不会删除 `preferredGridWidth`；重新展开时按当前容器 clamp 后恢复。Locate、Timeline label toggle、status menu 和 snapshot/SSE refresh 行为保持不变。

## Preference 与异常处理

- key：`dashboard-grid-width`。
- 只接受有限正数；缺失、非法、`NaN`、负数或异常大的值视为无偏好，回退到默认值。
- `localStorage` 被浏览器策略拒绝时，拖拽仍在当前页面有效，只是不跨刷新保存。
- 不把 UI preference 写入 SQLite，也不通过 taskd 同步；该值属于每个浏览器的显示偏好。

## 测试与验收

### Unit tests

- 默认 `65/35` 的宽度计算。
- preferred width 在 desktop、tablet、mobile 宽度下的 clamp。
- viewport 缩小后保留 preferred width，重新放大后恢复。
- 数字 preference 的安全读写与 storage exception fallback。
- expanded layout 包含 custom HTML separator，但不包含 `resizer: true`；collapsed layout 两者都不包含。
- keyboard step 与 min/max boundary。

### Browser verification

- 1440px：Timeline 初始宽于当前版本，拖动 guide 跟手，松手后内容重排。
- 刷新：恢复上次拖拽宽度。
- 折叠/展开：恢复相同目标宽度，tree 与 scroll state 不丢失。
- 768px 与 375px：separator 可用或可聚焦，布局无页面级横向 overflow。
- pointer 与 keyboard 操作后，Grid/Timeline 行和共享纵向滚动仍对齐。

### Project checks

```bash
npm run build
npm test
npm run check
```

## 不做

- DHTMLX PRO resizer、`grid_resize` 或 column `resize: true`。
- task bar 的移动、duration resize 或日期编辑。
- 拖动过程中每帧 `resetLayout()`。
- 跨设备或跨浏览器同步布局偏好。
- 与 separator 无关的 Grid 列宽模型重构。

## Johari 自审

- **Open Area**：用户明确要求 Timeline 更宽并支持拖拽；已确认采用 Standard-compatible 自定义 separator、默认 `65/35` 和持久化宽度。
- **Hidden Area**：用户未要求跨设备同步；设计将其限定为当前浏览器偏好，避免引入后端状态。
- **Blind Spot**：绝对像素偏好在窗口缩小时可能挤压 Timeline；通过 preferred/effective 双层模型避免永久覆盖用户选择。
- **Unknown Area**：DHTMLX custom HTML cell 在当前 bundle 中重建后的 focus 与 pointer capture 细节不能仅靠 unit test 证明，实施后必须用真实浏览器验证。

## 依据

- [DHTMLX Gantt Layout](https://docs.dhtmlx.com/gantt/guides/layout-config/)
- [DHTMLX `grid_resize`](https://docs.dhtmlx.com/gantt/api__gantt_grid_resize_config.html)
- [DHTMLX `resetLayout`](https://docs.dhtmlx.com/gantt/api/method/resetlayout/)
- [DHTMLX `scrollLayoutCell`](https://docs.dhtmlx.com/gantt/api/method/scrolllayoutcell/)

## 实施结果

- expanded custom layout 使用 `9px` custom HTML separator，不含 DHTMLX PRO `resizer: true`。
- 默认 Desktop Grid/Timeline 实测为 `936/493px`；pointer drag、keyboard、reload、折叠/展开与 viewport clamp 均通过。
- `dashboard-grid-width` 只保存 preferred width；Tablet/Mobile clamp 不覆盖它，恢复桌面宽度后可继续使用原偏好。
- controller 不再读取 DHTMLX layout view 的 `$view` 私有字段。
- `npm run build`、`npm test`（61/61）、`npm run check` 与 `git diff --check` 通过。
- 真实浏览器报告：`.vdut-log/20260813-timeline-splitter/report.md`；8 个 planned checks PASS，9 个 material states `VISUAL_CLEAR`，无 finding/skip。
