# task-05-runner-protocol-spool

**所属 phase**：phase-2-native-runner
**前置依赖**：phase-1 service internal methods。

## 目标

建立 taskd 与 runner 的 0600 Unix socket control channel，以及 taskd 暂不可达时的 bounded privacy-safe evidence spool。

## 涉及范围

- 新建：`server/src/scheduler/runner-protocol.mjs`
- 新建：`server/src/scheduler/runner-spool.mjs`
- 新建：`test/scheduler-runner-protocol.test.mjs`
- 新建：`test/scheduler-runner-spool.test.mjs`

## 验收标准

- [ ] socket parent 0700/socket 0600，bounded JSON requests、stable typed errors、owned cleanup。
- [ ] claim/overlap/heartbeat/complete 精确映射 service；spec/nonce 只在 claim response。
- [ ] spool 0600 atomic、hard bytes/files/age caps、idempotent replay、permanent quarantine、stale claims。
- [ ] spool 不包含 Prompt/Workspace/spec/raw logs/nonce。
- [ ] dispatch failure/overlap/completion replay 可幂等收口。

## 备注

Public Dashboard 不访问此 socket。
