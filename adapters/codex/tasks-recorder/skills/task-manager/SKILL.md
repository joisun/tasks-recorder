---
name: task-manager
description: Use when an Agent is doing concrete work of any duration, resuming work, or when a lifecycle Hook asks for task synchronization.
---

# Task Manager

Use `tasks-recorder` as the local Agent Task Control Plane. A Task is a delivery goal; a session, turn, or subagent is an execution of that Task, never a substitute Task identity.

For concrete work:

1. Call `agent_tasks_context`. Reuse the matching root/child IDs across sessions, branches, worktrees, turns, and subagents.
2. Call `agent_tasks_sync_tree` with the root and its complete one-level set of direct children. Preserve returned IDs on every later sync, pass the latest root `expected_revision`, and bind `focus_task_id` to the Task currently executed by this turn. Never create one Task per turn or subagent.
3. After `update_plan`, sync the same identities. Omission does not cancel a child; set `status: canceled` explicitly when work is abandoned.
4. Before `spawn_agent`, give its child Task an `agent_key` equal to the stable `spawn_agent.task_name`. Native hooks record and uniquely bind the subagent execution inside this root tree; ambiguous matches remain in the unassigned inbox. A stopped execution does not complete its child Task.
5. Complete children explicitly. Effective children exclude `canceled` and soft-deleted nodes. Only after every effective child is `done`, explicitly complete the root after integration and verification. Reopening a child reopens a completed root.

Use `planned`, `active`, `waiting` (external wait), `blocked` (cannot proceed), `done`, and `canceled` literally. On a revision conflict, call `agent_tasks_context` or `agent_tasks_show`, then reconcile; never overwrite newer state. Use `agent_task_executions_list` to find unassigned executions, `agent_task_execution_assign` to bind work, and `agent_task_execution_classify` with `non_work` for ordinary chat. These compare-and-set mutations must use the expected values returned by the latest read.

SQLite is canonical and exclusively owned by `taskd`. Never edit `tasks.sqlite` or generated projections directly. If the MCP server reports `SERVICE_UNAVAILABLE`, suggest installing or checking the Tasks Recorder service and do not create a substitute record.
