# task-04-adapter-skill-cutover

## 目标

让 Codex、Claude 各自的 native adapter 发出同一 host-neutral Event Envelope，并让 task-manager skill 只在真实语义变化时调用 compact MCP commands。

## Contract

- adapters 自包含维护 native mapping，不在运行时强制共享 host payload code。
- lifecycle Hook 只 deliver/spool Event Envelope，短超时、fail-open、不启动 taskd、不运行 npm。
- heartbeat 与 Stop 不调用 context/list/full-tree sync；Stop 不自动完成 Task。
- task-manager skill 使用 work context/focus/checkpoint/task mutation；兼容 tools 仅服务旧客户端。

## 验收

- Codex/Claude fixture parity、unavailable taskd、Stop continuation、adapter package 与 MCP tool advertisement tests 全部通过。

## 完成证据

- Codex 与 Claude 各自维护 native lifecycle mapping，并只向 `/api/v1/events` 发送 allowlisted Event Envelope；prompt、tool input/output 与 transcript 均未进入 payload。
- canonical root hooks 与 packaged adapters 统一为 fail-open mechanical recording；heartbeat 不读取语义 context，Stop 恒定返回 `{}`，不再触发 continuation 或 Task completion。
- 新增 `agent_work_intent`，以 exact host agent key 建立 single-use spawn intent；child execution 只通过该显式凭据自动 Attribution。
- root/Codex/Claude task-manager skill 已切换到 `agent_work_context`、focus、checkpoint、intent 与 revisioned Task mutation，不再使用每轮 list/full-tree sync。
- focused adapter/semantic/MCP regression 26/26；full suite 259/259；84 个 source syntax checks、两个独立 adapter bundles 与 `git diff --check` 通过。
