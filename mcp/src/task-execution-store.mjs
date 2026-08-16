import { randomUUID } from 'node:crypto'

import { TaskRecorderError } from './errors.mjs'

function fail(code, message, details) {
  throw new TaskRecorderError(code, message, details)
}

function requiredString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    fail('EXECUTION_INPUT_INVALID', `${field} must be a non-empty string`, { field })
  }
  return value.trim()
}

function optionalString(value, field) {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string' || value.trim() === '') {
    fail('EXECUTION_INPUT_INVALID', `${field} must be null or a non-empty string`, { field })
  }
  return value.trim()
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function normalizeActor(value) {
  const actor = value ?? 'user'
  if (!['agent', 'user', 'hook', 'importer'].includes(actor)) {
    fail('EXECUTION_INPUT_INVALID', 'actor is invalid', { field: 'actor' })
  }
  return actor
}

function nowIso(clock) {
  const value = clock()
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.valueOf())) fail('CLOCK_INVALID', 'clock must return a valid date value')
  return date.toISOString()
}

function normalizeInstant(value, field, fallback) {
  if (value === undefined || value === null) {
    if (arguments.length >= 3) return fallback
    fail('EXECUTION_INPUT_INVALID', `${field} must be a valid instant`, { field })
  }
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    fail('EXECUTION_INPUT_INVALID', `${field} must be a valid instant`, { field })
  }
  return new Date(value).toISOString()
}

function normalizeImportStatus(value, field) {
  const status = requiredString(value, field)
  if (!['active', 'completed', 'interrupted', 'unknown'].includes(status)) {
    fail('EXECUTION_IMPORT_INVALID', `${field} is invalid`, { field })
  }
  return status
}

function normalizeImportRecord(value, index, rootSessionId) {
  const prefix = `records[${index}]`
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('EXECUTION_IMPORT_INVALID', `${prefix} must be an object`, { field: prefix })
  }
  const kind = requiredString(value.kind, `${prefix}.kind`)
  if (!['main', 'subagent'].includes(kind)) {
    fail('EXECUTION_IMPORT_INVALID', `${prefix}.kind is invalid`, { field: `${prefix}.kind` })
  }
  const recordRootSessionId = requiredString(
    value.root_session_id,
    `${prefix}.root_session_id`,
  )
  if (recordRootSessionId !== rootSessionId) {
    fail('EXECUTION_IMPORT_INVALID', `${prefix}.root_session_id does not match session_id`, {
      field: `${prefix}.root_session_id`,
    })
  }
  const turnId = optionalString(value.turn_id, `${prefix}.turn_id`)
  if (kind === 'main' && turnId === null) {
    fail('EXECUTION_IMPORT_INVALID', `${prefix}.turn_id is required for main executions`, {
      field: `${prefix}.turn_id`,
    })
  }
  const taskId = optionalString(value.task_id, `${prefix}.task_id`)
  const classification = requiredString(value.classification, `${prefix}.classification`)
  if (taskId !== null || classification !== 'unknown') {
    fail(
      'EXECUTION_IMPORT_INVALID',
      `${prefix} must not include a guessed Task assignment`,
      { field: `${prefix}.task_id` },
    )
  }
  const startedAt = normalizeInstant(value.started_at, `${prefix}.started_at`)
  const lastSeenAt = normalizeInstant(value.last_seen_at, `${prefix}.last_seen_at`)
  const endedAt = normalizeInstant(value.ended_at, `${prefix}.ended_at`, null)
  const status = normalizeImportStatus(value.status, `${prefix}.status`)
  if (Date.parse(lastSeenAt) < Date.parse(startedAt)) {
    fail('EXECUTION_IMPORT_INVALID', `${prefix}.last_seen_at precedes started_at`, { index })
  }
  if (endedAt !== null && Date.parse(endedAt) < Date.parse(startedAt)) {
    fail('EXECUTION_IMPORT_INVALID', `${prefix}.ended_at precedes started_at`, { index })
  }
  if (['completed', 'interrupted'].includes(status) && endedAt === null) {
    fail('EXECUTION_IMPORT_INVALID', `${prefix}.ended_at is required for terminal status`, { index })
  }
  if (['active', 'unknown'].includes(status) && endedAt !== null) {
    fail('EXECUTION_IMPORT_INVALID', `${prefix}.ended_at requires terminal status`, { index })
  }
  return {
    external_key: requiredString(value.external_key, `${prefix}.external_key`),
    kind,
    root_session_id: recordRootSessionId,
    session_id: requiredString(value.session_id, `${prefix}.session_id`),
    turn_id: turnId,
    agent_id: optionalString(value.agent_id, `${prefix}.agent_id`),
    agent_type: optionalString(value.agent_type, `${prefix}.agent_type`),
    agent_path: optionalString(value.agent_path, `${prefix}.agent_path`),
    parent_external_key: optionalString(
      value.parent_external_key,
      `${prefix}.parent_external_key`,
    ),
    transcript_path: optionalString(value.transcript_path, `${prefix}.transcript_path`),
    task_id: null,
    classification: 'unknown',
    workfolder: requiredString(value.workfolder, `${prefix}.workfolder`),
    git_root: optionalString(value.git_root, `${prefix}.git_root`),
    worktree: optionalString(value.worktree, `${prefix}.worktree`),
    branch: optionalString(value.branch, `${prefix}.branch`),
    status,
    started_at: startedAt,
    last_seen_at: lastSeenAt,
    ended_at: endedAt,
  }
}

