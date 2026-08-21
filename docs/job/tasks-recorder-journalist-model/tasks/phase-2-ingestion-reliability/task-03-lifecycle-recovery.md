# task-03-lifecycle-recovery

## 目标

定义 session/execution 的机械 lifecycle transition、Stop fail-open 与启动恢复，让事实状态可从事件与时间证据稳定推导。

## Contract

- lifecycle transition 是幂等状态机；乱序和迟到事件具有明确规则。
- Stop 只负责尽力提交结束事实，不负责变更 Task lifecycle；服务不可用时 adapter fail-open 并进入 spool。
- taskd 启动时关闭超过恢复阈值的 open Execution/Segment，标记 recovered/interrupted，不伪造完成任务。

## 验收

- crash、无 Stop、重复 Stop、乱序 end 与 startup recovery 测试全部通过。
