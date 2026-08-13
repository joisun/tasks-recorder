---
name: task-manager
description: Use when an Agent is doing concrete work of any duration, resuming work, or when a lifecycle Hook asks for task synchronization.
---

# Task Manager

## Overview

Use `tasks-recorder` as the local Agent Task Control Plane. SQLite is canonical and exclusively owned by `taskd`; the independent Tree + Timeline Dashboard is available at `http://127.0.0.1:43127`.

Dashboard status correction exists only to recover from Hook or lifecycle gaps. It does not replace semantic maintenance through `agent_tasks_context`, `agent_tasks_upsert`, and `agent_tasks_complete`.

## Decide whether to record

Record short, medium, long, same-turn, and cross-session work whenever the session has a concrete work objective. A completed short task is still recorded and then marked `done`.

Do not create a task for ordinary chat, non-work questions, synthetic Hook prompts, or a session with no actual work objective.

## Status reference

| Status | Meaning |
| --- | --- |
| `planned` | Agreed work that has not started |
| `active` | Work currently progressing |
| `waiting` | Waiting on a person, decision, or external result |
| `blocked` | Cannot progress without resolving an obstacle |
| `done` | Completed; remains visible in completed/history views |

## Maintenance workflow

1. Call `agent_tasks_context` first with the exact `session_id` and `workfolder` supplied by the Hook.
2. Prefer an existing candidate in this order: exact session, exact workfolder, exact worktree, exact branch. Use title, project, and next action to confirm semantic identity.
3. Call `agent_tasks_show` when a candidate is ambiguous or when resuming old work. Use `agent_tasks_list` only when context candidates are insufficient.
4. Update the matching task with `agent_tasks_upsert`; keep its ID stable when session, branch, worktree, title, or dates change.
5. Create a new kebab-case ID only after confirming that no candidate is the same task.
6. Call `agent_tasks_complete` only when the task is actually finished, including same-turn work.

Follow the input schemas advertised by MCP `tools/list`; do not guess or duplicate field names from this Skill.

## Parent and subtask rule

Use at most one child level. Parent and child must share the same project. A child is an independently trackable next action, not a formatting device.

## Recovery

For work resumed after a gap, start with context, inspect the best candidate with show, then continue from `next_action` and the linked session/workfolder history. A changed session or worktree does not create a new task identity.

## Storage boundary

Never edit `tasks.sqlite` directly. Use only named `agent_tasks_*` tools. If MCP reports `SERVICE_UNAVAILABLE`, report that persistence failed and suggest checking `npm run taskd -- status`; do not create a substitute record or bypass taskd. `agent_tasks_render` and legacy Markdown projections remain compatibility-only interfaces.

## Common mistakes

- Creating a new ID before checking candidates creates duplicates.
- Treating `waiting` as `blocked` hides whether an obstacle is actionable.
- Completing a parent merely because one child finished loses remaining work.
- Treating Dashboard view state as another database creates conflicting state; its status correction must still flow through taskd and authoritative SQLite snapshots.
