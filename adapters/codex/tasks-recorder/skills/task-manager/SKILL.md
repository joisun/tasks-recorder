---
name: task-manager
description: Use when an Agent is doing concrete work of any duration, resuming work, or when a lifecycle Hook asks for task synchronization.
---

# Task Manager

Use `tasks-recorder` as the local Agent Task Control Plane. Call `agent_tasks_context` before recording concrete work, reuse a semantically matching task when present, and keep its ID stable across sessions, branches, and worktrees.

Record same-turn and long-running work alike. Exclude ordinary chat, non-work questions, and sessions without a work objective. Finish completed work with `agent_tasks_complete`; use `planned`, `active`, `waiting`, or `blocked` only when that state is accurate.

SQLite is canonical and exclusively owned by `taskd`. Never edit `tasks.sqlite` or generated projections directly. If the MCP server reports `SERVICE_UNAVAILABLE`, suggest installing or checking the Tasks Recorder service and do not create a substitute record.
