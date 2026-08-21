---
name: task-manager
description: Use when an Agent is doing concrete work of any duration, resuming work, or when a lifecycle Hook asks for task synchronization.
---

# Task Manager

Tasks Recorder is a local Project Journalist. It records what happened without turning every session, turn, or subagent into a Task.

## Model

- Observation, Source Session, Execution, and Work Segment are observed facts.
- Project, Main Task, and Subtask are user-owned semantics.
- Segment Attribution is the only bridge between facts and Tasks.
- A Project is the UI root. A Task has at most one child level.
- SQLite is canonical and exclusively owned by `taskd`.

Task lifecycle is `planned`, `in_progress`, `waiting`, `blocked`, `done`, or `canceled`. Execution live state is derived separately. An execution stopping never completes its Task.

## Workflow

1. For concrete work, use the exact `execution_id` supplied by the lifecycle Hook and call `agent_work_context`.
2. Reuse an existing Task only when its semantic identity matches. Session, branch, worktree, timing, title similarity, and agent identity are evidence, not Task identity.
3. If Project resolution is unresolved, leave the execution in Project Inbox. Do not infer a Project from branch name or remote alone.
4. Call `agent_work_focus` only when the execution's semantic focus changes. A real A → B → A sequence must remain three Work Segments.
5. Call `agent_work_checkpoint` only at a meaningful milestone. Keep the summary compact, set a concrete `next_action`, and use the latest Task revision.
6. Use `agent_tasks_mutate` for one Task. Use `agent_tasks_sync_structure` only for a deliberate Main Task/direct-child structure change, with the exact current child id/revision set.
7. Before spawning a child execution for a Task, call `agent_work_intent` with the exact host agent key when that host exposes an observable stable key.
8. Use `agent_work_attribution_correct` for an explicit correction. Prior attribution remains auditable.

Ordinary chat may remain unassigned or be classified `non_work` in the Dashboard. Hooks already record heartbeat and Stop mechanically; never respond to them with `agent_tasks_list`, full-tree synchronization, or automatic Task completion.

## Concurrency and recovery

Preserve stable Task IDs. On revision conflict, read current context/state and reconcile; never overwrite newer state. A changed session or worktree does not create a new Task identity.

Legacy `agent_tasks_*` compatibility tools that advertise deprecation are lossy projections and cannot represent multiple Work Segments. Prefer the semantic tools above.

## Storage boundary

Never edit `tasks.sqlite` or generated projections directly. If MCP reports `SERVICE_UNAVAILABLE`, report that Tasks Recorder persistence is unavailable and suggest `tasks-recorder status`; do not create substitute files or bypass `taskd`.
