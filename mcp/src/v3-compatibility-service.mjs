import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { access as fsAccess, stat as fsStat } from 'node:fs/promises'
import { basename, join } from 'node:path'

import { createJournalDashboardSnapshot } from './dashboard-data.mjs'
import { TaskRecorderError } from './errors.mjs'

const TERMINAL = new Set(['done', 'canceled'])
const LIFECYCLE_PRIORITY = new Map([
  ['in_progress', 0],
  ['blocked', 1],
  ['waiting', 2],
  ['planned', 3],
  ['done', 4],
  ['canceled', 5],
])

function compatibility(replacement, extra = {}) {
  return {
    deprecated: true,
    lossy: true,
    replacement,
    warning: 'Legacy shape projects Work Segment Attribution and cannot represent complete v3 history.',
    ...extra,
  }
}

function requiredString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TaskRecorderError('COMPATIBILITY_INPUT_INVALID', `${field} must be a non-empty string`, {
      field,
    })
  }
  return value.trim()
}

function optionalString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

function sourceFor(input = {}) {
  const agent = String(input.agent ?? input.agent_type ?? '').toLowerCase()
  return agent.includes('claude') ? 'claude' : 'codex'
}

function stableProjectId(name, location) {
  const slug = name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 36) || 'project'
  const suffix = createHash('sha256').update(`${name}\0${location}`).digest('hex').slice(0, 10)
  return `${slug}-${suffix}`
}

function legacyStatus(lifecycle) {
  return lifecycle === 'in_progress' ? 'active' : lifecycle
}

function v3Lifecycle(status) {
  return status === 'active' ? 'in_progress' : status
}

function dateOnly(value, fallback = null) {
  const source = optionalString(value)
  if (!source || Number.isNaN(Date.parse(source))) return fallback
  return new Date(source).toISOString().slice(0, 10)
}

function projectName(snapshot, projectId) {
  return snapshot.projects.find(({ id }) => id === projectId)?.name ?? 'Unassigned Project'
}

function legacyTask(task, snapshot) {
  return {
    id: task.id,
    parent_id: task.parent_id,
    project: projectName(snapshot, task.project_id),
    title: task.title,
    description: task.description,
    status: legacyStatus(task.lifecycle),
    start_date: dateOnly(task.planned_start_at, dateOnly(task.created_at)),
    due_date: dateOnly(task.planned_due_at),
    next_action: task.next_action,
    agent_key: null,
    sort_order: task.sort_order,
    revision: task.revision,
    completed_at: task.completed_at,
    archived_at: task.archived_at,
    deleted_at: task.deleted_at,
    created_at: task.created_at,
    updated_at: task.updated_at,
  }
}

function derivedExecutionStatus(execution) {
  if (execution.ended_at === null) return 'active'
  return execution.end_reason === 'interrupted' ? 'interrupted' : 'completed'
}

function executionProjection(snapshot, execution) {
  const sourceSession = snapshot.source_sessions.find(({ id }) => id === execution.source_session_id)
  const segments = snapshot.segments.filter(({ execution_id: id }) => id === execution.id)
  const attributedTaskIds = [...new Set(
    segments.map(({ task_id: taskId }) => taskId).filter(Boolean),
  )].sort()
  const latest = [...segments].sort((left, right) => (
    right.started_at.localeCompare(left.started_at) || right.id.localeCompare(left.id)
  ))[0] ?? null
  return {
    id: execution.id,
    external_key: execution.id,
    task_id: latest?.task_id ?? null,
    kind: execution.kind,
    root_session_id: sourceSession?.root_external_session_id
      ?? sourceSession?.external_session_id
      ?? null,
    session_id: sourceSession?.external_session_id ?? null,
    turn_id: execution.source_turn_key,
    agent_id: execution.source_agent_key,
    agent_type: sourceSession?.source === 'claude' ? 'Claude' : 'Codex',
    agent_path: execution.source_agent_key,
    parent_execution_id: execution.parent_execution_id,
    classification: execution.classification,
    workfolder: execution.workfolder,
    git_root: execution.git_root,
    worktree: execution.worktree,
    branch: execution.branch,
    status: derivedExecutionStatus(execution),
    started_at: execution.started_at,
    last_seen_at: execution.last_seen_at,
    ended_at: execution.ended_at,
    attributed_segments: segments
      .filter(({ task_id: taskId }) => taskId !== null)
      .map((segment) => ({
        id: segment.id,
        task_id: segment.task_id,
        started_at: segment.started_at,
        ended_at: segment.ended_at,
        last_seen_at: segment.last_seen_at,
        summary: segment.summary,
        provenance: segment.attribution_provenance,
      })),
    compatibility: compatibility('agent_work_context', {
      attributed_task_ids: attributedTaskIds,
    }),
  }
}

