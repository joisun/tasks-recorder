# 讨论与分析

## 背景 / 动机

Tasks Recorder 已能记录 Task tree、execution lifecycle 与实时 Dashboard，但当前模型把机械记录、任务语义和 lifecycle 收口耦合在一起：Stop hook 会要求 Agent 读取上下文并同步整棵树；`task_executions.task_id` 也无法准确表达一个 session 中连续切换多个 Main Task。产品需要从“Agent 主动填任务表”演进为本机工作记录员：先记录事实，再形成可解释、可纠正的 Project / Task 叙事。

## 现状

- 当前 schema version 为 2。
- `tasks.project` 是文本，不是 Project entity。
- `task_executions.task_id` 是单值外键。
- Dashboard 的根节点是 root Task，不是真正的 Project。
- current context 会使用 branch 匹配候选；跨 repo 的常见 branch 会污染结果。
- current task-manager skill 在 lifecycle 收口时可能调用 `context + list + sync_tree`，产生大 payload。
- Hook 已可观察 session、turn、tool、subagent、stop 等事件；taskd 是唯一 SQLite writer。

## 待澄清的问题

- [x] 一级层级是什么？ → Project 是独立一级实体，下面固定 Main Task → Subtask。
- [x] 系统的核心角色是什么？ → 记录发生过什么、正在发生什么；不负责驱动 Agent。
- [x] Session ID 是什么？ → 来源关联证据，不是 Task identity 或 auth credential。
- [x] 是否围绕最小改动设计？ → 否。先定义最佳目标模型，再独立设计渐进 rollout。
- [x] 主线程同一 session 内切换任务如何记录？ → Execution 内使用多个 Work Segment，通过 Attribution 归属 Task。
- [x] Hook 失败是否阻塞 Stop？ → 不阻塞；使用 fail-open + bounded spool + 幂等 replay。
- [x] 是否自动创建/归属 Task？ → 只有确定性来源自动接受；弱证据进入 Inbox。
- [x] Timeline 的父子关系如何表达？ → Project/Main Task actual summary 包络全部 descendant segments；planned 与 actual 分离。

## 方案探讨

### 方案 A：修补当前 v2

继续保留 `tasks.project TEXT` 与 `execution.task_id`，只限制 branch 查询并缩小 sync payload。

- 优点：改动最小、短期风险低。
- 缺点：A → B → A 仍无法表达；Project 仍是假层级；事实与语义继续耦合。
- 结论：拒绝。它只缓解症状，不满足产品目标。

### 方案 B：Project entity + Execution 直接绑定 Task

新增 Project 表和 Dashboard 一级节点，但继续让 Execution 直接拥有 Task。

- 优点：信息架构更正确，迁移中等。
- 缺点：一个 Execution 只能对应一个 Task；切换 focus 时只能覆盖历史或滥建 Execution。
- 结论：拒绝。时间事实模型仍然错误。

### 方案 C：Fact plane + Semantic plane + Work Segment Attribution

事实平面记录 Observation / Source Session / Execution / Work Segment；语义平面记录 Project / Main Task / Subtask；Attribution 作为可审计桥梁。

- 优点：准确表达多任务切换、允许未归属事实、支持纠错、适配多 host，Timeline 可从真实 segment 投影。
- 成本：schema v3、migration、adapter/MCP/Dashboard 都需调整。
- 结论：已选择。复杂度直接对应真实领域复杂度，并通过分阶段 rollout 控制实施风险。

## 明确排除的范围（Out of Scope）

- 任意深度 Task tree。
- cloud sync、多用户权限、远程 Dashboard。
- 替代 Linear / Jira 等完整项目管理。
- 保存 prompt、reasoning、tool input/output 或 secret。
- 用 LLM 对每条 observation 做在线自动分类。
- 根据 branch、remote、标题相似或时间邻近自动合并 Project / Task。

---

## 范围确认

> 进入 Plan 阶段前，此区块必须由人类确认。written spec 复核完成后再创建 `01-plan.md`。

**确认人**：项目所有者
**确认日期**：2026-08-19
**确认内容摘要**：用户确认应以客观最佳模型而非最小改动为目标，并明确要求“开始实施”；目标范围为 Project → Main Task → Subtask 的产品层级、记录员角色、可解释触发链路，以及主线程与 subagent 均可被正确记录。当前等待对 authoritative written spec 的最终复核。
