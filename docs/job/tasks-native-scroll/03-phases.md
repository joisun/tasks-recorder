# 阶段与恢复入口

工作分支 refactor/tasks-scroll-renderer，worktree `.worktree/refactor-tasks-scroll-renderer`。

当前：实现与验证完成，用户已授权分批提交，保留 worktree，不合并、不推送。T1 由独立 worker 实现，T2 由主代理实现，独立只读审查发现的标签/分栏/刻度/键盘边界已修复。仅携带主 checkout 的前次 Tasks 性能修复；不包含其他任务的服务端修改。基线 trace 位于主 checkout `.vdr-log/2026-09-08-tasks-scroll-performance/`；新 trace 位于本 worktree `.vdr-log/2026-09-08-tasks-native-scroll/`。详情见 06-test-report.md。

恢复时先阅读 02-tasks.md，再看任务日志及 06-test-report.md。
