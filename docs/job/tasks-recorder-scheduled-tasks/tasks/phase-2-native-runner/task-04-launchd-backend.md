# task-04-launchd-backend

**所属 phase**：phase-2-native-runner
**前置依赖**：phase-1 Job/cadence contract。

## 目标

实现 owned macOS launchd units 与 generation-safe reconciliation，确保 OS 只持有 Schedule ID 和 stable runner path。

## 涉及范围

- 新建：`server/src/scheduler/launchd-backend.mjs`
- 新建：`test/launchd-scheduler-backend.test.mjs`
- 必要时修改：`server/control.mjs` 的纯 helper export。

## 验收标准

- [ ] plist 使用 absolute Node/runner、safe ID、StartCalendarInterval、Background，无 Prompt/Workspace/spec/shell。
- [ ] 0600 atomic write；bootout/bootstrap/kickstart typed handling。
- [ ] cleanup 同时验证 label prefix 与 ProgramArguments ownership。
- [ ] unsupported platform 返回 capability，不假实现其他 backend。
- [ ] focused backend 与现有 control regression 通过。

## 备注

Run now 必须 kickstart owned unit，不能直接 spawn Codex。
