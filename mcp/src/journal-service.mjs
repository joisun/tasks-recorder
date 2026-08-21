import { createHash } from 'node:crypto'

import { TaskRecorderError } from './errors.mjs'
import { parseEventEnvelope } from './event-envelope.mjs'

function stableExecutionId(envelope) {
  const identity = [
    envelope.source,
    envelope.source_session_key,
    envelope.source_turn_key,
    envelope.source_agent_key ?? '',
  ].join('\u0000')
  return `execution-${createHash('sha256').update(identity).digest('hex').slice(0, 24)}`
}

function projectResolutionForEvent(store, envelope) {
  return store.projects.resolve({
    explicit_project_id: envelope.project_id,
    git_common_dir: envelope.git_common_dir,
    workfolder: envelope.workfolder,
    worktree: envelope.worktree,
    git_remote: envelope.git_remote,
  })
}

function lifecycleInput(envelope, projectId) {
  return {
    execution_id: stableExecutionId(envelope),
    id: stableExecutionId(envelope),
    source: envelope.source,
    source_session_key: envelope.source_session_key,
    root_session_key: envelope.root_session_key,
    source_turn_key: envelope.source_turn_key,
    source_agent_key: envelope.source_agent_key,
    project_id: projectId,
    workfolder: envelope.workfolder,
    git_root: envelope.git_root,
    git_common_dir: envelope.git_common_dir,
    git_remote: envelope.git_remote,
    worktree: envelope.worktree,
    branch: envelope.branch,
    observed_at: envelope.observed_at,
  }
}

function applyLifecycle(store, envelope, projectId) {
  const input = lifecycleInput(envelope, projectId)
  if (envelope.event_type === 'execution.started') {
    return store.work.startExecution({
      ...input,
      kind: envelope.payload.kind,
      parent_execution_id: envelope.payload.parent_execution_id ?? null,
      started_at: envelope.observed_at,
    })
  }
  if (envelope.event_type === 'execution.heartbeat') {
    return store.work.heartbeatExecution(input)
  }
  if (envelope.event_type === 'execution.stop') {
    return store.work.endExecution({
      ...input,
      end_reason: envelope.payload.end_reason,
    })
  }
  if (envelope.event_type === 'session.ended') {
    return store.work.endSourceSessionExecutions({
      source: envelope.source,
      source_session_key: envelope.source_session_key,
      observed_at: envelope.observed_at,
      end_reason: envelope.payload.end_reason,
    })
  }
  return { execution: null, segment: null, changed: false }
}

function compactTask(task) {
  if (!task) return null
  return Object.fromEntries([
    'id',
    'project_id',
    'parent_id',
    'title',
    'description',
    'lifecycle',
    'planned_start_at',
    'planned_due_at',
    'next_action',
    'sort_order',
    'revision',
    'updated_at',
  ].map((field) => [field, task[field]]))
}

function compactExecution(execution) {
  return Object.fromEntries([
    'id',
    'kind',
    'classification',
    'source_turn_key',
    'source_agent_key',
    'parent_execution_id',
    'started_at',
    'ended_at',
    'last_seen_at',
    'end_reason',
  ].map((field) => [field, execution[field]]))
}

function compactSegment(segment) {
  if (!segment) return null
  return Object.fromEntries([
    'id',
    'execution_id',
    'started_at',
    'ended_at',
    'last_seen_at',
    'close_reason',
    'summary',
  ].map((field) => [field, segment[field]]))
}

function compactAttribution(attribution) {
  if (!attribution) return null
  return Object.fromEntries([
    'id',
    'segment_id',
    'task_id',
    'provenance',
    'rationale_code',
    'accepted_at',
  ].map((field) => [field, attribution[field]]))
}

