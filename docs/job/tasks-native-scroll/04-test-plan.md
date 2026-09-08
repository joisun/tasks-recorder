# 验证计划

纯函数日期边界、异常范围、大跨度上限；真实 DOM 测试 scroll 零 commit、节点身份、展开、详情、pending、列宽、键盘；保留 projection 和 TasksView 测试。运行 TypeScript 与 React build。浏览器固定 1280×720、同数据和 1400px 往返手势，用 CDP 记录 ScriptDuration、长任务、rAF p95。检查 Tree 与 Timeline 行坐标及原生滚动实际移动。

