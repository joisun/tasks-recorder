# task-04-realtime-accessibility-vdr

## 目标

把 Dashboard 打磨为紧凑、克制、可掌控项目周期的本机产品界面，并完成真实浏览器视觉 gate。

## Contract

- 视觉方向：Linear 式信息优先；density 8、motion 2、单一 accent；所有 toolbar/control 保持明确 group padding 与 focus state。
- row、toolbar、Sheet 在高密度下仍满足文本截断、tooltip、keyboard 与 screen-reader contract。
- SSE 只触发 revisioned compact refresh，不重置用户 viewport；断线/恢复状态可感知但不抢占注意力。
- 使用 `playwright-headless` 和 visual-driven-review 的双 reviewer isolation gate；浏览器 review 期间不修改产品代码。

## 验收

- unit/integration/build 全部通过；desktop/mobile 指定 viewport 的功能、响应式、adversarial、accessibility 与视觉证据完成聚合。

## 当前证据

- Automated gate：`npm test` 272/272、`npm run check` 85 files、`npm run build`、`npm run build:adapters` 与 `git diff --check` 通过。
- Browser precheck：`VISUAL_SKIP`。`playwright-headless` 与 `playwright-extension` 已写入本机 Codex 配置，但当前 runtime 没有暴露任何 Playwright MCP browser tool；按 visual-driven-review contract 在 precheck 停止，未安装本地 Playwright，也未用其他截图方式替代。
- 待完成：恢复当前会话的 Playwright MCP tool exposure 后，先运行双 reviewer isolation gate，再按明确 viewport scope 完成 desktop/mobile、responsive、adversarial 与 accessibility review。视觉 gate 完成前，本 Task 不标记 done。
