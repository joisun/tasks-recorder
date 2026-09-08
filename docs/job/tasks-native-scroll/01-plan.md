# 实施计划

原生 overflow 容器承载完整行；每行左侧 sticky 任务列和右侧 Timeline 共享 30px 高度。滚动不写 React state。保留 projection 和稳定 cell Context。时间坐标和刻度使用有界纯函数，防止小时尺度跨年创建无界 DOM。数据变化才更新投影；无需快照时间的 metadata 更新保持引用稳定。实现仅位于独立 worktree，无自动提交。

1. 时间坐标与刻度：独立纯函数、日历边界及大跨度测试。
2. 原生渲染器：先添加失败的真实 DOM 滚动/交互测试，替换 SVAR，保留用户操作。
3. 验证：focused tests、types、构建、headless CDP 同手势对照、同行坐标检查、文档同步和代码审查。