export function createTaskExecutionStore({ db, clock = () => new Date(), transact }) {
  const selectByExternalKey = db.prepare('SELECT * FROM task_executions WHERE external_key = ?')
  const selectById = db.prepare('SELECT * FROM task_executions WHERE id = ?')
  const selectMainImportIdentity = db.prepare(`
    SELECT * FROM task_executions
    WHERE kind = 'main' AND root_session_id = ? AND session_id = ? AND turn_id = ?
    ORDER BY started_at, id
  `)
  const selectSubagentImportIdentity = db.prepare(`
    SELECT * FROM task_executions
    WHERE kind = 'subagent' AND root_session_id = ? AND session_id = ?
    ORDER BY started_at, id
  `)
  const selectImportTaskCandidates = db.prepare(`
    SELECT DISTINCT task_id FROM task_sessions
    WHERE session_id = ?
    ORDER BY task_id
  `)
  const selectTask = db.prepare('SELECT * FROM tasks WHERE id = ?')
  const selectAgentKeyCandidates = db.prepare(`
    SELECT * FROM tasks
    WHERE agent_key = ? AND deleted_at IS NULL AND (id = ? OR parent_id = ?)
    ORDER BY id
  `)
  const selectActiveMain = db.prepare(`
    SELECT * FROM task_executions
    WHERE root_session_id = ? AND session_id = ? AND turn_id = ?
      AND kind = 'main' AND status = 'active'
    ORDER BY started_at DESC, rowid DESC
    LIMIT 1
  `)
  const countTurnSegments = db.prepare(`
    SELECT COUNT(*) AS count FROM task_executions
    WHERE root_session_id = ? AND session_id = ? AND turn_id = ? AND kind = 'main'
  `)
  const selectActiveSession = db.prepare(`
    SELECT * FROM task_executions
    WHERE session_id = ? AND status = 'active'
    ORDER BY started_at DESC, rowid DESC
    LIMIT 1
  `)
  const selectActiveRootSession = db.prepare(`
    SELECT * FROM task_executions
    WHERE root_session_id = ? AND status = 'active'
    ORDER BY started_at, id
  `)
  const insertExecution = db.prepare(`
    INSERT INTO task_executions (
      id, external_key, task_id, kind, root_session_id, session_id, turn_id,
      agent_id, agent_type, agent_path, parent_execution_id, transcript_path,
      classification, workfolder, git_root, worktree, branch, status,
      started_at, last_seen_at, ended_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const bindExecution = db.prepare(`
    UPDATE task_executions
    SET task_id = ?, classification = 'work'
    WHERE id = ?
  `)
  const updateAssignment = db.prepare(`
    UPDATE task_executions
    SET task_id = ?, classification = ?
    WHERE id = ?
  `)
  const closeExecution = db.prepare(`
    UPDATE task_executions
    SET status = 'completed', last_seen_at = ?, ended_at = ?
    WHERE id = ?
  `)
  const stopExecution = db.prepare(`
    UPDATE task_executions
    SET status = ?, last_seen_at = ?, ended_at = ?
    WHERE id = ?
  `)
  const enrichExecution = db.prepare(`
    UPDATE task_executions
    SET
      session_id = COALESCE(?, session_id),
      agent_type = COALESCE(?, agent_type),
      agent_path = COALESCE(?, agent_path),
      transcript_path = COALESCE(?, transcript_path),
      workfolder = COALESCE(?, workfolder),
      git_root = COALESCE(?, git_root),
      worktree = COALESCE(?, worktree),
      branch = COALESCE(?, branch)
    WHERE id = ?
  `)
  const updateLastSeen = db.prepare(`
    UPDATE task_executions
    SET last_seen_at = ?
    WHERE id = ?
  `)
  const updateImportedExecution = db.prepare(`
    UPDATE task_executions
    SET
      task_id = ?,
      classification = ?,
      agent_id = ?,
      agent_type = ?,
      agent_path = ?,
      parent_execution_id = ?,
      transcript_path = ?,
      git_root = ?,
      worktree = ?,
      branch = ?,
      status = ?,
      last_seen_at = ?,
      ended_at = ?
    WHERE id = ?
  `)
  const selectObservation = db.prepare(`
    SELECT * FROM plan_observations WHERE external_key = ?
  `)
  const insertObservation = db.prepare(`
    INSERT INTO plan_observations (
      external_key, session_id, turn_id, plan_json, observed_at,
      reconciled_task_id, reconciled_revision, reconciled_at
    ) VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL)
  `)
  const selectPendingTurnObservations = db.prepare(`
    SELECT * FROM plan_observations
    WHERE session_id = ? AND turn_id = ? AND reconciled_at IS NULL
    ORDER BY observed_at, external_key
  `)
  const reconcileObservation = db.prepare(`
    UPDATE plan_observations
    SET reconciled_task_id = ?, reconciled_revision = ?, reconciled_at = ?
    WHERE external_key = ? AND reconciled_at IS NULL
  `)
  const insertTaskEvent = db.prepare(`
    INSERT INTO task_events (
      id, task_id, event_type, before_json, after_json, actor, source_session_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `)

  function insertExecutionRow(execution) {
    insertExecution.run(
      execution.id,
      execution.external_key,
      execution.task_id,
      execution.kind,
      execution.root_session_id,
      execution.session_id,
      execution.turn_id,
      execution.agent_id,
      execution.agent_type,
      execution.agent_path,
      execution.parent_execution_id,
      execution.transcript_path,
      execution.classification,
      execution.workfolder,
      execution.git_root,
      execution.worktree,
      execution.branch,
      execution.status,
      execution.started_at,
      execution.last_seen_at,
      execution.ended_at,
    )
  }

  function writeExecutionEvent({ taskId, eventType, before, after, actor, sourceSessionId, timestamp }) {
    insertTaskEvent.run(
      randomUUID(),
      taskId,
      eventType,
      before === null ? null : JSON.stringify(before),
      after === null ? null : JSON.stringify(after),
      actor,
      sourceSessionId,
      timestamp,
    )
  }

  function writeBoundEvent(execution, actor, timestamp) {
    writeExecutionEvent({
      taskId: execution.task_id,
      eventType: 'execution_bound',
      before: null,
      after: { execution_id: execution.id, task_id: execution.task_id },
      actor,
      sourceSessionId: execution.root_session_id,
      timestamp,
    })
  }

  function agentKeyFromPath(value) {
    if (typeof value !== 'string') return null
    const segments = value.split('/').map((segment) => segment.trim()).filter(Boolean)
    return segments.at(-1) ?? null
  }

  function resolveSubagentTaskId({ explicitTaskId, agentPath, parentExecutionId }) {
    if (explicitTaskId !== null) return explicitTaskId
    const agentKey = agentKeyFromPath(agentPath)
    if (agentKey === null || parentExecutionId === null) return null
    const parentExecution = selectById.get(parentExecutionId)
    const parentTask = parentExecution?.task_id ? selectTask.get(parentExecution.task_id) : null
    if (!parentTask) return null
    const rootId = parentTask.parent_id ?? parentTask.id
    const candidates = selectAgentKeyCandidates.all(agentKey, rootId, rootId)
    return candidates.length === 1 ? candidates[0].id : null
  }

  function turnStart(input) {
    const externalKey = requiredString(input.external_key, 'external_key')
    const rootSessionId = requiredString(input.root_session_id, 'root_session_id')
    const sessionId = requiredString(input.session_id, 'session_id')
    const turnId = requiredString(input.turn_id, 'turn_id')
    const timestamp = normalizeInstant(input.started_at, 'started_at', nowIso(clock))
    const execution = {
      id: randomUUID(),
      external_key: externalKey,
      task_id: null,
      kind: 'main',
      root_session_id: rootSessionId,
      session_id: sessionId,
      turn_id: turnId,
      agent_id: null,
      agent_type: optionalString(input.agent_type, 'agent_type'),
      agent_path: null,
      parent_execution_id: null,
      transcript_path: optionalString(input.transcript_path, 'transcript_path'),
      classification: 'unknown',
      workfolder: requiredString(input.workfolder, 'workfolder'),
      git_root: optionalString(input.git_root, 'git_root'),
      worktree: optionalString(input.worktree, 'worktree'),
      branch: optionalString(input.branch, 'branch'),
      status: 'active',
      started_at: timestamp,
      last_seen_at: timestamp,
      ended_at: null,
    }

    return transact(() => {
      const existing = selectByExternalKey.get(externalKey)
      if (existing) return { execution: existing, changed: false }
      insertExecutionRow(execution)
      return { execution: selectByExternalKey.get(externalKey), changed: true }
    })
  }

  function focusExecutionInTransaction(input) {
    const rootSessionId = requiredString(input.root_session_id, 'root_session_id')
    const sessionId = requiredString(input.session_id, 'session_id')
    const turnId = requiredString(input.turn_id, 'turn_id')
    const taskId = requiredString(input.task_id, 'task_id')
    const actor = normalizeActor(input.actor ?? 'agent')

    if (!selectTask.get(taskId)) fail('TASK_NOT_FOUND', `task ${taskId} does not exist`, { id: taskId })
    const active = selectActiveMain.get(rootSessionId, sessionId, turnId)
    if (!active) {
      fail('EXECUTION_NOT_ACTIVE', 'no active main execution exists for this turn', {
        root_session_id: rootSessionId,
        session_id: sessionId,
        turn_id: turnId,
      })
    }
    if (active.task_id === taskId && active.classification === 'work') {
      return { execution: active, previous_execution: null, changed: false }
    }

    const timestamp = nowIso(clock)
    if (active.task_id === null) {
      bindExecution.run(taskId, active.id)
      const bound = selectByExternalKey.get(active.external_key)
      writeBoundEvent(bound, actor, timestamp)
      return { execution: bound, previous_execution: null, changed: true }
    }

    closeExecution.run(timestamp, timestamp, active.id)
    const segment = countTurnSegments.get(rootSessionId, sessionId, turnId).count
    const execution = {
      ...active,
      id: randomUUID(),
      external_key: `internal:focus:${rootSessionId}:${turnId}:${segment}`,
      task_id: taskId,
      classification: 'work',
      status: 'active',
      started_at: timestamp,
      last_seen_at: timestamp,
      ended_at: null,
    }
    insertExecutionRow(execution)
    const created = selectByExternalKey.get(execution.external_key)
    writeBoundEvent(created, actor, timestamp)
    return {
      execution: created,
      previous_execution: selectByExternalKey.get(active.external_key),
      changed: true,
    }
  }

  function focusExecution(input) {
    return transact(() => focusExecutionInTransaction(input))
  }

  function subagentStart(input) {
    const externalKey = requiredString(input.external_key, 'external_key')
    const rootSessionId = requiredString(input.root_session_id, 'root_session_id')
    const sessionId = requiredString(input.session_id, 'session_id')
    const turnId = optionalString(input.turn_id, 'turn_id')
    const parentSessionId = optionalString(input.parent_session_id, 'parent_session_id')
      ?? rootSessionId
    const timestamp = normalizeInstant(input.started_at, 'started_at', nowIso(clock))

    return transact(() => {
      const existing = selectByExternalKey.get(externalKey)
      if (existing) return { execution: existing, changed: false }
      const explicitTaskId = optionalString(input.task_id, 'task_id')
      if (explicitTaskId !== null && !selectTask.get(explicitTaskId)) {
        fail('TASK_NOT_FOUND', `task ${explicitTaskId} does not exist`, { id: explicitTaskId })
      }
      const parentExecutionId = optionalString(input.parent_execution_id, 'parent_execution_id')
        ?? (turnId === null
          ? null
          : selectActiveMain.get(rootSessionId, parentSessionId, turnId)?.id ?? null)
      const agentPath = optionalString(input.agent_path, 'agent_path')
      const taskId = resolveSubagentTaskId({ explicitTaskId, agentPath, parentExecutionId })
      const execution = {
        id: randomUUID(),
        external_key: externalKey,
        task_id: taskId,
        kind: 'subagent',
        root_session_id: rootSessionId,
        session_id: sessionId,
        turn_id: turnId,
        agent_id: optionalString(input.agent_id, 'agent_id'),
        agent_type: optionalString(input.agent_type, 'agent_type'),
        agent_path: agentPath,
        parent_execution_id: parentExecutionId,
        transcript_path: optionalString(input.transcript_path, 'transcript_path'),
        classification: taskId === null ? 'unknown' : 'work',
        workfolder: requiredString(input.workfolder, 'workfolder'),
        git_root: optionalString(input.git_root, 'git_root'),
        worktree: optionalString(input.worktree, 'worktree'),
        branch: optionalString(input.branch, 'branch'),
        status: 'active',
        started_at: timestamp,
        last_seen_at: timestamp,
        ended_at: null,
      }
      insertExecutionRow(execution)
      const created = selectByExternalKey.get(externalKey)
      if (created.task_id !== null) {
        writeBoundEvent(created, normalizeActor(input.actor ?? 'hook'), timestamp)
      }
      return { execution: created, changed: true }
    })
  }

  function subagentStop(input) {
    const externalKey = requiredString(input.external_key, 'external_key')
    if (input.interrupted !== undefined && typeof input.interrupted !== 'boolean') {
      fail('EXECUTION_INPUT_INVALID', 'interrupted must be a boolean', { field: 'interrupted' })
    }
    const enrichment = {
      session_id: optionalString(input.session_id, 'session_id'),
      agent_type: optionalString(input.agent_type, 'agent_type'),
      agent_path: optionalString(input.agent_path, 'agent_path'),
      transcript_path: optionalString(input.transcript_path, 'transcript_path'),
      workfolder: optionalString(input.workfolder, 'workfolder'),
      git_root: optionalString(input.git_root, 'git_root'),
      worktree: optionalString(input.worktree, 'worktree'),
      branch: optionalString(input.branch, 'branch'),
    }
    const actor = normalizeActor(input.actor ?? 'hook')
    return transact(() => {
      const existing = selectByExternalKey.get(externalKey)
      if (!existing || existing.kind !== 'subagent') {
        fail('EXECUTION_NOT_FOUND', `subagent execution ${externalKey} does not exist`, {
          external_key: externalKey,
        })
      }
      const enrichmentChanged = Object.entries(enrichment).some(([field, value]) => (
        value !== null && existing[field] !== value
      ))
      if (enrichmentChanged) {
        enrichExecution.run(
          enrichment.session_id,
          enrichment.agent_type,
          enrichment.agent_path,
          enrichment.transcript_path,
          enrichment.workfolder,
          enrichment.git_root,
          enrichment.worktree,
          enrichment.branch,
          existing.id,
        )
      }
      const enriched = selectByExternalKey.get(externalKey)
      const autoTaskId = resolveSubagentTaskId({
        explicitTaskId: enriched.task_id,
        agentPath: enriched.agent_path,
        parentExecutionId: enriched.parent_execution_id,
      })
      const bindingChanged = enriched.task_id === null && autoTaskId !== null
      if (bindingChanged) {
        bindExecution.run(autoTaskId, enriched.id)
        writeBoundEvent(selectByExternalKey.get(externalKey), actor, nowIso(clock))
      }
      if (existing.status === 'active') {
        const timestamp = normalizeInstant(input.ended_at, 'ended_at', nowIso(clock))
        if (Date.parse(timestamp) < Date.parse(existing.started_at)) {
          fail('EXECUTION_TIME_INVALID', 'ended_at cannot precede started_at', {
            external_key: externalKey,
          })
        }
        stopExecution.run(input.interrupted ? 'interrupted' : 'completed', timestamp, timestamp, existing.id)
      }
      return {
        execution: selectByExternalKey.get(externalKey),
        changed: enrichmentChanged || bindingChanged || existing.status === 'active',
      }
    })
  }

  function sessionEnd(input) {
    const rootSessionId = requiredString(input.root_session_id, 'root_session_id')
    if (input.interrupted !== undefined && typeof input.interrupted !== 'boolean') {
      fail('EXECUTION_INPUT_INVALID', 'interrupted must be a boolean', { field: 'interrupted' })
    }
    const timestamp = normalizeInstant(input.ended_at, 'ended_at', nowIso(clock))
    return transact(() => {
      const active = selectActiveRootSession.all(rootSessionId)
      if (active.length === 0) return { executions: [], changed: false }
      const invalid = active.find((execution) => Date.parse(timestamp) < Date.parse(execution.started_at))
      if (invalid) {
        fail('EXECUTION_TIME_INVALID', 'ended_at cannot precede started_at', {
          execution_id: invalid.id,
        })
      }
      const status = input.interrupted ? 'interrupted' : 'completed'
      for (const execution of active) {
        stopExecution.run(status, timestamp, timestamp, execution.id)
      }
      return {
        executions: active.map(({ id }) => selectById.get(id)),
        changed: true,
      }
    })
  }

  function normalizePlan(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      fail('PLAN_OBSERVATION_INVALID', 'plan must be an object')
    }
    if (!Array.isArray(value.plan)) {
      fail('PLAN_OBSERVATION_INVALID', 'plan.plan must be an array')
    }
    const plan = value.plan.map((item, index) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        fail('PLAN_OBSERVATION_INVALID', 'plan item must be an object', { index })
      }
      return {
        step: requiredString(item.step, `plan[${index}].step`),
        status: requiredString(item.status, `plan[${index}].status`),
      }
    })
    const explanation = optionalString(value.explanation, 'plan.explanation')
    return { ...(explanation === null ? {} : { explanation }), plan }
  }

  function toolUse(input) {
    const externalKey = requiredString(input.external_key, 'external_key')
    const rootSessionId = requiredString(input.root_session_id, 'root_session_id')
    const sessionId = requiredString(input.session_id, 'session_id')
    const turnId = optionalString(input.turn_id, 'turn_id')
    const toolName = requiredString(input.tool_name, 'tool_name')
    const timestamp = normalizeInstant(input.occurred_at, 'occurred_at', nowIso(clock))

    return transact(() => {
      const active = turnId === null
        ? selectActiveSession.get(sessionId)
        : selectActiveMain.get(rootSessionId, sessionId, turnId)
          ?? selectActiveSession.get(sessionId)
      if (!active) {
        fail('EXECUTION_NOT_ACTIVE', 'no active execution exists for this tool use', {
          session_id: sessionId,
          turn_id: turnId,
        })
      }

      const observesPlan = toolName === 'update_plan' || toolName.endsWith('__update_plan')
      if (observesPlan) {
        const existingObservation = selectObservation.get(externalKey)
        if (existingObservation) {
          return { execution: active, observation: existingObservation, changed: false }
        }
      }

      let execution = active
      let changed = false
      if (Date.parse(timestamp) > Date.parse(active.last_seen_at)) {
        updateLastSeen.run(timestamp, active.id)
        execution = selectByExternalKey.get(active.external_key)
        changed = true
      }

      let observation = null
      if (observesPlan) {
        const planJson = JSON.stringify(normalizePlan(input.plan))
        if (turnId === null) {
          fail('PLAN_OBSERVATION_INVALID', 'update_plan requires turn_id')
        }
        insertObservation.run(externalKey, sessionId, turnId, planJson, timestamp)
        observation = selectObservation.get(externalKey)
        changed = true
      }
      return { execution, observation, changed }
    })
  }

  function listPlanObservations(filters = {}) {
    const clauses = []
    const parameters = []
    for (const [field, value] of [
      ['session_id', filters.session_id],
      ['turn_id', filters.turn_id],
    ]) {
      if (value !== undefined && value !== null) {
        clauses.push(`${field} = ?`)
        parameters.push(value)
      }
    }
    if (filters.pending === true || filters.pending === 'true') clauses.push('reconciled_at IS NULL')
    const where = clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`
    return db.prepare(`
      SELECT * FROM plan_observations
      ${where}
      ORDER BY observed_at, external_key
    `).all(...parameters)
  }

  function reconcilePlanObservationsInTransaction(input) {
    const sessionId = requiredString(input.session_id, 'session_id')
    const turnId = requiredString(input.turn_id, 'turn_id')
    const taskId = requiredString(input.task_id, 'task_id')
    if (!Number.isInteger(input.revision) || input.revision < 1) {
      fail('EXECUTION_INPUT_INVALID', 'revision must be a positive integer', {
        field: 'revision',
      })
    }
    const timestamp = normalizeInstant(input.reconciled_at, 'reconciled_at', nowIso(clock))
    const pending = selectPendingTurnObservations.all(sessionId, turnId)
    for (const observation of pending) {
      reconcileObservation.run(taskId, input.revision, timestamp, observation.external_key)
    }
    return pending.map(({ external_key: externalKey }) => externalKey)
  }

  function assignExecution(input) {
    const id = requiredString(input.id, 'id')
    if (!hasOwn(input, 'expected_task_id')) {
      fail('EXECUTION_INPUT_INVALID', 'expected_task_id is required', {
        field: 'expected_task_id',
      })
    }
    const expectedTaskId = optionalString(input.expected_task_id, 'expected_task_id')
    const taskId = optionalString(input.task_id, 'task_id')
    const actor = normalizeActor(input.actor)

    return transact(() => {
      const existing = selectById.get(id)
      if (!existing) fail('EXECUTION_NOT_FOUND', `execution ${id} does not exist`, { id })
      if (existing.task_id !== expectedTaskId) {
        fail('EXECUTION_ASSIGNMENT_CONFLICT', `execution ${id} assignment changed`, {
          id,
          expected_task_id: expectedTaskId,
          actual_task_id: existing.task_id,
        })
      }
      if (taskId !== null && !selectTask.get(taskId)) {
        fail('TASK_NOT_FOUND', `task ${taskId} does not exist`, { id: taskId })
      }
      const classification = taskId === null ? 'unknown' : 'work'
      if (existing.task_id === taskId && existing.classification === classification) {
        return { execution: existing, changed: false }
      }

      const timestamp = nowIso(clock)
      if (existing.task_id !== null && existing.task_id !== taskId) {
        writeExecutionEvent({
          taskId: existing.task_id,
          eventType: 'execution_unbound',
          before: { execution_id: id, task_id: existing.task_id },
          after: { execution_id: id, task_id: null },
          actor,
          sourceSessionId: existing.root_session_id,
          timestamp,
        })
      }
      updateAssignment.run(taskId, classification, id)
      const updated = selectById.get(id)
      if (taskId !== null && existing.task_id !== taskId) writeBoundEvent(updated, actor, timestamp)
      return { execution: updated, changed: true }
    })
  }

  function classifyExecution(input) {
    const id = requiredString(input.id, 'id')
    const classification = requiredString(input.classification, 'classification')
    const expectedClassification = requiredString(
      input.expected_classification,
      'expected_classification',
    )
    if (!['unknown', 'work', 'non_work'].includes(classification)) {
      fail('EXECUTION_INPUT_INVALID', 'classification is invalid', { field: 'classification' })
    }
    if (!hasOwn(input, 'expected_task_id')) {
      fail('EXECUTION_INPUT_INVALID', 'expected_task_id is required', {
        field: 'expected_task_id',
      })
    }
    const expectedTaskId = optionalString(input.expected_task_id, 'expected_task_id')
    const actor = normalizeActor(input.actor)

    return transact(() => {
      const existing = selectById.get(id)
      if (!existing) fail('EXECUTION_NOT_FOUND', `execution ${id} does not exist`, { id })
      if (
        existing.classification !== expectedClassification
        || existing.task_id !== expectedTaskId
      ) {
        fail('EXECUTION_CLASSIFICATION_CONFLICT', `execution ${id} classification changed`, {
          id,
          expected_classification: expectedClassification,
          actual_classification: existing.classification,
          expected_task_id: expectedTaskId,
          actual_task_id: existing.task_id,
        })
      }
      if (classification === 'work' && existing.task_id === null) {
        fail('EXECUTION_INPUT_INVALID', 'work classification requires an assigned task', {
          field: 'classification',
        })
      }
      const taskId = classification === 'work' ? existing.task_id : null
      if (existing.classification === classification && existing.task_id === taskId) {
        return { execution: existing, changed: false }
      }

      const timestamp = nowIso(clock)
      if (existing.task_id !== null && taskId === null) {
        writeExecutionEvent({
          taskId: existing.task_id,
          eventType: 'execution_unbound',
          before: { execution_id: id, task_id: existing.task_id },
          after: { execution_id: id, task_id: null },
          actor,
          sourceSessionId: existing.root_session_id,
          timestamp,
        })
      }
      updateAssignment.run(taskId, classification, id)
      return { execution: selectById.get(id), changed: true }
    })
  }

  function updateExecutionAssignments(input) {
    if (!Array.isArray(input.changes) || input.changes.length === 0) {
      fail('EXECUTION_INPUT_INVALID', 'changes must be a non-empty array', { field: 'changes' })
    }
    if (input.changes.length > 500) {
      fail('EXECUTION_INPUT_INVALID', 'changes must contain at most 500 items', { field: 'changes' })
    }
    const actor = normalizeActor(input.actor)
    const seen = new Set()
    const changes = input.changes.map((change, index) => {
      if (!change || typeof change !== 'object' || Array.isArray(change)) {
        fail('EXECUTION_INPUT_INVALID', 'change must be an object', { field: `changes[${index}]` })
      }
      const id = requiredString(change.id, `changes[${index}].id`)
      if (seen.has(id)) {
        fail('EXECUTION_INPUT_INVALID', `execution ${id} appears more than once`, {
          field: `changes[${index}].id`, id,
        })
      }
      seen.add(id)
      for (const field of ['expected_task_id', 'expected_classification', 'task_id', 'classification']) {
        if (!hasOwn(change, field)) {
          fail('EXECUTION_INPUT_INVALID', `${field} is required`, {
            field: `changes[${index}].${field}`,
          })
        }
      }
      const expectedTaskId = optionalString(change.expected_task_id, 'expected_task_id')
      const expectedClassification = requiredString(
        change.expected_classification,
        'expected_classification',
      )
      const taskId = optionalString(change.task_id, 'task_id')
      const classification = requiredString(change.classification, 'classification')
      if (!['unknown', 'work', 'non_work'].includes(expectedClassification)) {
        fail('EXECUTION_INPUT_INVALID', 'expected_classification is invalid', {
          field: `changes[${index}].expected_classification`,
        })
      }
      if (!['unknown', 'work', 'non_work'].includes(classification)) {
        fail('EXECUTION_INPUT_INVALID', 'classification is invalid', {
          field: `changes[${index}].classification`,
        })
      }
      if ((classification === 'work') !== (taskId !== null)) {
        fail('EXECUTION_INPUT_INVALID', 'work requires task_id; unknown/non_work require null', {
          field: `changes[${index}].task_id`,
        })
      }
      return { id, expectedTaskId, expectedClassification, taskId, classification }
    })

    return transact(() => {
      const candidates = changes.map((change) => {
        const execution = selectById.get(change.id)
        if (!execution) {
          fail('EXECUTION_NOT_FOUND', `execution ${change.id} does not exist`, { id: change.id })
        }
        if (change.taskId !== null && !selectTask.get(change.taskId)) {
          fail('TASK_NOT_FOUND', `task ${change.taskId} does not exist`, { id: change.taskId })
        }
        return { change, execution }
      })
      const conflicts = candidates
        .filter(({ change, execution }) => (
          execution.task_id !== change.expectedTaskId
          || execution.classification !== change.expectedClassification
        ))
        .map(({ change, execution }) => ({
          id: change.id,
          expected_task_id: change.expectedTaskId,
          actual_task_id: execution.task_id,
          expected_classification: change.expectedClassification,
          actual_classification: execution.classification,
        }))
      if (conflicts.length > 0) {
        fail('EXECUTION_BATCH_CONFLICT', 'one or more execution assignments changed', { conflicts })
      }

      const timestamp = nowIso(clock)
      let changedCount = 0
      const executions = candidates.map(({ change, execution }) => {
        if (
          execution.task_id === change.taskId
          && execution.classification === change.classification
        ) return execution
        if (execution.task_id !== null && execution.task_id !== change.taskId) {
          writeExecutionEvent({
            taskId: execution.task_id,
            eventType: 'execution_unbound',
            before: { execution_id: execution.id, task_id: execution.task_id },
            after: { execution_id: execution.id, task_id: null },
            actor,
            sourceSessionId: execution.root_session_id,
            timestamp,
          })
        }
        updateAssignment.run(change.taskId, change.classification, execution.id)
        const updated = selectById.get(execution.id)
        if (change.taskId !== null && execution.task_id !== change.taskId) {
          writeBoundEvent(updated, actor, timestamp)
        }
        changedCount += 1
        return updated
      })
      return {
        executions,
        changed_count: changedCount,
        changed: changedCount > 0,
      }
    })
  }

  function importExecutions(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      fail('EXECUTION_IMPORT_INVALID', 'import input must be an object')
    }
    const source = requiredString(input.source, 'source')
    const rootSessionId = requiredString(input.session_id, 'session_id')
    if (typeof input.dry_run !== 'boolean') {
      fail('EXECUTION_IMPORT_INVALID', 'dry_run must be a boolean', { field: 'dry_run' })
    }
    if (!Array.isArray(input.records) || input.records.length === 0) {
      fail('EXECUTION_IMPORT_INVALID', 'records must be a non-empty array', { field: 'records' })
    }
    if (input.records.length > 10_000) {
      fail('EXECUTION_IMPORT_INVALID', 'records must contain at most 10000 items', {
        field: 'records',
      })
    }
    const records = input.records.map((record, index) => (
      normalizeImportRecord(record, index, rootSessionId)
    ))
    const externalKeys = new Set()
    const identities = new Set()
    for (const record of records) {
      if (externalKeys.has(record.external_key)) {
        fail('EXECUTION_IMPORT_INVALID', 'external_key values must be unique', {
          external_key: record.external_key,
        })
      }
      externalKeys.add(record.external_key)
      const identity = record.kind === 'main'
        ? `main:${record.root_session_id}:${record.session_id}:${record.turn_id}`
        : `subagent:${record.root_session_id}:${record.session_id}`
      if (identities.has(identity)) {
        fail('EXECUTION_IMPORT_INVALID', 'execution identities must be unique', { identity })
      }
      identities.add(identity)
    }
    const recordsByExternalKey = new Map(records.map((record) => [record.external_key, record]))
    for (const record of records) {
      if (record.parent_external_key === null) continue
      if (record.kind !== 'subagent') {
        fail('EXECUTION_IMPORT_INVALID', 'only subagent executions may have a parent', {
          parent_external_key: record.parent_external_key,
        })
      }
      const parent = recordsByExternalKey.get(record.parent_external_key)
        ?? selectByExternalKey.get(record.parent_external_key)
      if (!parent) {
        fail('EXECUTION_IMPORT_INVALID', 'parent_external_key does not resolve', {
          parent_external_key: record.parent_external_key,
        })
      }
      if (parent.kind !== 'main' || parent.root_session_id !== rootSessionId) {
        fail(
          'EXECUTION_IMPORT_INVALID',
          'parent_external_key must resolve to a main execution in the same root session',
          { parent_external_key: record.parent_external_key },
        )
      }
    }

    function existingFor(record) {
      const byExternalKey = selectByExternalKey.get(record.external_key)
      if (byExternalKey) return byExternalKey
      const candidates = record.kind === 'main'
        ? selectMainImportIdentity.all(
          record.root_session_id,
          record.session_id,
          record.turn_id,
        )
        : selectSubagentImportIdentity.all(record.root_session_id, record.session_id)
      if (candidates.length > 1) {
        fail('EXECUTION_IMPORT_CONFLICT', 'execution identity resolves to multiple rows', {
          external_key: record.external_key,
          count: candidates.length,
        })
      }
      return candidates[0] ?? null
    }

    function taskBinding(record, existing) {
      if (existing?.task_id) {
        return { task_id: existing.task_id, classification: existing.classification }
      }
      const candidates = selectImportTaskCandidates.all(record.session_id)
      return candidates.length === 1
        ? { task_id: candidates[0].task_id, classification: 'work' }
        : { task_id: null, classification: 'unknown' }
    }

    function targetFor(record, existing, parentExecutionId) {
      const binding = taskBinding(record, existing)
      if (!existing) {
        return {
          ...record,
          ...binding,
          id: randomUUID(),
          parent_execution_id: parentExecutionId,
        }
      }
      for (const field of ['kind', 'root_session_id', 'session_id', 'turn_id']) {
        if (existing[field] !== record[field]) {
          fail('EXECUTION_IMPORT_CONFLICT', `execution ${record.external_key} changed identity`, {
            external_key: record.external_key,
            field,
            expected: existing[field],
            actual: record[field],
          })
        }
      }
      if (
        ['completed', 'interrupted'].includes(existing.status)
        && ['completed', 'interrupted'].includes(record.status)
        && existing.status !== record.status
      ) {
        fail('EXECUTION_IMPORT_CONFLICT', `execution ${record.external_key} has conflicting status`, {
          external_key: record.external_key,
          expected: existing.status,
          actual: record.status,
        })
      }
      const importedTerminal = ['completed', 'interrupted'].includes(record.status)
      const status = ['active', 'unknown'].includes(existing.status) && importedTerminal
        ? record.status
        : existing.status
      const endedAt = existing.ended_at ?? (importedTerminal ? record.ended_at : null)
      const lastSeenAt = Date.parse(record.last_seen_at) > Date.parse(existing.last_seen_at)
        ? record.last_seen_at
        : existing.last_seen_at
      return {
        ...existing,
        ...binding,
        agent_id: existing.agent_id ?? record.agent_id,
        agent_type: existing.agent_type ?? record.agent_type,
        agent_path: existing.agent_path ?? record.agent_path,
        parent_execution_id: existing.parent_execution_id ?? parentExecutionId,
        transcript_path: existing.transcript_path ?? record.transcript_path,
        git_root: existing.git_root ?? record.git_root,
        worktree: existing.worktree ?? record.worktree,
        branch: existing.branch ?? record.branch,
        status,
        last_seen_at: lastSeenAt,
        ended_at: endedAt,
      }
    }

    function changedFields(existing, target) {
      if (!existing) return ['created']
      return [
        'task_id', 'classification', 'agent_id', 'agent_type', 'agent_path',
        'parent_execution_id', 'transcript_path', 'git_root', 'worktree', 'branch',
        'status', 'last_seen_at', 'ended_at',
      ].filter((field) => existing[field] !== target[field])
    }

    return transact(() => {
      const existingByInputKey = new Map()
      for (const record of records) existingByInputKey.set(record.external_key, existingFor(record))
      const idByExternalKey = new Map([...existingByInputKey].flatMap(([externalKey, existing]) => (
        existing ? [[externalKey, existing.id]] : []
      )))
      const ordered = [...records].sort((left, right) => (
        Number(left.kind === 'subagent') - Number(right.kind === 'subagent')
        || left.started_at.localeCompare(right.started_at)
        || left.external_key.localeCompare(right.external_key)
      ))
      const actions = []
      for (const record of ordered) {
        const existing = existingByInputKey.get(record.external_key)
        const parentExecutionId = record.parent_external_key === null
          ? null
          : idByExternalKey.get(record.parent_external_key)
            ?? selectByExternalKey.get(record.parent_external_key)?.id
            ?? null
        const target = targetFor(record, existing, parentExecutionId)
        const fields = changedFields(existing, target)
        actions.push({ record, existing, target, fields })
        idByExternalKey.set(record.external_key, target.id)
      }
      const wouldCreate = actions.filter(({ existing }) => existing === null).length
      const wouldUpdate = actions.filter(({ existing, fields }) => existing !== null && fields.length > 0).length
      const skipped = actions.length - wouldCreate - wouldUpdate
      const unassigned = actions.filter(({ target }) => (
        target.task_id === null && target.classification !== 'non_work'
      )).length
      const summary = {
        source,
        session_id: rootSessionId,
        dry_run: input.dry_run,
        root_turns: records.filter(({ kind }) => kind === 'main').length,
        subagent_executions: records.filter(({ kind }) => kind === 'subagent').length,
        would_create: input.dry_run ? wouldCreate : 0,
        would_update: input.dry_run ? wouldUpdate : 0,
        created: 0,
        updated: 0,
        skipped,
        unassigned,
        changed: false,
      }
      if (input.dry_run) return summary

      for (const { record, existing, target, fields } of actions) {
        if (!existing) {
          insertExecutionRow(target)
          if (target.task_id !== null) {
            writeBoundEvent(selectById.get(target.id), 'importer', target.started_at)
          }
          summary.created += 1
          continue
        }
        if (fields.length === 0) continue
        updateImportedExecution.run(
          target.task_id,
          target.classification,
          target.agent_id,
          target.agent_type,
          target.agent_path,
          target.parent_execution_id,
          target.transcript_path,
          target.git_root,
          target.worktree,
          target.branch,
          target.status,
          target.last_seen_at,
          target.ended_at,
          existing.id,
        )
        if (existing.task_id === null && target.task_id !== null) {
          writeBoundEvent(selectById.get(existing.id), 'importer', target.started_at)
        }
        summary.updated += 1
      }
      summary.changed = summary.created > 0 || summary.updated > 0
      return summary
    })
  }

  function sessionContext(value) {
    const rootSessionId = requiredString(
      typeof value === 'string' ? value : value?.root_session_id ?? value?.session_id,
      'root_session_id',
    )
    const executions = listExecutions({ root_session_id: rootSessionId })
    const activeExecutions = executions.filter(({ status }) => status === 'active')
    const unassignedExecutions = executions.filter(({ task_id: taskId, classification }) => (
      taskId === null && classification !== 'non_work'
    ))
    const pendingPlanObservations = listPlanObservations({
      session_id: rootSessionId,
      pending: true,
    })
    return {
      root_session_id: rootSessionId,
      execution_count: executions.length,
      active_execution_count: activeExecutions.length,
      unassigned_execution_count: unassignedExecutions.length,
      pending_plan_observation_count: pendingPlanObservations.length,
      active_executions: activeExecutions,
      unassigned_executions: unassignedExecutions,
      pending_plan_observations: pendingPlanObservations,
    }
  }

  function sessionStart(input) {
    return { changed: false, context: sessionContext(input) }
  }

  function listExecutions(filters = {}) {
    const clauses = []
    const parameters = []
    for (const [field, value] of [
      ['task_id', filters.task_id],
      ['root_session_id', filters.root_session_id],
      ['session_id', filters.session_id],
      ['status', filters.status],
    ]) {
      if (value !== undefined && value !== null) {
        clauses.push(`${field} = ?`)
        parameters.push(value)
      }
    }
    if (filters.unassigned === true || filters.unassigned === 'true') {
      clauses.push("task_id IS NULL AND classification != 'non_work'")
    }
    const where = clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`
    return db.prepare(`
      SELECT * FROM task_executions
      ${where}
      ORDER BY started_at, id
    `).all(...parameters)
  }

  return {
    turnStart,
    sessionStart,
    focusExecution,
    subagentStart,
    subagentStop,
    sessionEnd,
    toolUse,
    assignExecution,
    classifyExecution,
    updateExecutionAssignments,
    importExecutions,
    listExecutions,
    listPlanObservations,
    sessionContext,
    focusExecutionInTransaction,
    reconcilePlanObservationsInTransaction,
  }
}