function latestExecution(snapshot, { sessionId, turnId = null, openOnly = false } = {}) {
  const sourceSessionIds = new Set(snapshot.source_sessions
    .filter(({ external_session_id: id }) => id === sessionId)
    .map(({ id }) => id))
  return snapshot.executions
    .filter((execution) => sourceSessionIds.has(execution.source_session_id))
    .filter((execution) => turnId === null || execution.source_turn_key === turnId)
    .filter((execution) => !openOnly || execution.ended_at === null)
    .sort((left, right) => (
      right.last_seen_at.localeCompare(left.last_seen_at) || right.id.localeCompare(left.id)
    ))[0] ?? null
}

function taskSessions(snapshot, taskId) {
  const executionById = new Map(snapshot.executions.map((execution) => [execution.id, execution]))
  const sessionById = new Map(snapshot.source_sessions.map((session) => [session.id, session]))
  const sessions = new Map()
  for (const segment of snapshot.segments) {
    if (segment.task_id !== taskId) continue
    const execution = executionById.get(segment.execution_id)
    const session = execution ? sessionById.get(execution.source_session_id) : null
    if (!execution || !session) continue
    const key = `${session.source}\0${session.external_session_id}`
    const current = sessions.get(key)
    const item = {
      task_id: taskId,
      session_id: session.external_session_id,
      workfolder: execution.workfolder,
      git_root: execution.git_root,
      worktree: execution.worktree,
      branch: execution.branch,
      agent: session.source === 'claude' ? 'Claude' : 'Codex',
      first_seen_at: segment.started_at,
      last_seen_at: segment.last_seen_at,
    }
    if (!current) sessions.set(key, item)
    else {
      if (item.first_seen_at < current.first_seen_at) current.first_seen_at = item.first_seen_at
      if (item.last_seen_at > current.last_seen_at) current.last_seen_at = item.last_seen_at
    }
  }
  return [...sessions.values()].sort((left, right) => left.session_id.localeCompare(right.session_id))
}

function taskExecutionAggregates(snapshot) {
  const groups = new Map()
  for (const execution of snapshot.executions.map((item) => executionProjection(snapshot, item))) {
    if (!execution.task_id) continue
    const items = groups.get(execution.task_id) ?? []
    items.push(execution)
    groups.set(execution.task_id, items)
  }
  return [...groups].map(([taskId, executions]) => ({
    task_id: taskId,
    execution_count: executions.length,
    active_execution_count: executions.filter(({ status }) => status === 'active').length,
    active_agent_count: new Set(
      executions.filter(({ status }) => status === 'active').map(({ agent_id, agent_type }) => (
        agent_id ?? agent_type
      )),
    ).size,
    recent_execution: executions.sort((left, right) => (
      right.last_seen_at.localeCompare(left.last_seen_at)
    ))[0],
  }))
}

