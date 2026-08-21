# task-03-docs-and-release-checkpoint

## 目标

让公开文档与 v3 实际 contract 一致，完成 deprecated window、测试报告和 release readiness；把真实本机 DB migration 与 GitHub Release 保留为明确授权动作。

## Files / Interfaces

- `README.md`：How it works、install/update、migrate、rollback、status/logs、troubleshooting。
- architecture/spec/job docs：fact/semantic planes、Project-first Dashboard、compatibility/deprecation。
- `04-test-plan.md`、`05-test-cases.md`、`06-test-report.md`：影响面、P0/P1 用例与结果。
- repository docs/link/license/package metadata scan。

## Contract

- 不把未执行的真实 DB migration、发布或本地更新写成已完成。
- 明确旧 runtime 不能打开 v3 DB、backup restore 路径、service stop 前置条件和 deprecated removal window。
- 真实 `~/.config/tasks-recorder` migration、tag/release/push、主分支 merge 与本地安装更新必须单独获得用户授权。

## 验收

- 文档树、Markdown links、commands、version/license/repository metadata 与 release artifact contract 一致。
- P0 全绿；所有 unknown 有明确 owner/action；到达授权 checkpoint 时停止外部动作。
