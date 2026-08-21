# 测试报告

**测试日期**：2026-08-21
**测试范围**：[`04-test-plan.md`](./04-test-plan.md)
**测试用例**：[`05-test-cases.md`](./05-test-cases.md)

## 结果汇总

| 用例范围 | 状态 | 证据 |
| --- | --- | --- |
| TC-01–TC-13 | 通过 | `npm test`：280/280；migration/installer/package focused：12/12；`0.6.0` installer/metadata/package focused：11/11 |
| TC-14 | 通过 | ignored local evidence `.vdr-log/20260820-journalist-v3-responsive-regression/report.md`：12/12 PASS，原 10/10 findings resolved |
| TC-15 | 通过 | 9 个核心 Markdown relative links：0 missing；metadata/docs focused：4/4 |
| TC-16–TC-17 | 通过 | 85-file syntax check；loopback/privacy tests included in 280/280；ignored/sensitive artifact path scan 0 matches；`git diff --check` exit 0 |

**通过率**：17 / 17
**P0 用例是否全部通过**：是

## Build 与 artifact 证据

- `npm run build`：exit 0。
- `npm run build:adapters`：Codex 与 Claude MCP bundles 均生成。
- `npm run package:release`：生成 macOS runtime、Codex adapter、Claude adapter 三份 archive。
- release contract 已由重复的 `0.5.0` 修正为未占用的 `0.6.0`；package、lockfile、两套 native adapter metadata、MCP server metadata、README 与 archive root `tasks-recorder-0.6.0/` 一致。
- packaged runtime smoke：在 source tree 外完成 v2→v3 dry-run/apply、verified backup、taskd ready、Dashboard、SSE ready、Codex/Claude MCP handshake、execution lifecycle 和 import dry-run。
- 三份 archive 均可完整读取；本地 SHA-256 已生成并仅用于当前 ignored build evidence，正式 Release 的 `SHA256SUMS` 由 workflow 生成。

## 真实数据库只读预检

用户授权后，使用 feature worktree 的 v3 CLI 对 canonical `~/.config/tasks-recorder/tasks.sqlite` 执行了两次 `migrate --dry-run`；两次 privacy-bounded JSON report 完全一致，service 前后均保持 ready：

- source schema 2，target schema 3；
- 303 Tasks、366 Executions；
- 295 bound Executions 会生成 accepted migration Attribution；
- 71 unassigned Executions 保持未归属；
- 计划生成 26 个 Project，其中 20 个因 6 组 `PROJECT_LOCATION_COLLISION` 标记 ambiguous。

collision 不会触发猜测合并或丢弃：legacy Project 与 Tasks 将保留为独立 provisional/ambiguous records，迁移后由 Project Inbox 显式核对。本步骤没有 stop service、创建 backup、修改 `user_version` 或写入业务数据。

## 失败 / 阻塞用例详情

无失败或阻塞用例。

## 遗漏项（Gap）

没有发现需要转为新 Task 的 implementation gap。

保留一个非阻塞环境 unknown：当前 mobile evidence 来自 Chromium `375×812` viewport，没有真实 iOS/Android device 的 finger friction 与 safe-area 录像。该项不影响本机 macOS Dashboard 的 release-candidate gate；若未来声明 mobile browser 为正式支持平台，应单独建立 device smoke Task。

## Johari closeout

- **Open Area**：schema、migration、fact/semantic stores、adapters、package runtime、Dashboard hierarchy/timeline、docs/metadata 均有自动化或可定位浏览器证据。
- **Hidden Area**：真实数据库的 aggregate ambiguity 分布已由 privacy-bounded dry-run 确认；具体 collision 应在 migration 后通过本机 Project Inbox 由用户核对，不在 CLI 输出中暴露 Project/path 明细。
- **Blind Spot**：安装升级成功不等于真实数据库可安全自动迁移；因此 installer 明确不做 migration，apply 仍要求 stop + backup path + 用户检查 report。
- **Unknown Area**：远端 CI/Release 与真实本机升级结果在执行前不可假定；下一动作是获取授权，而不是在报告里推断成功。

## 结论

`feature/journalist-model-v3` 已达到 **v0.6.0 release candidate / migration apply checkpoint**：实现、文档、本地隔离验证与真实数据库 read-only preview 满足既定 gate，P0 全绿。

以下动作明确**尚未执行**，也不属于本报告的通过声明：

- 停止 service、创建真实 schema-v2 backup，并对 `~/.config/tasks-recorder/tasks.sqlite` 执行 v2→v3 apply/restore 操作；
- Git commit、main branch merge、tag、push、GitHub Release；
- 更新本机 Tasks Recorder service、Codex adapter、Claude adapter。

这些动作会改变真实数据或外部状态，必须在用户确认后分阶段执行并各自保留验证证据。