export function createV3CompatibilityService({
  store,
  journalService,
  gitResolver = async (workfolder) => ({
    gitRoot: workfolder,
    gitCommonDir: null,
    gitRemote: null,
    worktree: workfolder,
    branch: null,
  }),
  renderer = null,
  outputDir = null,
  dashboardPath = null,
  access = fsAccess,
  stat = fsStat,
  dashboardAdapter = createJournalDashboardSnapshot,
  onChange = () => undefined,
} = {}) {
  if (!store?.projects || !store?.tasks || !store?.work) {
    throw new TypeError('store must be a JournalStore')
  }
  if (!journalService || typeof journalService.workContext !== 'function') {
    throw new TypeError('journalService must be a JournalService')
  }

  function publish(operation, result, details = {}) {
    if (!result.changed) return { ok: true, persisted: false, ...result }
    const change = onChange({ type: 'journal.changed', operation, ...details })
    return {
      ok: true,
      persisted: true,
      ...result,
      ...(change === undefined ? {} : { change }),
    }
  }

  async function enriched(input) {
    const workfolder = requiredString(input.workfolder, 'workfolder')
    const git = await gitResolver(workfolder)
    return {
      ...input,
      workfolder,
      git_root: git.gitRoot ?? null,
      git_common_dir: git.gitCommonDir ?? null,
      git_remote: git.gitRemote ?? null,
      worktree: git.worktree ?? workfolder,
      branch: git.branch ?? null,
    }
  }

  async function resolveProject(input, existingTask = null) {
    if (existingTask) return store.projects.show(existingTask.project_id).project
    const context = await enriched(input)
    const resolved = store.projects.resolve({
      git_common_dir: context.git_common_dir,
      workfolder: context.workfolder,
      worktree: context.worktree,
      git_remote: context.git_remote,
    })
    if (resolved.status === 'resolved') return resolved.project
    const named = store.projects.list().filter(({ name }) => name === input.project)
    if (named.length === 1) return named[0]
    const name = optionalString(input.project) ?? basename(context.git_root ?? context.workfolder)
    const location = context.git_common_dir ?? context.git_root ?? context.workfolder
    const id = stableProjectId(name, location)
    const created = store.projects.create({ id, name }).project
    store.projects.registerLocation({
      project_id: created.id,
      kind: context.git_common_dir ? 'git_common_dir' : 'workspace',
      value: location,
    })
    if (context.worktree && context.worktree !== location) {
      store.projects.registerLocation({
        project_id: created.id, kind: 'workspace', value: context.worktree,
      })
    }
    return created
  }

  function legacyTaskResult(task, snapshot = store.snapshot()) {
    return legacyTask(task, snapshot)
  }

  async function context(input) {
    const snapshot = store.snapshot()
    const execution = latestExecution(snapshot, { sessionId: input.session_id })
    let projectId = execution
      ? snapshot.source_sessions.find(({ id }) => id === execution.source_session_id)?.project_id ?? null
      : null
    if (!projectId && input.workfolder) {
      const git = await enriched(input)
      const resolution = store.projects.resolve({
        git_common_dir: git.git_common_dir,
        workfolder: git.workfolder,
        worktree: git.worktree,
        git_remote: git.git_remote,
      })
      projectId = resolution.status === 'resolved' ? resolution.project.id : null
    }
    const currentTaskId = execution
      ? executionProjection(snapshot, execution).task_id
      : null
    const tasks = snapshot.tasks
      .filter((task) => task.project_id === projectId && !TERMINAL.has(task.lifecycle))
      .sort((left, right) => {
        if (left.id === currentTaskId && right.id !== currentTaskId) return -1
        if (right.id === currentTaskId && left.id !== currentTaskId) return 1
        const priority = LIFECYCLE_PRIORITY.get(left.lifecycle) - LIFECYCLE_PRIORITY.get(right.lifecycle)
        return priority || right.updated_at.localeCompare(left.updated_at) || left.id.localeCompare(right.id)
      })
    return {
      candidates: tasks.map((task) => ({
        task: legacyTask(task, snapshot),
        sessions: taskSessions(snapshot, task.id),
        match_reasons: task.id === currentTaskId ? ['current_attribution'] : ['project'],
        score: task.id === currentTaskId ? 8 : 4,
      })),
      execution_id: execution?.id ?? null,
      git_context: input.workfolder ? await enriched(input).then((value) => ({
        gitRoot: value.git_root,
        gitCommonDir: value.git_common_dir,
        gitRemote: value.git_remote,
        worktree: value.worktree,
        branch: value.branch,
      })) : null,
      compatibility: compatibility('agent_work_context'),
    }
  }

  async function list(filters = {}) {
    const snapshot = store.snapshot()
    return snapshot.tasks
      .filter((task) => filters.project === undefined
        || projectName(snapshot, task.project_id) === filters.project)
      .filter((task) => filters.status === undefined
        || legacyStatus(task.lifecycle) === filters.status)
      .filter((task) => {
        if (filters.workfolder === undefined && filters.branch === undefined) return true
        const sessions = taskSessions(snapshot, task.id)
        return sessions.some((session) => (
          (filters.workfolder === undefined || session.workfolder === filters.workfolder)
          && (filters.branch === undefined || session.branch === filters.branch)
        ))
      })
      .map((task) => legacyTask(task, snapshot))
  }

  async function show(id) {
    const result = store.tasks.show(id)
    const snapshot = store.snapshot()
    return {
      task: legacyTask(result.task, snapshot),
      parent: result.parent ? legacyTask(result.parent, snapshot) : null,
      children: result.children.map((task) => legacyTask(task, snapshot)),
      progress: result.progress,
      sessions: taskSessions(snapshot, result.task.id),
      compatibility: compatibility('agent_tasks_mutate'),
    }
  }

  async function focusCurrentExecution(input, taskId) {
    const snapshot = store.snapshot()
    const execution = latestExecution(snapshot, {
      sessionId: input.session_id,
      turnId: optionalString(input.turn_id),
      openOnly: true,
    }) ?? latestExecution(snapshot, { sessionId: input.session_id, openOnly: true })
    if (!execution || taskId === null) return null
    const currentTime = Date.now()
    const lastSeenTime = Date.parse(execution.last_seen_at)
    const observedAt = new Date(Math.max(currentTime, lastSeenTime + 1)).toISOString()
    const result = await journalService.focus({
      execution_id: execution.id,
      task_id: taskId,
      provenance: 'agent_explicit',
      rationale_code: 'legacy_compatibility',
      observed_at: observedAt,
    })
    return executionProjection(store.snapshot(), result.execution)
  }

  async function upsert(input) {
    const existing = store.tasks.list().find(({ id }) => id === input.id) ?? null
    const project = await resolveProject(input, existing)
    let result
    if (existing) {
      result = store.tasks.update({
        id: existing.id,
        expected_revision: existing.revision,
        patch: {
          project_id: project.id,
          parent_id: input.parent_id ?? existing.parent_id,
          title: input.title,
          description: input.description ?? existing.description,
          lifecycle: v3Lifecycle(input.status),
          planned_start_at: input.start_date ? `${input.start_date}T00:00:00.000Z` : existing.planned_start_at,
          planned_due_at: input.due_date ? `${input.due_date}T23:59:59.999Z` : input.due_date === null ? null : existing.planned_due_at,
          next_action: input.next_action ?? existing.next_action,
          sort_order: input.sort_order ?? existing.sort_order,
        },
        actor: 'agent',
      })
    } else {
      result = store.tasks.create({
        id: input.id,
        project_id: project.id,
        parent_id: input.parent_id ?? null,
        title: input.title,
        description: input.description ?? null,
        lifecycle: v3Lifecycle(input.status),
        planned_start_at: input.start_date ? `${input.start_date}T00:00:00.000Z` : null,
        planned_due_at: input.due_date ? `${input.due_date}T23:59:59.999Z` : null,
        next_action: input.next_action ?? null,
        sort_order: input.sort_order ?? 0,
        actor: 'agent',
      })
    }
    const bound = await focusCurrentExecution(input, result.task.id)
    return publish('legacy.upsert', {
      task: legacyTaskResult(result.task),
      changed: result.changed,
      bound_execution: bound,
      compatibility: compatibility('agent_tasks_mutate'),
    }, { task_id: result.task.id })
  }

  async function complete(input) {
    const current = store.tasks.show(input.id).task
    const result = store.tasks.updateLifecycle({
      id: current.id,
      expected_revision: current.revision,
      lifecycle: 'done',
      actor: 'agent',
    })
    return publish('legacy.complete', {
      task: legacyTaskResult(result.task),
      changed: result.changed,
      compatibility: compatibility('agent_tasks_mutate'),
    }, { task_id: result.task.id })
  }

  async function syncTree(input) {
    const existing = store.tasks.list().find(({ id }) => id === input.root.id) ?? null
    const project = await resolveProject({ ...input, project: input.root.project }, existing)
    const currentChildren = existing
      ? store.tasks.show(existing.id).children.filter(({ lifecycle }) => lifecycle !== 'canceled')
      : []
    const result = await journalService.syncStructure({
      project_id: project.id,
      main_task: {
        id: input.root.id,
        ...(existing ? { expected_revision: input.expected_revision ?? existing.revision } : {}),
        title: input.root.title,
        description: input.root.description ?? null,
        lifecycle: v3Lifecycle(input.root.status),
        planned_start_at: input.root.start_date ? `${input.root.start_date}T00:00:00.000Z` : null,
        planned_due_at: input.root.due_date ? `${input.root.due_date}T23:59:59.999Z` : null,
        next_action: input.root.next_action ?? null,
      },
      expected_children: currentChildren.map(({ id, revision }) => ({ id, revision })),
      children: input.children.map((child) => {
        const current = currentChildren.find(({ id }) => id === child.id)
        return {
          id: child.id,
          ...(current ? { expected_revision: current.revision } : {}),
          title: child.title,
          description: child.description ?? null,
          lifecycle: v3Lifecycle(child.status),
          planned_due_at: child.due_date ? `${child.due_date}T23:59:59.999Z` : null,
          next_action: child.next_action ?? null,
          sort_order: child.sort_order,
        }
      }),
      actor: 'agent',
    })
    const activeExecution = latestExecution(store.snapshot(), {
      sessionId: input.session_id,
      turnId: optionalString(input.turn_id),
      openOnly: true,
    }) ?? latestExecution(store.snapshot(), { sessionId: input.session_id, openOnly: true })
    for (const child of input.children) {
      if (!optionalString(child.agent_key) || !activeExecution) continue
      store.work.registerIntent({
        source: sourceFor(input),
        source_session_key: input.session_id,
        external_agent_key: child.agent_key,
        task_id: child.id,
        created_at: activeExecution.last_seen_at,
      })
    }
    const focusId = input.focus_task_id ?? result.main_task.id
    const bound = await focusCurrentExecution(input, focusId)
    const snapshot = store.snapshot()
    return {
      ...result,
      root: legacyTask(result.main_task, snapshot),
      children: result.children.map((task) => legacyTask(task, snapshot)),
      removed: result.removed.map((task) => legacyTask(task, snapshot)),
      focused_task: focusId ? legacyTask(store.tasks.show(focusId).task, snapshot) : null,
      bound_execution: bound,
      compatibility: compatibility('agent_tasks_sync_structure'),
    }
  }

  async function updateTask(input) {
    const current = store.tasks.show(input.id).task
    const patch = input.patch ?? {}
    const result = store.tasks.update({
      id: current.id,
      expected_revision: input.expected_revision,
      patch: {
        ...('parent_id' in patch ? { parent_id: patch.parent_id } : {}),
        ...('title' in patch ? { title: patch.title } : {}),
        ...('description' in patch ? { description: patch.description } : {}),
        ...('status' in patch ? { lifecycle: v3Lifecycle(patch.status) } : {}),
        ...('start_date' in patch ? { planned_start_at: patch.start_date ? `${patch.start_date}T00:00:00.000Z` : null } : {}),
        ...('due_date' in patch ? { planned_due_at: patch.due_date ? `${patch.due_date}T23:59:59.999Z` : null } : {}),
        ...('next_action' in patch ? { next_action: patch.next_action } : {}),
        ...('sort_order' in patch ? { sort_order: patch.sort_order } : {}),
      },
      actor: input.actor ?? 'agent',
    })
    return publish('legacy.updateTask', {
      task: legacyTaskResult(result.task), changed: result.changed,
      compatibility: compatibility('agent_tasks_mutate'),
    }, { task_id: result.task.id })
  }

  async function updateStatus(input) {
    const current = store.tasks.show(input.id).task
    if (input.expected_updated_at && input.expected_updated_at !== current.updated_at) {
      throw new TaskRecorderError('TASK_VERSION_CONFLICT', `task ${input.id} was updated`, {
        id: input.id,
        expected_updated_at: input.expected_updated_at,
        task: legacyTaskResult(current),
      })
    }
    const result = store.tasks.updateLifecycle({
      id: current.id,
      expected_revision: current.revision,
      lifecycle: v3Lifecycle(input.status),
      actor: input.actor ?? 'user',
    })
    return publish('legacy.updateStatus', {
      task: legacyTaskResult(result.task), changed: result.changed,
      compatibility: compatibility('agent_tasks_mutate'),
    }, { task_id: result.task.id })
  }

  async function listExecutions(filters = {}) {
    let executions = store.snapshot().executions
    const snapshot = store.snapshot()
    const sessionById = new Map(snapshot.source_sessions.map((session) => [session.id, session]))
    executions = executions.map((execution) => executionProjection(snapshot, execution))
      .filter((execution) => filters.task_id === undefined
        || execution.compatibility.attributed_task_ids.includes(filters.task_id))
      .filter((execution) => filters.root_session_id === undefined
        || execution.root_session_id === filters.root_session_id)
      .filter((execution) => filters.session_id === undefined
        || execution.session_id === filters.session_id)
      .filter((execution) => filters.status === undefined || execution.status === filters.status)
      .filter((execution) => filters.unassigned === undefined
        || String(filters.unassigned) !== 'true'
        || execution.task_id === null)
    void sessionById
    return executions
  }

  async function sessionContext(id) {
    const executions = await listExecutions({ root_session_id: id })
    return {
      root_session_id: id,
      active_execution_count: executions.filter(({ status }) => status === 'active').length,
      unassigned_execution_count: executions.filter(({ task_id }) => task_id === null).length,
      active_executions: executions.filter(({ status }) => status === 'active'),
      compatibility: compatibility('agent_work_context'),
    }
  }

  async function assignExecution(input) {
    const result = store.work.assignExecution(input)
    const response = publish('legacy.assignExecution', result, {
      execution_id: result.execution.id,
      task_id: result.attribution?.task_id ?? null,
    })
    return {
      ...response,
      execution: executionProjection(store.snapshot(), result.execution),
      compatibility: compatibility('agent_work_attribution_correct'),
    }
  }

  async function classifyExecution(input) {
    const result = store.work.classifyExecution(input)
    const response = publish('legacy.classifyExecution', result, {
      execution_id: result.execution.id,
    })
    return {
      ...response,
      execution: executionProjection(store.snapshot(), result.execution),
      compatibility: compatibility('Attribution Inbox'),
    }
  }

  async function updateExecutionAssignments(input) {
    const result = store.work.updateExecutionAssignments(input)
    const response = publish('legacy.updateExecutionAssignments', result, {
      execution_ids: result.executions.map(({ id }) => id),
    })
    const snapshot = store.snapshot()
    return {
      ...response,
      executions: result.executions.map((execution) => executionProjection(snapshot, execution)),
      compatibility: compatibility('Attribution Inbox'),
    }
  }

  async function mutateVisibility(operation, input) {
    const result = store.tasks[operation]({
      id: input.id,
      expected_revision: input.expected_revision,
      actor: input.actor ?? 'user',
    })
    return publish(`legacy.${operation}`, {
      task: legacyTaskResult(result.task),
      changed: result.changed,
      compatibility: compatibility('agent_tasks_mutate'),
    }, { task_id: result.task.id })
  }

  async function heartbeat(input) {
    const snapshot = store.snapshot()
    const execution = latestExecution(snapshot, { sessionId: input.session_id, openOnly: true })
    if (!execution) return { updated: false, reason: 'no-active-execution' }
    const result = store.work.heartbeatExecution({ execution_id: execution.id })
    if (result.changed) onChange({ type: 'journal.changed', operation: 'legacy.heartbeat', execution_id: execution.id })
    return {
      updated: result.changed,
      execution_id: execution.id,
      last_seen_at: result.execution.last_seen_at,
      compatibility: compatibility('POST /api/v1/events'),
    }
  }

  async function lifecycle(operation, input) {
    const before = store.snapshot()
    const stoppingExecution = operation === 'subagentStop'
      ? latestExecution(before, { sessionId: input.session_id, openOnly: true })
      : null
    const stoppingSession = stoppingExecution
      ? before.source_sessions.find(({ id }) => id === stoppingExecution.source_session_id) ?? null
      : null
    const source = stoppingSession?.source ?? sourceFor(input)
    const observedAt = input.started_at ?? input.occurred_at ?? input.ended_at ?? new Date().toISOString()
    const common = input.workfolder ? await enriched(input) : input
    const base = {
      source,
      external_event_id: input.external_key
        ? `${input.external_key}:${operation}`
        : `${source}:${operation}:${input.root_session_id}:${observedAt}`,
      observed_at: observedAt,
      source_session_key: stoppingSession?.external_session_id
        ?? input.session_id
        ?? input.root_session_id,
      root_session_key: stoppingSession?.root_external_session_id ?? input.root_session_id,
      source_turn_key: stoppingExecution?.source_turn_key
        ?? input.turn_id
        ?? `session:${input.root_session_id}`,
      source_agent_key: stoppingExecution?.source_agent_key ?? input.agent_id ?? null,
      workfolder: stoppingExecution?.workfolder ?? common.workfolder ?? null,
      git_root: stoppingExecution?.git_root ?? common.git_root ?? null,
      git_common_dir: stoppingExecution?.git_common_dir ?? common.git_common_dir ?? null,
      git_remote: stoppingExecution?.git_remote ?? common.git_remote ?? null,
      worktree: stoppingExecution?.worktree ?? common.worktree ?? null,
      branch: stoppingExecution?.branch ?? common.branch ?? null,
    }
    let envelope
    if (operation === 'sessionStart') {
      envelope = { ...base, event_type: 'session.started', payload: {} }
    } else if (operation === 'turnStart') {
      envelope = { ...base, event_type: 'execution.started', source_agent_key: null, payload: { kind: 'main' } }
    } else if (operation === 'toolUse') {
      envelope = { ...base, event_type: 'execution.heartbeat', source_agent_key: null, payload: { activity: 'tool_use' } }
    } else if (operation === 'subagentStart') {
      const parent = latestExecution(store.snapshot(), {
        sessionId: input.parent_session_id ?? input.root_session_id,
        turnId: input.turn_id ?? null,
        openOnly: true,
      })
      envelope = {
        ...base,
        event_type: 'execution.started',
        payload: { kind: 'subagent', ...(parent ? { parent_execution_id: parent.id } : {}) },
      }
    } else if (operation === 'subagentStop') {
      envelope = {
        ...base,
        event_type: 'execution.stop',
        payload: { end_reason: input.interrupted ? 'interrupted' : 'completed' },
      }
    } else {
      envelope = {
        ...base,
        source_session_key: input.root_session_id,
        event_type: 'session.ended',
        payload: { end_reason: input.interrupted ? 'interrupted' : 'completed' },
      }
    }
    const result = await journalService.ingestEvent(envelope)
    const snapshot = store.snapshot()
    const executions = result.execution_ids
      .map((id) => snapshot.executions.find((execution) => execution.id === id))
      .filter(Boolean)
      .map((execution) => executionProjection(snapshot, execution))
    const execution = result.execution_id
      ? executions.find(({ id }) => id === result.execution_id) ?? null
      : null
    return {
      ...result,
      execution,
      executions,
      compatibility: compatibility('POST /api/v1/events'),
    }
  }

  async function importExecutions(input) {
    const records = Array.isArray(input?.records) ? input.records : []
    const preview = {
      ok: true,
      dry_run: input?.dry_run === true,
      persisted: false,
      changed: false,
      would_create: records.length,
      would_update: 0,
      would_skip: 0,
      warnings: Array.isArray(input?.warnings) ? input.warnings : [],
      compatibility: compatibility('POST /api/v1/events'),
    }
    if (preview.dry_run) return preview

    const executionIds = new Map()
    let created = 0
    let skipped = 0
    for (const record of records) {
      const parentExecutionId = record.parent_external_key
        ? executionIds.get(record.parent_external_key) ?? null
        : null
      const turnKey = record.turn_id ?? `subagent:${record.external_key}`
      const agentKey = record.kind === 'subagent'
        ? record.agent_id ?? record.external_key
        : null
      const started = await journalService.ingestEvent({
        source: 'importer',
        event_type: 'execution.started',
        external_event_id: `import:${record.external_key}:start`,
        observed_at: record.started_at,
        source_session_key: record.session_id,
        root_session_key: record.root_session_id,
        source_turn_key: turnKey,
        source_agent_key: agentKey,
        workfolder: record.workfolder,
        git_root: record.git_root ?? null,
        git_common_dir: null,
        git_remote: null,
        worktree: record.worktree ?? null,
        branch: record.branch ?? null,
        payload: {
          kind: record.kind,
          ...(parentExecutionId ? { parent_execution_id: parentExecutionId } : {}),
        },
      })
      executionIds.set(record.external_key, started.execution_id)
      if (started.deduped) skipped += 1
      else created += 1
      if (record.ended_at) {
        await journalService.ingestEvent({
          source: 'importer',
          event_type: 'execution.stop',
          external_event_id: `import:${record.external_key}:stop`,
          observed_at: record.ended_at,
          source_session_key: record.session_id,
          root_session_key: record.root_session_id,
          source_turn_key: turnKey,
          source_agent_key: agentKey,
          workfolder: record.workfolder,
          git_root: record.git_root ?? null,
          git_common_dir: null,
          git_remote: null,
          worktree: record.worktree ?? null,
          branch: record.branch ?? null,
          payload: {
            end_reason: record.status === 'interrupted' ? 'interrupted' : 'completed',
          },
        })
      }
    }
    return {
      ...preview,
      dry_run: false,
      persisted: created > 0,
      changed: created > 0,
      created,
      updated: 0,
      skipped,
    }
  }

  function projectedLegacySnapshot() {
    const snapshot = store.snapshot()
    return {
      tasks: snapshot.tasks.map((task) => legacyTask(task, snapshot)),
      sessions: snapshot.tasks.flatMap((task) => taskSessions(snapshot, task.id)),
      task_execution_aggregates: taskExecutionAggregates(snapshot),
      unassigned_execution_count: snapshot.attribution_inbox_count,
    }
  }

  async function render() {
    if (!renderer || !outputDir) {
      return {
        ok: true,
        persisted: false,
        projection_updated: false,
        projection_stale: true,
        compatibility: compatibility('GET /api/v1/snapshot'),
      }
    }
    await access(outputDir, constants.W_OK)
    const projection = await renderer({ loadSnapshot: projectedLegacySnapshot, outputDir })
    return {
      ok: true, persisted: false, projection_updated: true, projection_stale: false, projection,
      compatibility: compatibility('GET /api/v1/snapshot'),
    }
  }

  async function dashboardSnapshot() {
    return dashboardAdapter(store.snapshot())
  }

  async function check() {
    let dashboard = { available: false, build_path: dashboardPath, built_at: null }
    if (dashboardPath) {
      try {
        const metadata = await stat(dashboardPath)
        dashboard = {
          available: true,
          build_path: dashboardPath,
          built_at: new Date(metadata.mtimeMs).toISOString(),
        }
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
    }
    return {
      ...store.check(),
      dashboard,
      projection: { fresh: false, tasksPath: outputDir ? join(outputDir, 'Tasks.md') : null },
      compatibility: compatibility('GET /api/v1/status'),
    }
  }

  return {
    context,
    list,
    show,
    upsert,
    complete,
    syncTree,
    updateTask,
    updateStatus,
    listExecutions,
    sessionContext,
    heartbeat,
    sessionStart: (input) => lifecycle('sessionStart', input),
    turnStart: (input) => lifecycle('turnStart', input),
    toolUse: (input) => lifecycle('toolUse', input),
    subagentStart: (input) => lifecycle('subagentStart', input),
    subagentStop: (input) => lifecycle('subagentStop', input),
    sessionEnd: (input) => lifecycle('sessionEnd', input),
    taskEvents: async ({ task_id: id }) => store.tasks.show(id).events,
    assignExecution,
    classifyExecution,
    updateExecutionAssignments,
    importExecutions,
    archiveTask: (input) => mutateVisibility('archive', input),
    deleteTask: (input) => mutateVisibility('delete', input),
    restoreTask: (input) => mutateVisibility('restore', input),
    render,
    dashboardSnapshot,
    check,
  }
}
