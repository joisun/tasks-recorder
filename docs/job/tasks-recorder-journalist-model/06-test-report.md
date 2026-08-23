# 测试报告

**测试日期**：2026-08-23
**测试范围**：[`04-test-plan.md`](./04-test-plan.md)
**测试用例**：[`05-test-cases.md`](./05-test-cases.md)

## 结果汇总

| 用例范围 | 状态 | 证据 |
| --- | --- | --- |
| TC-01–TC-13 | 通过 | `TZ=UTC npm test`：282/282；v0.6.1 spool/startup/installer/metadata/package focused：30/30 |
| TC-14 | 通过 | ignored local evidence `.vdr-log/20260820-journalist-v3-responsive-regression/report.md`：12/12 PASS，原 10/10 findings resolved |
| TC-15 | 通过 | 9 个核心 Markdown relative links：0 missing；metadata/docs focused：4/4 |
| TC-16–TC-17 | 通过 | 85-file syntax check；loopback/privacy tests included in 282/282；ignored/sensitive artifact path scan 0 matches；`git diff --check` exit 0 |

**通过率**：17 / 17
**P0 用例是否全部通过**：是

## Build 与 artifact 证据

- `npm run build`：exit 0。
- `npm run build:adapters`：Codex 与 Claude MCP bundles 均生成。
- `npm run package:release`：生成 macOS runtime、Codex adapter、Claude adapter 三份 archive。
- v0.6.0 正式 release contract 已验证；真实 spool 暴露的永久 replay conflict hotfix 将 package、lockfile、两套 native adapter metadata、MCP server metadata、README 与 archive root 统一升级到 `0.6.1` / `tasks-recorder-0.6.1/`。
- packaged runtime smoke：在 source tree 外完成 v2→v3 dry-run/apply、verified backup、taskd ready、Dashboard、SSE ready、Codex/Claude MCP handshake、execution lifecycle 和 import dry-run。
- v0.6.0 三份正式 archive 与 `install.sh` 均通过 Release `SHA256SUMS`；v0.6.1 三份 candidate archive 已重新生成并通过 package tests，正式 checksum 仍由 tag workflow 生成。

## 真实数据库迁移与安装态验证

用户授权后，先对 canonical `~/.config/tasks-recorder/tasks.sqlite` 执行 privacy-bounded dry-run，再停止 service、创建 verified schema-v2 backup，并单事务 apply 至 schema v3。最终 apply inventory 为：

- source schema 2，target schema 3；
- 26 Projects、320 Tasks、412 Executions、412 Work Segments；
- 334 accepted migration Attributions；
- 78 Executions 保持未归属；
- 20 个 Project 因 6 组 `PROJECT_LOCATION_COLLISION` 保持 ambiguous。

backup `tasks-v2-before-v3-20260821.sqlite` 为 `0600`、schema 2、integrity `ok`，SHA-256 为 `9b28c876ac9e8c4e9250c3aca0e339583dc1bd82538b4008e336edf52cfe4a10`。迁移后 canonical DB 为 schema 3，integrity `ok`、foreign key violations 0、invariant violations 0；collision 不会触发猜测合并或丢弃，由 Project Inbox 显式核对。

v0.6.0 service、Codex adapter 与 Claude adapter 已安装并验证为 0.6.0。安装态发现 1 个旧 boundary spool 为永久 `OBSERVATION_IDENTITY_CONFLICT`；v0.6.0 会把它误判为 retryable `SPOOL_REPLAY_SEND_FAILED`。v0.6.1 regression 覆盖了两层契约：spool 对明确 permanent rejection 隔离并继续后续事件，startup 仅把 `TaskRecorderError` 分类为 permanent，transport/storage/classifier failure 仍保留重试。

## 失败 / 阻塞用例详情

无 implementation failure 或阻塞用例。

fresh hotfix worktree 首轮 full suite 为 281/282，唯一失败是该 worktree 尚无 `node_modules/@svar-ui/react-gantt/package.json`；这不是代码断言失败。执行 `npm ci`（0 vulnerabilities）后，同一 `TZ=UTC npm test` 为 282/282，并再次完成 syntax、UI/adapters/release builds 与 `git diff --check`。

## 遗漏项（Gap）

没有发现需要阻塞 v0.6.1 的 implementation gap。

保留两个明确的运营 follow-up：20 个 ambiguous Project 需要在 Project Inbox 人工核对；82 条 migration 后的 stale open Execution 缺少 inactive-session evidence，按事实层原则不能自动结束。另有一个非阻塞环境 unknown：mobile evidence 来自 Chromium `375×812` viewport，没有真实 iOS/Android device 的 finger friction 与 safe-area 录像。

## Johari closeout

- **Open Area**：schema、migration、fact/semantic stores、adapters、package runtime、Dashboard hierarchy/timeline、docs/metadata、真实 backup/apply、v0.6.0 Release checksums 与本机安装均有直接证据。
- **Hidden Area**：具体 collision 与 stale execution identity 仍属于本机用户数据；报告只保留 aggregate counts，不输出 Project/path/session 明细。
- **Blind Spot**：unit/isolated replay 成功不代表真实旧 spool 不会包含 poison event；本机安装态验证发现这一点，并已转化为 v0.6.1 permanent/transient error-classification regression。
- **Unknown Area**：v0.6.1 远端 CI/Release 和真实 spool 隔离结果在 tag/install 前不可假定；必须由 workflow、checksum 与安装态 status 逐项证明。

## 结论

v0.6.0 rollout 与真实 schema v3 migration 已完成；数据库和已安装 service 均 ready。v0.6.1 hotfix 已达到 **local release candidate**：focused 30/30、UTC full suite 282/282、85-file syntax、UI/adapters/release builds 与 diff check 全绿。

尚未纳入本结论的唯一外部证据是 v0.6.1 main CI、GitHub Release/checksums 与本机真实 spool 隔离；这些将在 tag/install 后追加验证结果，不提前推断成功。
