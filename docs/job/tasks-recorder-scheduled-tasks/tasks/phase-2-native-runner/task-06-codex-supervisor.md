# task-06-codex-supervisor

**所属 phase**：phase-2-native-runner
**前置依赖**：task-04 launchd、task-05 protocol/spool。

## 目标

实现统一 Scheduled/manual Codex supervisor：OS lock、claim、stdin Prompt、JSONL、heartbeat、process-group timeout、logs、completion。

## 涉及范围

- 新建：`server/src/scheduler/codex-run-spec.mjs`
- 新建：`server/src/scheduler/codex-jsonl.mjs`
- 新建：`server/src/scheduler/process-supervisor.mjs`
- 新建：`server/src/scheduler/runner-lock.mjs`
- 新建：`server/scheduled-runner.mjs`
- 新建：`test/codex-run-spec.test.mjs`、`test/codex-jsonl.test.mjs`、`test/scheduled-runner.test.mjs`

## 验收标准

- [ ] absolute Codex、shell:false、args allowlist、Prompt 仅 stdin、无 bypass flags。
- [ ] stdout JSONL 解析 thread ID/final message；stderr 不能伪造 protocol；line/message bounded。
- [ ] lock 先于 claim；lock busy 记录 skipped_overlap；stale cleanup 需要 PID/nonce/run evidence。
- [ ] detached process group timeout 执行 TERM→grace→KILL，子进程不泄漏。
- [ ] taskd 断连时 completion 进入 spool；finally 释放 lock。
- [ ] phase-2 focused suites 全绿。

## 备注

真实 Codex 不在 unit tests 中启动。
