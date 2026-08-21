# task-02-semantic-commands

## 目标

实现 focus、Attribution correction、checkpoint、单 Task mutation 与结构同步的 compact command API/MCP tools，使语义变化与机械 heartbeat 完全分离。

## Contract

- `agent_work_focus` 原子形成 Segment boundary；user correction 不被 heartbeat 覆盖。
- `agent_work_checkpoint` 只更新当前 Segment summary 与目标 Task 的 compact next action，不同步整棵树。
- `agent_tasks_mutate` 使用 entity revision 创建/修改/move/status Task。
- `agent_tasks_sync_structure` 只在真实结构变化时同步一个 Main Task 与 direct children。
- 所有 mutation 返回 stable identity、revision、change 与 actionable conflict。

## 验收

- A→B→A、checkpoint no-op、revision conflict、child gate 与 atomic structure tests 全部通过。

## 完成证据

- focused semantic/MCP/client/API tests：15/15。
- full suite：254/254；`npm run check` 与 `git diff --check` 通过。
- root MCP 在本 Task 发布六个 compact v3 commands；task 04 随 adapter 切换补充第七个 `agent_work_intent`，用于 child execution 的显式 spawn attribution。
