# phase-5-validation-rollout 执行日志

## 2026-08-25

- Task 12 隔离 cross-process E2E 已覆盖 create→review、SSE、Recorder Hook correlation、scheduled/manual no-overlap、taskd restart replay、runner crash→lost、active mutation immutability 与 TERM-ignoring process-tree timeout。
- completion receipt replay 曾真实暴露 P0 gap；production runtime 修复后原样 case 收敛，raw final message 未进入 spool。
- 当前核心 runtime 回归 32/32，新增 correlation/crash 定向 2/2。
- Task 13 已完成 file-native redesign、README/文档同步、full suite 505/505、syntax/build/adapter/package gate 与 archive sensitive-name audit。
- VDR 已覆盖 1440×900 与 390×844；发现并修复 mobile touch target、Settings hidden-tab trap 与 invalid-field label clipping，focused regression 通过。
- final full-suite verification 暴露并移除了 offline replay E2E 的 bind→markRunning 测试竞态；显式 Codex gate case 连续 5/5、随后全量 505/505 通过。
- 真实 launchd/Codex 与 sleep/wake 尚无直接 evidence；Task 13 保持进行中，不声明最终 release readiness。