export function createJournalService({
  store,
  onChange = () => undefined,
  logger = null,
  diagnostics = null,
} = {}) {
  if (!store?.projects || !store?.work || typeof store.transaction !== 'function') {
    throw new TypeError('store must be a JournalStore')
  }

  async function safeLog(event, fields) {
    if (!logger) return
    try {
      await logger.write(event, fields)
    } catch {
      // Observability must never roll back or reject a committed journal event.
    }
  }

  async function ingestEvent(input) {
    let envelope
    try {
      envelope = parseEventEnvelope(input)
    } catch (error) {
      diagnostics?.recordIngest({ accepted: false, error_code: error.code })
      await safeLog('event.rejected', { error_code: error.code ?? 'EVENT_REJECTED' })
      throw error
    }
    const projectResolution = projectResolutionForEvent(store, envelope)
    const projectId = projectResolution.status === 'resolved'
      ? projectResolution.project.id
      : null
    const result = store.transaction(() => {
      const observation = store.work.appendObservation({
        ...envelope,
        project_id: projectId,
      })
      const lifecycle = applyLifecycle(store, envelope, projectId)
      return { observation, lifecycle }
    })
    const persisted = result.observation.changed || result.lifecycle.changed
    const executions = result.lifecycle.executions
      ?? (result.lifecycle.execution ? [result.lifecycle.execution] : [])
    const segments = result.lifecycle.segments
      ?? (result.lifecycle.segment ? [result.lifecycle.segment] : [])
    const response = {
      ok: true,
      persisted,
      deduped: result.observation.deduped,
      observation_id: result.observation.observation.id,
      execution_id: result.lifecycle.execution?.id ?? null,
      segment_id: result.lifecycle.segment?.id ?? null,
      execution_ids: executions.map(({ id }) => id),
      segment_ids: segments.map(({ id }) => id),
      project_resolution: projectResolution,
    }
    diagnostics?.recordIngest({ accepted: true, deduped: response.deduped })
    await safeLog('event.accepted', {
      source: envelope.source,
      event_type: envelope.event_type,
      deduped: response.deduped,
      persisted: response.persisted,
      observation_id: response.observation_id,
      execution_id: response.execution_id,
      project_resolution: response.project_resolution.status,
    })
    if (!persisted) return response
    const change = onChange({
      type: 'journal.changed',
      operation: envelope.event_type,
      observation_id: response.observation_id,
      execution_id: response.execution_id,
      execution_ids: response.execution_ids,
    })
    return { ...response, ...(change === undefined ? {} : { change }) }
  }

  async function recover(input) {
    const result = store.work.recoverExecutions(input)
    const response = {
      ok: true,
      persisted: result.changed,
      recovered_execution_ids: result.recovered.map(({ id }) => id),
      stale_execution_ids: result.stale.map(({ id }) => id),
    }
    diagnostics?.recordRecovery({
      recovered_count: response.recovered_execution_ids.length,
      stale_count: response.stale_execution_ids.length,
    })
    await safeLog('recovery.completed', {
      recovered_count: response.recovered_execution_ids.length,
      stale_count: response.stale_execution_ids.length,
      error_code: null,
    })
    if (!result.changed) return response
    const change = onChange({
      type: 'journal.changed',
      operation: 'recovery',
      execution_ids: response.recovered_execution_ids,
    })
    return { ...response, ...(change === undefined ? {} : { change }) }
  }

  async function workContext(input) {
    const facts = store.work.context(input)
    const base = {
      ok: true,
      execution: compactExecution(facts.execution),
      project: facts.project
        ? Object.fromEntries(
          ['id', 'name', 'description', 'revision'].map((field) => [field, facts.project[field]]),
        )
        : null,
      project_resolution: facts.project
        ? { status: 'resolved', reason: 'source_session', inbox: null }
        : { status: 'unresolved', reason: 'insufficient_evidence', inbox: 'project' },
      current: {
        segment: compactSegment(facts.segment),
        attribution: compactAttribution(facts.attribution),
        task: compactTask(facts.task),
      },
      candidates: [],
      candidate_limit: 3,
    }
    if (!facts.project) return base

    const tasks = store.tasks.list({ project_id: facts.project.id })
      .filter((task) => task.archived_at === null && task.deleted_at === null)
    const childrenByParent = new Map()
    for (const task of tasks) {
      if (task.parent_id === null) continue
      const children = childrenByParent.get(task.parent_id) ?? []
      children.push(task)
      childrenByParent.set(task.parent_id, children)
    }
    const currentMainId = facts.task?.parent_id ?? facts.task?.id ?? null
    const lifecyclePriority = new Map([
      ['in_progress', 0],
      ['blocked', 1],
      ['waiting', 2],
      ['planned', 3],
    ])
    const roots = tasks.filter((task) => (
      task.parent_id === null && lifecyclePriority.has(task.lifecycle)
    ))
    roots.sort((left, right) => {
      if (left.id === currentMainId && right.id !== currentMainId) return -1
      if (right.id === currentMainId && left.id !== currentMainId) return 1
      const priority = lifecyclePriority.get(left.lifecycle) - lifecyclePriority.get(right.lifecycle)
      if (priority !== 0) return priority
      const recency = right.updated_at.localeCompare(left.updated_at)
      return recency !== 0 ? recency : left.id.localeCompare(right.id)
    })
    return {
      ...base,
      candidates: roots.slice(0, 3).map((task) => ({
        task: compactTask(task),
        children: (childrenByParent.get(task.id) ?? []).map(compactTask),
      })),
    }
  }

  function publishSemantic(operation, result, details = {}) {
    if (!result.changed) return { ok: true, persisted: false, ...result }
    const change = onChange({ type: 'journal.changed', operation, ...details })
    return {
      ok: true,
      persisted: true,
      ...result,
      ...(change === undefined ? {} : { change }),
    }
  }

  async function focus(input) {
    const result = store.work.focus(input)
    await safeLog('lifecycle.transition', {
      operation: 'focus',
      execution_id: result.execution.id,
      execution_count: 1,
    })
    return publishSemantic('focus', result, {
      execution_id: result.execution.id,
      task_id: result.attribution?.task_id ?? null,
    })
  }

  async function registerIntent(input) {
    const facts = store.work.context({ execution_id: input.execution_id })
    if (facts.execution.ended_at !== null) {
      throw new TaskRecorderError(
        'EXECUTION_ALREADY_ENDED',
        'cannot register a child execution intent from an ended execution',
        { execution_id: facts.execution.id },
      )
    }
    const result = store.work.registerIntent({
      source: facts.source_session.source,
      source_session_key: facts.source_session.external_session_id,
      external_agent_key: input.external_agent_key,
      task_id: input.task_id,
      created_at: input.created_at ?? facts.execution.last_seen_at,
      expires_at: input.expires_at,
    })
    return publishSemantic('registerIntent', result, {
      execution_id: facts.execution.id,
      task_id: result.intent.task_id,
      external_agent_key: result.intent.external_agent_key,
    })
  }

  async function correctAttribution(input) {
    const result = store.work.correctAttribution(input)
    return publishSemantic('correctAttribution', result, {
      segment_id: result.attribution.segment_id,
      task_id: result.attribution.task_id,
    })
  }

  async function assignSourceSessionProject(input) {
    const result = store.work.assignSourceSessionProject(input)
    await safeLog('attribution.corrected', {
      operation: 'source_session_project',
      source_session_id: result.source_session.id,
      project_id: result.project.id,
    })
    return publishSemantic('assignSourceSessionProject', result, {
      source_session_id: result.source_session.id,
      project_id: result.project.id,
    })
  }

  async function checkpoint(input) {
    const result = store.transaction(() => {
      const work = store.work.checkpoint(input)
      const facts = store.work.context({ execution_id: input.execution_id })
      const task = store.tasks.update({
        id: input.task_id,
        expected_revision: input.expected_revision,
        patch: { next_action: input.next_action },
        actor: input.actor ?? 'agent',
        source_session_id: facts.source_session.id,
      })
      return {
        execution: work.execution,
        segment: work.segment,
        attribution: work.attribution,
        task: task.task,
        changed: work.changed || task.changed,
      }
    })
    return publishSemantic('checkpoint', result, {
      execution_id: result.execution.id,
      task_id: result.task.id,
    })
  }

  async function mutateTask(input) {
    const action = input?.action
    const taskInput = input?.task
    if (!taskInput || typeof taskInput !== 'object' || Array.isArray(taskInput)) {
      throw new TaskRecorderError('TASK_INPUT_INVALID', 'task must be an object', {
        field: 'task',
      })
    }
    let result
    if (action === 'create') result = store.tasks.create(taskInput)
    else if (action === 'update') result = store.tasks.update(taskInput)
    else if (action === 'status') result = store.tasks.updateLifecycle(taskInput)
    else {
      throw new TaskRecorderError(
        'TASK_MUTATION_ACTION_INVALID',
        'action must be create, update, or status',
        { action },
      )
    }
    return publishSemantic(`task.${action}`, result, { task_id: result.task.id })
  }

  async function syncStructure(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new TaskRecorderError('TASK_INPUT_INVALID', 'input must be an object')
    }
    const projectId = input.project_id
    const mainInput = input.main_task
    const desiredChildren = input.children
    const expectedChildren = input.expected_children
    if (!mainInput || typeof mainInput !== 'object' || Array.isArray(mainInput)) {
      throw new TaskRecorderError('TASK_INPUT_INVALID', 'main_task must be an object', {
        field: 'main_task',
      })
    }
    if (!Array.isArray(desiredChildren) || !Array.isArray(expectedChildren)) {
      throw new TaskRecorderError(
        'TASK_INPUT_INVALID',
        'children and expected_children must be arrays',
      )
    }
    const ids = desiredChildren.map(({ id }) => id)
    if (new Set(ids).size !== ids.length) {
      throw new TaskRecorderError('TASK_INPUT_INVALID', 'children contains duplicate ids', {
        field: 'children',
      })
    }

    function patchFor(node, { parentId }) {
      const patch = { project_id: projectId, parent_id: parentId }
      for (const field of [
        'title',
        'description',
        'lifecycle',
        'status',
        'planned_start_at',
        'planned_due_at',
        'next_action',
        'sort_order',
      ]) {
        if (field in node) patch[field] = node[field]
      }
      return patch
    }

    const result = store.transaction(() => {
      const allBefore = store.tasks.list()
      const taskById = new Map(allBefore.map((task) => [task.id, task]))
      const existingMain = taskById.get(mainInput.id) ?? null
      const currentChildren = existingMain
        ? store.tasks.show(existingMain.id).children.filter((task) => (
          task.lifecycle !== 'canceled' && task.archived_at === null && task.deleted_at === null
        ))
        : []
      const expectedMap = new Map()
      for (const item of expectedChildren) {
        if (
          !item
          || typeof item.id !== 'string'
          || !Number.isInteger(item.revision)
          || item.revision < 1
          || expectedMap.has(item.id)
        ) {
          throw new TaskRecorderError(
            'TASK_INPUT_INVALID',
            'expected_children must contain unique id/revision pairs',
            { field: 'expected_children' },
          )
        }
        expectedMap.set(item.id, item.revision)
      }
      const actual = currentChildren
        .map(({ id, revision }) => ({ id, revision }))
        .sort((left, right) => left.id.localeCompare(right.id))
      const expected = [...expectedMap].map(([id, value]) => ({ id, revision: value }))
        .sort((left, right) => left.id.localeCompare(right.id))
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new TaskRecorderError(
          'TASK_STRUCTURE_CONFLICT',
          'direct child set or revision changed',
          { current_children: actual },
        )
      }

      let mainResult
      if (existingMain) {
        mainResult = store.tasks.update({
          id: mainInput.id,
          expected_revision: mainInput.expected_revision,
          patch: patchFor(mainInput, { parentId: null }),
          actor: input.actor,
          source_session_id: input.source_session_id,
        })
      } else {
        mainResult = store.tasks.create({
          ...mainInput,
          project_id: projectId,
          parent_id: null,
          actor: input.actor,
          source_session_id: input.source_session_id,
        })
      }

      const children = []
      let changed = mainResult.changed
      for (const child of desiredChildren) {
        const existing = taskById.get(child.id) ?? null
        let childResult
        if (existing) {
          childResult = store.tasks.update({
            id: child.id,
            expected_revision: child.expected_revision,
            patch: patchFor(child, { parentId: mainResult.task.id }),
            actor: input.actor,
            source_session_id: input.source_session_id,
          })
        } else {
          childResult = store.tasks.create({
            ...child,
            project_id: projectId,
            parent_id: mainResult.task.id,
            actor: input.actor,
            source_session_id: input.source_session_id,
          })
        }
        changed ||= childResult.changed
        children.push(childResult.task)
      }

      const desiredIds = new Set(desiredChildren.map(({ id }) => id))
      const removed = []
      for (const child of currentChildren) {
        if (desiredIds.has(child.id)) continue
        const removedResult = store.tasks.updateLifecycle({
          id: child.id,
          expected_revision: expectedMap.get(child.id),
          lifecycle: 'canceled',
          actor: input.actor,
          source_session_id: input.source_session_id,
        })
        changed ||= removedResult.changed
        removed.push(removedResult.task)
      }
      return {
        main_task: mainResult.task,
        children,
        removed,
        changed,
      }
    })
    return publishSemantic('syncStructure', result, {
      task_id: result.main_task.id,
      child_ids: result.children.map(({ id }) => id),
    })
  }

  return {
    ingestEvent,
    recover,
    workContext,
    focus,
    registerIntent,
    correctAttribution,
    assignSourceSessionProject,
    checkpoint,
    mutateTask,
    syncStructure,
  }
}
