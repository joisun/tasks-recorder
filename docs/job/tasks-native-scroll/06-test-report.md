# 验证结果

## 环境

2026-09-08；独立 headless Chrome，通过现有 Playwright MCP 与 CDP。viewport 1280×720，Tasks 当前过滤下 76 条挂载行，标题节点 76 个。基线 source preview 43131，新 worktree preview 43132，共用 43129 upstream。仅浏览器 UI 与只读数据请求，未修改业务记录、启动恢复会话或提交 Git。

## 同手势性能

CDP Input.synthesizeScrollGesture：纵向 -1400 / +1400 px，700px/s，mouse，preventFling；轻量 DevTools timeline tracing，不启用 CPU sampling。探针统计 rAF、longtask、DOM mutation，Performance metrics 为起止差值。

| 指标 | 原实现两轮 | 原生实现第一轮 | 原生实现复测 |
| --- | --- | --- | --- |
| ScriptDuration | 3.255–4.206s | 37.4ms | 34.3ms |
| RecalcStyleDuration | 635–1102ms | 0ms | 0ms |
| LayoutDuration | 11–25ms | 0ms | 0ms |
| rAF p95 | 333–767ms | 16.8ms | 16.8ms |
| Long tasks | 20–30 | 1（73ms） | 0 |
| retained title nodes | 76 | 76 | 76 |

新两轮 task subtree 的 MutationObserver 均无 mutation。复测包含 237 次实际 scroll events，最大帧间隔 33.4ms；第一轮存在一次长任务，不以单次零长任务承诺所有环境恒定 60fps。ScriptDuration 在相同手势下约降低 99%；这不是整站性能或所有设备 FPS 的结论。

## 布局与交互证据

- 纵向 scrollTop=1000，同时 Timeline scrollLeft=60、Grid scrollLeft=94；全部 76 行左右 top / height 差值均为 0px。
- 所有任务、计划 baseline 与执行 segment 共用同一个时间坐标函数。
- 短条的标签开关保留；任务标题左对齐。native-final.png 与 native-scrolled.png 已实际查看。
- 焦点进入被裁剪的 Session ID 时全局任务列滚动到 90px，77 个 pane 自身 scrollLeft 全为 0；焦点目标 right=863，小于 pane right=867，没有单行错位。
- 分栏键盘调整 854→844→854，列宽不随分栏改变。
- 真实浏览器状态菜单：打开后 focus role=option 且 aria-selected=true；Escape 关闭并归还 trigger。清除旧 focus 延迟时发现 hidden menu 无法聚焦，已改为完成定位显示后再聚焦并复测通过。

## 自动化与审查

- `npm run test:ui -- ui/react/features/tasks`：5 files / 36 tests 通过。
- `npm run check:types`：通过。
- `node --test test/react-dashboard-build.test.mjs`：3 tests 通过；默认 React 与 Legacy 编译均可用，未覆盖用户已修改的 ui/dist/react.html。
- `git diff --check`：通过。
- 审查发现的短条标签、分栏最小值、500 tick 尾部缺失及 root ArrowLeft 跳行均已补充回归测试并修复。后续 8997h 自适应 step 边界补测也已通过；刻度生成先检查实际日历边界覆盖，并在上限处确保完整收尾，不再只依赖估算。
- 最终只读复核通过，无剩余必须修项；8997h / 263997h 两个反例分别生成 376 / 495 ticks，尾部缺口均为 0。
- 已扫描 Markdown 文档树；更新 README.md 和 docs/architecture.md 的当前 renderer 约定。保留明确历史 specs/job logs，Legacy 仍使用 SVAR，third-party notices 保持适用。

## Johari 收尾

Open：真实手势的性能差异、DOM identity、同行坐标、菜单键盘和类型/构建均有证据。Hidden：用户具体滚轮/触控板与最大历史数据量仍未知。Blind：完整行 DOM 仍有大数据规模上限，不能将 76 行测试外推到上万行。Unknown：目标机器长期运行、所有过滤状态的极限数据分布；需在实际使用中继续测量，未来必要时采用共享行窗口的 virtualization。

工作成果保留在 `.worktree/refactor-tasks-scroll-renderer`，按用户授权分批提交，未合并到 main、未 push；preview 为 http://127.0.0.1:43132/?view=tasks。node_modules 是仅用于本地验证的共享依赖 symlink，不属于源码交付。
