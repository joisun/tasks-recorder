---
name: task-manager
description: Use when an Agent is doing concrete work of any duration, resuming work, or when a lifecycle Hook asks for task synchronization.
---

# Task Manager

Use `tasks-recorder` as the local Agent Task Control Plane. A Task is a delivery outcome, not a conversation or subagent identity. Call `agent_tasks_context` before recording concrete work, reuse a semantically matching Task when present, and keep its ID stable across sessions, branches, and worktrees.

Record same-turn and long-running work alike. Distinct goals handled in one conversation remain distinct Tasks. Use `agent_tasks_sync_tree` for one root with at most one direct child level; reuse returned IDs and use `canceled` only for work explicitly removed from scope. Exclude ordinary chat, non-work questions, and sessions without a work objective. Complete children explicitly before the root; use `planned`, `active`, `waiting`, `blocked`, `done`, and `canceled` literally.

SQLite is canonical and exclusively owned by `taskd`. Never edit `tasks.sqlite` or generated projections directly. If the MCP server reports `SERVICE_UNAVAILABLE`, suggest installing or checking the Tasks Recorder service and do not create a substitute record.
