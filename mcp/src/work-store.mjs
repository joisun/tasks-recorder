import { createHash, randomUUID } from 'node:crypto'

import { TaskRecorderError } from './errors.mjs'

const EXECUTION_KINDS = new Set(['main', 'subagent'])
const ACCEPTED_PROVENANCE = new Set([
  'user',
  'agent_explicit',
  'spawn_intent',
  'current_focus',
  'migration',
])

function fail(code, message, details) {
  throw new TaskRecorderError(code, message, details)
}

function requiredString(value, field, code = 'WORK_INPUT_INVALID') {
  if (typeof value !== 'string' || value.trim() === '') {
    fail(code, `${field} must be a non-empty string`, { field })
  }
  return value.trim()
}

function optionalString(value, field) {
  if (value === null || value === undefined) return null
  return requiredString(value, field)
}

function normalizedInstant(value, field, fallback) {
  const source = value ?? fallback
  const date = source instanceof Date ? source : new Date(source)
  if (Number.isNaN(date.valueOf())) {
    fail('WORK_INPUT_INVALID', `${field} must be a valid instant`, { field })
  }
  return date.toISOString()
}

function nowIso(clock) {
  return normalizedInstant(clock(), 'clock')
}

function stableId(prefix, value) {
  const suffix = createHash('sha256').update(value).digest('hex').slice(0, 24)
  return `${prefix}-${suffix}`
}

function plainPayload(value) {
  if (value === undefined || value === null) return '{}'
  if (typeof value !== 'object' || Array.isArray(value)) {
    fail('WORK_INPUT_INVALID', 'payload must be an object', { field: 'payload' })
  }
  return JSON.stringify(Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => left.localeCompare(right)),
  ))
}

function defaultTransaction(db, operation) {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = operation()
    db.exec('COMMIT')
    return result
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export function createWorkStore({ db, clock = () => new Date(), transact } = {}) {
  if (!db || typeof db.prepare !== 'function') {
    throw new TypeError('db must be a node:sqlite DatabaseSync')
  }
  const transaction = transact ?? ((operation) => defaultTransaction(db, operation))

  const selectProject = db.prepare('SELECT * FROM projects WHERE id = ?')
  const selectTask = db.prepare('SELECT * FROM tasks WHERE id = ? AND deleted_at IS NULL')
  const selectSourceSession = db.prepare(`
    SELECT * FROM source_sessions WHERE source = ? AND external_session_id = ?
  `)
  const selectSourceSessionById = db.prepare('SELECT * FROM source_sessions WHERE id = ?')
  const insertSourceSession = db.prepare(`
    INSERT INTO source_sessions (
      id, source, external_session_id, root_external_session_id, project_id,
      first_seen_at, last_seen_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `)
  const updateSourceSession = db.prepare(`
    UPDATE source_sessions
    SET root_external_session_id = COALESCE(root_external_session_id, ?),
        project_id = COALESCE(project_id, ?),
        last_seen_at = ?
    WHERE id = ?
  `)
  const updateSourceSessionProject = db.prepare(`
    UPDATE source_sessions SET project_id = ? WHERE id = ? AND project_id IS NULL
  `)
  const setSourceSessionProject = db.prepare(`
    UPDATE source_sessions SET project_id = ? WHERE id = ?
  `)
  const selectAttributedProjectIds = db.prepare(`
    SELECT DISTINCT task.project_id
    FROM executions execution
    JOIN work_segments segment ON segment.execution_id = execution.id
    JOIN segment_attributions attribution ON attribution.segment_id = segment.id
    JOIN tasks task ON task.id = attribution.task_id
    WHERE execution.source_session_id = ?
      AND attribution.accepted_at IS NOT NULL
      AND attribution.rejected_at IS NULL
      AND attribution.superseded_at IS NULL
    ORDER BY task.project_id
  `)

  const selectObservation = db.prepare(`
    SELECT * FROM observations WHERE source = ? AND external_event_id = ?
  `)
  const insertObservation = db.prepare(`
    INSERT INTO observations (
      id, source, external_event_id, event_type, observed_at, source_session_id,
      source_turn_key, source_agent_key, workfolder, git_root, git_common_dir,
      git_remote, worktree, branch, payload_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)

  const selectExecution = db.prepare('SELECT * FROM executions WHERE id = ?')
  const insertExecution = db.prepare(`
    INSERT INTO executions (
      id, source_session_id, source_turn_key, source_agent_key, parent_execution_id,
      kind, classification, workfolder, git_root, git_common_dir, git_remote,
      worktree, branch, started_at, ended_at, last_seen_at, end_reason,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'unknown', ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?)
  `)
  const updateExecutionSeen = db.prepare(`
    UPDATE executions SET last_seen_at = ?, updated_at = ? WHERE id = ?
  `)
  const updateExecutionClassification = db.prepare(`
    UPDATE executions SET classification = ?, updated_at = ? WHERE id = ?
  `)
  const closeExecution = db.prepare(`
    UPDATE executions
    SET ended_at = ?, last_seen_at = ?, end_reason = ?, updated_at = ?
    WHERE id = ?
  `)
  const selectOpenExecutionsForSourceSession = db.prepare(`
    SELECT execution.*
    FROM executions execution
    JOIN source_sessions session ON session.id = execution.source_session_id
    WHERE session.source = ? AND session.external_session_id = ?
      AND execution.ended_at IS NULL
    ORDER BY execution.started_at, execution.id
  `)
  const selectOpenExecutionsWithSession = db.prepare(`
    SELECT
      execution.*,
      session.source AS session_source,
      session.external_session_id AS external_session_id
    FROM executions execution
    JOIN source_sessions session ON session.id = execution.source_session_id
    WHERE execution.ended_at IS NULL
    ORDER BY execution.started_at, execution.id
  `)

  const selectOpenSegment = db.prepare(`
    SELECT * FROM work_segments
    WHERE execution_id = ? AND ended_at IS NULL
    ORDER BY started_at DESC, id DESC
    LIMIT 1
  `)
  const selectLatestSegment = db.prepare(`
    SELECT * FROM work_segments
    WHERE execution_id = ?
    ORDER BY started_at DESC, id DESC
    LIMIT 1
  `)
  const selectSegment = db.prepare('SELECT * FROM work_segments WHERE id = ?')
  const insertSegment = db.prepare(`
    INSERT INTO work_segments (
      id, execution_id, started_at, ended_at, last_seen_at, close_reason,
      summary, created_at, updated_at
    ) VALUES (?, ?, ?, NULL, ?, NULL, NULL, ?, ?)
  `)
  const updateSegmentSeen = db.prepare(`
    UPDATE work_segments SET last_seen_at = ?, updated_at = ? WHERE id = ?
  `)
  const updateSegmentCheckpoint = db.prepare(`
    UPDATE work_segments SET summary = ?, last_seen_at = ?, updated_at = ? WHERE id = ?
  `)
  const closeSegment = db.prepare(`
    UPDATE work_segments
    SET ended_at = ?, last_seen_at = ?, close_reason = ?, updated_at = ?
    WHERE id = ?
  `)

  const selectAcceptedAttribution = db.prepare(`
    SELECT * FROM segment_attributions
    WHERE segment_id = ?
      AND accepted_at IS NOT NULL AND rejected_at IS NULL AND superseded_at IS NULL
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `)
  const insertAttribution = db.prepare(`
    INSERT INTO segment_attributions (
      id, segment_id, task_id, provenance, confidence, rationale_code,
      accepted_at, rejected_at, superseded_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)
  `)
  const supersedeAttribution = db.prepare(`
    UPDATE segment_attributions SET superseded_at = ? WHERE id = ?
  `)
  const selectPendingIntent = db.prepare(`
    SELECT * FROM execution_intents
    WHERE source_session_id = ? AND external_agent_key = ?
      AND consumed_at IS NULL
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `)
  const insertIntent = db.prepare(`
    INSERT INTO execution_intents (
      id, source_session_id, external_agent_key, task_id, created_at, expires_at, consumed_at
    ) VALUES (?, ?, ?, ?, ?, ?, NULL)
  `)
  const consumeIntent = db.prepare(`
    UPDATE execution_intents SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL
  `)

  function requireProject(id) {
    if (id === null || id === undefined) return null
    const normalized = requiredString(id, 'project_id')
    const project = selectProject.get(normalized)
    if (!project) fail('PROJECT_NOT_FOUND', `project ${normalized} does not exist`, { id: normalized })
    return project
  }

  function requireTask(id) {
    const normalized = requiredString(id, 'task_id')
    const task = selectTask.get(normalized)
    if (!task) fail('TASK_NOT_FOUND', `task ${normalized} does not exist`, { id: normalized })
    return task
  }

  function requireExecution(id) {
    const normalized = requiredString(id, 'execution_id')
    const execution = selectExecution.get(normalized)
    if (!execution) {
      fail('EXECUTION_NOT_FOUND', `execution ${normalized} does not exist`, { id: normalized })
    }
    return execution
  }

  function requireSegment(id) {
    const normalized = requiredString(id, 'segment_id')
    const segment = selectSegment.get(normalized)
    if (!segment) fail('SEGMENT_NOT_FOUND', `segment ${normalized} does not exist`, { id: normalized })
    return segment
  }

  function ensureSourceSession(input, observedAt) {
    const source = requiredString(input.source, 'source')
    const externalSessionId = requiredString(input.source_session_key, 'source_session_key')
    const rootExternalId = optionalString(input.root_session_key, 'root_session_key')
    const project = requireProject(input.project_id)
    const existing = selectSourceSession.get(source, externalSessionId)
    if (existing) {
      if (existing.project_id && project && existing.project_id !== project.id) {
        fail('SOURCE_SESSION_PROJECT_CONFLICT', 'source session already belongs to another project', {
          source_session_id: existing.id,
          project_id: existing.project_id,
          requested_project_id: project.id,
        })
      }
      const lastSeenAt = observedAt > existing.last_seen_at ? observedAt : existing.last_seen_at
      updateSourceSession.run(rootExternalId, project?.id ?? null, lastSeenAt, existing.id)
      return selectSourceSessionById.get(existing.id)
    }
    const id = stableId('source-session', `${source}\u0000${externalSessionId}`)
    insertSourceSession.run(
      id,
      source,
      externalSessionId,
      rootExternalId,
      project?.id ?? null,
      observedAt,
      observedAt,
    )
    return selectSourceSessionById.get(id)
  }

  function appendObservation(input) {
    const source = requiredString(input.source, 'source')
    const externalEventId = requiredString(input.external_event_id, 'external_event_id')
    const eventType = requiredString(input.event_type, 'event_type')
    const observedAt = normalizedInstant(input.observed_at, 'observed_at', nowIso(clock))
    const sourceTurnKey = optionalString(input.source_turn_key, 'source_turn_key')
    const sourceAgentKey = optionalString(input.source_agent_key, 'source_agent_key')
    const workfolder = optionalString(input.workfolder, 'workfolder')
    const gitRoot = optionalString(input.git_root, 'git_root')
    const gitCommonDir = optionalString(input.git_common_dir, 'git_common_dir')
    const gitRemote = optionalString(input.git_remote, 'git_remote')
    const worktree = optionalString(input.worktree, 'worktree')
    const branch = optionalString(input.branch, 'branch')
    const payloadJson = plainPayload(input.payload)
    return transaction(() => {
      const existing = selectObservation.get(source, externalEventId)
      if (existing) {
        const changedFields = [
          ['event_type', eventType],
          ['observed_at', observedAt],
          ['source_turn_key', sourceTurnKey],
          ['source_agent_key', sourceAgentKey],
          ['workfolder', workfolder],
          ['git_root', gitRoot],
          ['git_common_dir', gitCommonDir],
          ['git_remote', gitRemote],
          ['worktree', worktree],
          ['branch', branch],
          ['payload_json', payloadJson],
        ].filter(([field, value]) => existing[field] !== value).map(([field]) => field)
        const expectedSessionKey = optionalString(input.source_session_key, 'source_session_key')
        const existingSession = existing.source_session_id
          ? selectSourceSessionById.get(existing.source_session_id)
          : null
        if ((existingSession?.external_session_id ?? null) !== expectedSessionKey) {
          changedFields.push('source_session_key')
        }
        const rootSessionKey = optionalString(input.root_session_key, 'root_session_key')
        if (
          rootSessionKey !== null
          && existingSession?.root_external_session_id !== null
          && existingSession?.root_external_session_id !== rootSessionKey
        ) {
          changedFields.push('root_session_key')
        }
        if (changedFields.length > 0) {
          fail('OBSERVATION_IDENTITY_CONFLICT', 'observation identity changed on replay', {
            source,
            external_event_id: externalEventId,
            fields: changedFields,
          })
        }
        return {
          observation: existing,
          source_session: existing.source_session_id
            ? selectSourceSessionById.get(existing.source_session_id)
            : null,
          changed: false,
          deduped: true,
        }
      }
      const sourceSession = input.source_session_key
        ? ensureSourceSession(input, observedAt)
        : null
      const id = stableId('observation', `${source}\u0000${externalEventId}`)
      insertObservation.run(
        id,
        source,
        externalEventId,
        eventType,
        observedAt,
        sourceSession?.id ?? null,
        sourceTurnKey,
        sourceAgentKey,
        workfolder,
        gitRoot,
        gitCommonDir,
        gitRemote,
        worktree,
        branch,
        payloadJson,
        nowIso(clock),
      )
      return {
        observation: selectObservation.get(source, externalEventId),
        source_session: sourceSession,
        changed: true,
        deduped: false,
      }
    })
  }

  function startExecution(input) {
    const id = requiredString(input.id, 'id')
    const kind = requiredString(input.kind, 'kind')
    if (!EXECUTION_KINDS.has(kind)) {
      fail('EXECUTION_KIND_INVALID', 'execution kind must be main or subagent', { kind })
    }
    const startedAt = normalizedInstant(input.started_at, 'started_at', nowIso(clock))
    return transaction(() => {
      const existing = selectExecution.get(id)
      if (existing) {
        const openSegment = selectOpenSegment.get(id)
        if (
          existing.kind !== kind
          || existing.source_turn_key !== optionalString(input.source_turn_key, 'source_turn_key')
        ) {
          fail('EXECUTION_IDENTITY_CONFLICT', 'execution identity changed on replay', { id })
        }
        return { execution: existing, segment: openSegment, changed: false }
      }
      const sourceSession = ensureSourceSession(input, startedAt)
      const parentExecutionId = optionalString(input.parent_execution_id, 'parent_execution_id')
      if (parentExecutionId) requireExecution(parentExecutionId)
      insertExecution.run(
        id,
        sourceSession.id,
        optionalString(input.source_turn_key, 'source_turn_key'),
        optionalString(input.source_agent_key, 'source_agent_key'),
        parentExecutionId,
        kind,
        optionalString(input.workfolder, 'workfolder'),
        optionalString(input.git_root, 'git_root'),
        optionalString(input.git_common_dir, 'git_common_dir'),
        optionalString(input.git_remote, 'git_remote'),
        optionalString(input.worktree, 'worktree'),
        optionalString(input.branch, 'branch'),
        startedAt,
        startedAt,
        startedAt,
        startedAt,
      )
      const segmentId = stableId('segment', `${id}\u0000${startedAt}\u00000`)
      insertSegment.run(segmentId, id, startedAt, startedAt, startedAt, startedAt)
      let attribution = null
      if (kind === 'subagent' && input.source_agent_key) {
        const rootSession = input.root_session_key
          ? selectSourceSession.get(input.source, input.root_session_key)
          : null
        const intent = rootSession
          ? selectPendingIntent.get(rootSession.id, input.source_agent_key)
          : null
        if (intent && intent.expires_at >= startedAt) {
          const execution = selectExecution.get(id)
          const task = requireTask(intent.task_id)
          ensureTaskProject(execution, task)
          attribution = addAcceptedAttribution({
            segment: selectSegment.get(segmentId),
            task,
            provenance: 'spawn_intent',
            rationaleCode: 'registered_execution_intent',
            timestamp: startedAt,
          })
          updateExecutionClassification.run('work', startedAt, id)
          consumeIntent.run(startedAt, intent.id)
        }
      }
      return {
        execution: selectExecution.get(id),
        segment: selectSegment.get(segmentId),
        attribution,
        changed: true,
      }
    })
  }

  function registerIntent(input) {
    const source = requiredString(input.source, 'source')
    const sourceSessionKey = requiredString(input.source_session_key, 'source_session_key')
    const externalAgentKey = requiredString(input.external_agent_key, 'external_agent_key')
    const task = requireTask(input.task_id)
    const createdAt = normalizedInstant(input.created_at, 'created_at', nowIso(clock))
    const defaultExpiry = new Date(Date.parse(createdAt) + 60 * 60 * 1000).toISOString()
    const expiresAt = normalizedInstant(input.expires_at, 'expires_at', defaultExpiry)
    if (expiresAt < createdAt) {
      fail('WORK_INPUT_INVALID', 'expires_at cannot precede created_at', { field: 'expires_at' })
    }
    return transaction(() => {
      const sourceSession = selectSourceSession.get(source, sourceSessionKey)
      if (!sourceSession) {
        fail('SOURCE_SESSION_NOT_FOUND', 'source session does not exist', {
          source,
          source_session_key: sourceSessionKey,
        })
      }
      if (sourceSession.project_id && sourceSession.project_id !== task.project_id) {
        fail('ATTRIBUTION_PROJECT_MISMATCH', 'intent task belongs to another project', {
          source_session_id: sourceSession.id,
          task_id: task.id,
        })
      }
      const existing = selectPendingIntent.get(sourceSession.id, externalAgentKey)
      if (existing) {
        if (existing.task_id === task.id) {
          return { intent: existing, changed: false }
        }
        fail('EXECUTION_INTENT_CONFLICT', 'pending execution intent already exists', {
          external_agent_key: externalAgentKey,
          current_task_id: existing.task_id,
        })
      }
      const id = randomUUID()
      insertIntent.run(
        id,
        sourceSession.id,
        externalAgentKey,
        task.id,
        createdAt,
        expiresAt,
      )
      return { intent: selectPendingIntent.get(sourceSession.id, externalAgentKey), changed: true }
    })
  }

  function ensureTaskProject(execution, task) {
    const sourceSession = selectSourceSessionById.get(execution.source_session_id)
    if (sourceSession.project_id && sourceSession.project_id !== task.project_id) {
      fail('ATTRIBUTION_PROJECT_MISMATCH', 'task and execution session belong to different projects', {
        execution_id: execution.id,
        task_id: task.id,
        project_id: sourceSession.project_id,
      })
    }
    if (sourceSession.project_id === null) {
      updateSourceSessionProject.run(task.project_id, sourceSession.id)
    }
  }

  function normalizeProvenance(value) {
    const provenance = requiredString(value, 'provenance')
    if (!ACCEPTED_PROVENANCE.has(provenance)) {
      fail(
        'ATTRIBUTION_PROVENANCE_UNACCEPTED',
        'suggestions cannot become accepted attributions without confirmation',
        { provenance },
      )
    }
    return provenance
  }

  function addAcceptedAttribution({ segment, task, provenance, rationaleCode, timestamp }) {
    const id = randomUUID()
    insertAttribution.run(
      id,
      segment.id,
      task.id,
      provenance,
      null,
      rationaleCode,
      timestamp,
      timestamp,
    )
    return selectAcceptedAttribution.get(segment.id)
  }

  function focus(input) {
    const executionId = requiredString(input.execution_id, 'execution_id')
    const taskId = input.task_id === null ? null : requiredString(input.task_id, 'task_id')
    const provenance = normalizeProvenance(input.provenance)
    const rationaleCode = requiredString(input.rationale_code, 'rationale_code')
    const timestamp = normalizedInstant(input.observed_at, 'observed_at', nowIso(clock))
    return transaction(() => {
      const execution = requireExecution(executionId)
      if (execution.ended_at !== null) {
        fail('EXECUTION_ALREADY_ENDED', 'cannot change focus of an ended execution', {
          execution_id: execution.id,
        })
      }
      const openSegment = selectOpenSegment.get(execution.id)
      if (!openSegment) fail('OPEN_SEGMENT_NOT_FOUND', 'active execution has no open segment')
      if (timestamp < openSegment.started_at) {
        fail('SEGMENT_TIME_INVALID', 'focus time cannot precede segment start')
      }
      const current = selectAcceptedAttribution.get(openSegment.id)
      if (current?.provenance === 'user' && provenance === 'current_focus') {
        return {
          execution,
          segment: openSegment,
          attribution: current,
          changed: false,
          reason: 'user_attribution_protected',
        }
      }
      if ((current?.task_id ?? null) === taskId) {
        updateSegmentSeen.run(timestamp, timestamp, openSegment.id)
        updateExecutionSeen.run(timestamp, timestamp, execution.id)
        return {
          execution: selectExecution.get(execution.id),
          segment: selectSegment.get(openSegment.id),
          attribution: current ?? null,
          changed: false,
          reason: current ? 'focus_unchanged' : 'unassigned_focus_unchanged',
        }
      }

      const task = taskId === null ? null : requireTask(taskId)
      if (task) ensureTaskProject(execution, task)
      if (!current) {
        if (!task) {
          return {
            execution,
            segment: openSegment,
            attribution: null,
            changed: false,
            reason: 'unassigned_focus_unchanged',
          }
        }
        const attribution = addAcceptedAttribution({
          segment: openSegment,
          task,
          provenance,
          rationaleCode,
          timestamp,
        })
        updateSegmentSeen.run(timestamp, timestamp, openSegment.id)
        updateExecutionSeen.run(timestamp, timestamp, execution.id)
        return {
          execution: selectExecution.get(execution.id),
          segment: selectSegment.get(openSegment.id),
          attribution,
          changed: true,
        }
      }

      closeSegment.run(timestamp, timestamp, 'focus_changed', timestamp, openSegment.id)
      const segmentId = stableId(
        'segment',
        `${execution.id}\u0000${timestamp}\u0000${openSegment.id}`,
      )
      insertSegment.run(segmentId, execution.id, timestamp, timestamp, timestamp, timestamp)
      const nextSegment = selectSegment.get(segmentId)
      const attribution = task
        ? addAcceptedAttribution({
            segment: nextSegment,
            task,
            provenance,
            rationaleCode,
            timestamp,
          })
        : null
      updateExecutionSeen.run(timestamp, timestamp, execution.id)
      return {
        execution: selectExecution.get(execution.id),
        segment: nextSegment,
        attribution,
        changed: true,
      }
    })
  }

  function correctAttribution(input) {
    const segmentId = requiredString(input.segment_id, 'segment_id')
    const task = requireTask(input.task_id)
    const provenance = normalizeProvenance(input.provenance)
    const rationaleCode = requiredString(input.rationale_code, 'rationale_code')
    const timestamp = normalizedInstant(input.observed_at, 'observed_at', nowIso(clock))
    return transaction(() => {
      const segment = requireSegment(segmentId)
      const execution = requireExecution(segment.execution_id)
      ensureTaskProject(execution, task)
      const current = selectAcceptedAttribution.get(segment.id)
      if (current?.task_id === task.id && current.provenance === provenance) {
        return { attribution: current, previous_attribution: current, changed: false }
      }
      if (current) supersedeAttribution.run(timestamp, current.id)
      const attribution = addAcceptedAttribution({
        segment,
        task,
        provenance,
        rationaleCode,
        timestamp,
      })
      return { attribution, previous_attribution: current ?? null, changed: true }
    })
  }

  function endExecution(input) {
    const executionId = requiredString(input.execution_id, 'execution_id')
    const timestamp = normalizedInstant(input.observed_at, 'observed_at', nowIso(clock))
    const endReason = requiredString(input.end_reason, 'end_reason')
    return transaction(() => {
      const execution = requireExecution(executionId)
      if (execution.ended_at !== null) {
        return { execution, segment: null, changed: false }
      }
      if (timestamp < execution.started_at) {
        fail('EXECUTION_TIME_INVALID', 'execution end cannot precede start')
      }
      const segment = selectOpenSegment.get(execution.id)
      if (segment) {
        closeSegment.run(timestamp, timestamp, 'execution_ended', timestamp, segment.id)
      }
      closeExecution.run(timestamp, timestamp, endReason, timestamp, execution.id)
      const sourceSession = selectSourceSessionById.get(execution.source_session_id)
      updateSourceSession.run(
        sourceSession.root_external_session_id,
        sourceSession.project_id,
        timestamp > sourceSession.last_seen_at ? timestamp : sourceSession.last_seen_at,
        sourceSession.id,
      )
      return {
        execution: selectExecution.get(execution.id),
        segment: segment ? selectSegment.get(segment.id) : null,
        changed: true,
      }
    })
  }

  function heartbeatExecution(input) {
    const executionId = requiredString(input.execution_id, 'execution_id')
    const timestamp = normalizedInstant(input.observed_at, 'observed_at', nowIso(clock))
    return transaction(() => {
      const execution = requireExecution(executionId)
      if (timestamp < execution.started_at) {
        fail('EXECUTION_TIME_INVALID', 'heartbeat cannot precede execution start')
      }
      if (execution.ended_at !== null) {
        return {
          execution,
          segment: null,
          changed: false,
          reason: 'execution_ended',
        }
      }
      const segment = selectOpenSegment.get(execution.id)
      if (!segment) fail('OPEN_SEGMENT_NOT_FOUND', 'active execution has no open segment')
      const executionChanged = timestamp > execution.last_seen_at
      const segmentChanged = timestamp > segment.last_seen_at
      if (!executionChanged && !segmentChanged) {
        return { execution, segment, changed: false, reason: 'heartbeat_not_newer' }
      }
      if (executionChanged) updateExecutionSeen.run(timestamp, timestamp, execution.id)
      if (segmentChanged) updateSegmentSeen.run(timestamp, timestamp, segment.id)
      const sourceSession = selectSourceSessionById.get(execution.source_session_id)
      if (timestamp > sourceSession.last_seen_at) {
        updateSourceSession.run(
          sourceSession.root_external_session_id,
          sourceSession.project_id,
          timestamp,
          sourceSession.id,
        )
      }
      return {
        execution: selectExecution.get(execution.id),
        segment: selectSegment.get(segment.id),
        changed: true,
      }
    })
  }

  function endSourceSessionExecutions(input) {
    const source = requiredString(input.source, 'source')
    const sourceSessionKey = requiredString(input.source_session_key, 'source_session_key')
    const timestamp = normalizedInstant(input.observed_at, 'observed_at', nowIso(clock))
    const endReason = requiredString(input.end_reason, 'end_reason')
    return transaction(() => {
      const executions = selectOpenExecutionsForSourceSession.all(source, sourceSessionKey)
      const results = executions.map((execution) => endExecution({
        execution_id: execution.id,
        observed_at: timestamp,
        end_reason: endReason,
      }))
      return {
        executions: results.map((result) => result.execution),
        segments: results.map((result) => result.segment).filter(Boolean),
        changed: results.some((result) => result.changed),
      }
    })
  }

  function recoverExecutions(input) {
    const timestamp = normalizedInstant(input.observed_at, 'observed_at', nowIso(clock))
    const staleAfter = input.stale_after_ms ?? 30 * 60_000
    if (!Number.isFinite(staleAfter) || staleAfter < 0) {
      fail('WORK_INPUT_INVALID', 'stale_after_ms must be a non-negative number', {
        field: 'stale_after_ms',
      })
    }
    if (!Array.isArray(input.inactive_sessions)) {
      fail('WORK_INPUT_INVALID', 'inactive_sessions must be an array', {
        field: 'inactive_sessions',
      })
    }
    const inactive = new Set(input.inactive_sessions.map((session, index) => {
      if (!session || typeof session !== 'object' || Array.isArray(session)) {
        fail('WORK_INPUT_INVALID', 'inactive session evidence must be an object', {
          field: `inactive_sessions[${index}]`,
        })
      }
      const source = requiredString(session.source, `inactive_sessions[${index}].source`)
      const key = requiredString(
        session.source_session_key,
        `inactive_sessions[${index}].source_session_key`,
      )
      return `${source}\u0000${key}`
    }))
    return transaction(() => {
      const open = selectOpenExecutionsWithSession.all()
      const stale = open.filter((execution) => (
        Date.parse(timestamp) - Date.parse(execution.last_seen_at) >= staleAfter
      ))
      const recovered = []
      const unresolved = []
      for (const execution of stale) {
        const identity = `${execution.session_source}\u0000${execution.external_session_id}`
        if (!inactive.has(identity)) {
          unresolved.push(execution)
          continue
        }
        const segment = selectOpenSegment.get(execution.id)
        if (segment) {
          closeSegment.run(timestamp, timestamp, 'recovered', timestamp, segment.id)
        }
        closeExecution.run(timestamp, timestamp, 'interrupted', timestamp, execution.id)
        const sourceSession = selectSourceSessionById.get(execution.source_session_id)
        if (timestamp > sourceSession.last_seen_at) {
          updateSourceSession.run(
            sourceSession.root_external_session_id,
            sourceSession.project_id,
            timestamp,
            sourceSession.id,
          )
        }
        recovered.push(selectExecution.get(execution.id))
      }
      return {
        recovered,
        stale: unresolved.map(({ session_source, external_session_id, ...execution }) => execution),
        changed: recovered.length > 0,
      }
    })
  }

  function listSegments(filters = {}) {
    const executionId = requiredString(filters.execution_id, 'execution_id')
    return db.prepare(`
      SELECT
        segment.*,
        attribution.id AS attribution_id,
        attribution.task_id AS task_id,
        attribution.provenance AS attribution_provenance
      FROM work_segments segment
      LEFT JOIN segment_attributions attribution
        ON attribution.segment_id = segment.id
       AND attribution.accepted_at IS NOT NULL
       AND attribution.rejected_at IS NULL
       AND attribution.superseded_at IS NULL
      WHERE segment.execution_id = ?
      ORDER BY segment.started_at, segment.id
    `).all(executionId)
  }

  function listAttributions(filters = {}) {
    const segmentId = requiredString(filters.segment_id, 'segment_id')
    return db.prepare(`
      SELECT * FROM segment_attributions
      WHERE segment_id = ?
      ORDER BY created_at, id
    `).all(segmentId)
  }

  function executionLiveState(id, options = {}) {
    const execution = requireExecution(id)
    if (execution.ended_at !== null) {
      return execution.end_reason === 'interrupted' ? 'interrupted' : 'ended'
    }
    const now = normalizedInstant(options.now, 'now', nowIso(clock))
    const staleAfter = options.stale_after_ms ?? 30 * 60_000
    const idleAfter = options.idle_after_ms ?? Math.min(5 * 60_000, staleAfter)
    if (!Number.isFinite(staleAfter) || staleAfter < 0 || !Number.isFinite(idleAfter) || idleAfter < 0) {
      fail('WORK_INPUT_INVALID', 'live state thresholds must be non-negative numbers')
    }
    const elapsed = Date.parse(now) - Date.parse(execution.last_seen_at)
    if (elapsed >= staleAfter) return 'stale'
    if (elapsed >= idleAfter) return 'idle'
    return 'running'
  }

  function context(input) {
    const executionId = requiredString(input.execution_id, 'execution_id')
    const execution = requireExecution(executionId)
    const sourceSession = selectSourceSessionById.get(execution.source_session_id)
    const project = sourceSession.project_id ? selectProject.get(sourceSession.project_id) ?? null : null
    const segment = selectOpenSegment.get(execution.id) ?? selectLatestSegment.get(execution.id) ?? null
    const attribution = segment ? selectAcceptedAttribution.get(segment.id) ?? null : null
    const task = attribution ? selectTask.get(attribution.task_id) ?? null : null
    return {
      execution,
      source_session: sourceSession,
      project,
      segment,
      attribution,
      task,
    }
  }

  function checkpoint(input) {
    const executionId = requiredString(input.execution_id, 'execution_id')
    const taskId = requiredString(input.task_id, 'task_id')
    const summary = requiredString(input.summary, 'summary')
    if (summary.length > 4_000) {
      fail('WORK_INPUT_INVALID', 'summary exceeds 4000 characters', { field: 'summary' })
    }
    const timestamp = normalizedInstant(input.observed_at, 'observed_at', nowIso(clock))
    return transaction(() => {
      const execution = requireExecution(executionId)
      if (execution.ended_at !== null) {
        fail('EXECUTION_ALREADY_ENDED', 'cannot checkpoint an ended execution', {
          execution_id: execution.id,
        })
      }
      const segment = selectOpenSegment.get(execution.id)
      if (!segment) fail('OPEN_SEGMENT_NOT_FOUND', 'active execution has no open segment')
      const attribution = selectAcceptedAttribution.get(segment.id)
      if (!attribution || attribution.task_id !== taskId) {
        fail('CHECKPOINT_FOCUS_MISMATCH', 'checkpoint task must match current accepted focus', {
          execution_id: execution.id,
          task_id: taskId,
          focused_task_id: attribution?.task_id ?? null,
        })
      }
      requireTask(taskId)
      if (segment.summary === summary) {
        return { execution, segment, attribution, changed: false }
      }
      const lastSeenAt = timestamp > segment.last_seen_at ? timestamp : segment.last_seen_at
      updateSegmentCheckpoint.run(summary, lastSeenAt, timestamp, segment.id)
      if (timestamp > execution.last_seen_at) {
        updateExecutionSeen.run(timestamp, timestamp, execution.id)
      }
      return {
        execution: selectExecution.get(execution.id),
        segment: selectSegment.get(segment.id),
        attribution,
        changed: true,
      }
    })
  }

  function mutationTimestamp(execution, segment) {
    const current = Date.parse(nowIso(clock))
    const boundary = Math.max(
      Date.parse(execution.last_seen_at),
      segment ? Date.parse(segment.last_seen_at) : Number.NEGATIVE_INFINITY,
    )
    return new Date(Math.max(current, boundary + 1)).toISOString()
  }

  function assignExecution(input) {
    const executionId = requiredString(input.execution_id ?? input.id, 'execution_id')
    const targetTaskId = input.task_id === null ? null : requiredString(input.task_id, 'task_id')
    const expectedTaskId = input.expected_task_id === null
      ? null
      : requiredString(input.expected_task_id, 'expected_task_id')
    return transaction(() => {
      const execution = requireExecution(executionId)
      const segment = selectOpenSegment.get(execution.id) ?? selectLatestSegment.get(execution.id)
      if (!segment) fail('SEGMENT_NOT_FOUND', 'execution has no work segment')
      const current = selectAcceptedAttribution.get(segment.id) ?? null
      if ((current?.task_id ?? null) !== expectedTaskId) {
        fail('EXECUTION_ASSIGNMENT_CONFLICT', 'execution attribution changed', {
          execution_id: execution.id,
          expected_task_id: expectedTaskId,
          current_task_id: current?.task_id ?? null,
        })
      }
      if ((current?.task_id ?? null) === targetTaskId && (
        targetTaskId === null || execution.classification === 'work'
      )) {
        return { execution, segment, attribution: current, changed: false }
      }
      const timestamp = mutationTimestamp(execution, segment)
      if (current) supersedeAttribution.run(timestamp, current.id)
      let attribution = null
      if (targetTaskId !== null) {
        const task = requireTask(targetTaskId)
        ensureTaskProject(execution, task)
        attribution = addAcceptedAttribution({
          segment,
          task,
          provenance: 'user',
          rationaleCode: 'legacy_execution_assignment',
          timestamp,
        })
      }
      updateExecutionClassification.run(targetTaskId === null ? 'unknown' : 'work', timestamp, execution.id)
      return {
        execution: selectExecution.get(execution.id),
        segment,
        attribution,
        previous_attribution: current,
        changed: true,
      }
    })
  }

  function classifyExecution(input) {
    const executionId = requiredString(input.execution_id ?? input.id, 'execution_id')
    const target = requiredString(input.classification, 'classification')
    if (!['unknown', 'work', 'non_work'].includes(target)) {
      fail('EXECUTION_CLASSIFICATION_INVALID', 'classification is invalid', { classification: target })
    }
    const expected = requiredString(input.expected_classification, 'expected_classification')
    const expectedTaskId = input.expected_task_id === null
      ? null
      : requiredString(input.expected_task_id, 'expected_task_id')
    return transaction(() => {
      const execution = requireExecution(executionId)
      const segment = selectOpenSegment.get(execution.id) ?? selectLatestSegment.get(execution.id)
      if (!segment) fail('SEGMENT_NOT_FOUND', 'execution has no work segment')
      const attribution = selectAcceptedAttribution.get(segment.id) ?? null
      if (
        execution.classification !== expected
        || (attribution?.task_id ?? null) !== expectedTaskId
      ) {
        fail('EXECUTION_CLASSIFICATION_CONFLICT', 'execution classification changed', {
          execution_id: execution.id,
          expected_classification: expected,
          current_classification: execution.classification,
          expected_task_id: expectedTaskId,
          current_task_id: attribution?.task_id ?? null,
        })
      }
      const dropsAttribution = target !== 'work' && attribution !== null
      if (target === execution.classification && !dropsAttribution) {
        return { execution, segment, attribution, changed: false }
      }
      const timestamp = mutationTimestamp(execution, segment)
      if (dropsAttribution) supersedeAttribution.run(timestamp, attribution.id)
      updateExecutionClassification.run(target, timestamp, execution.id)
      return {
        execution: selectExecution.get(execution.id),
        segment,
        attribution: dropsAttribution ? null : attribution,
        previous_attribution: attribution,
        changed: true,
      }
    })
  }

  function updateExecutionAssignments(input) {
    if (!Array.isArray(input?.changes)) {
      fail('WORK_INPUT_INVALID', 'changes must be an array', { field: 'changes' })
    }
    return transaction(() => {
      const results = input.changes.map((change) => (
        change.classification !== undefined
          ? classifyExecution(change)
          : assignExecution(change)
      ))
      return {
        executions: results.map(({ execution }) => execution),
        results,
        changed: results.some((result) => result.changed),
      }
    })
  }

  function assignSourceSessionProject(input) {
    const sourceSessionId = requiredString(input.source_session_id, 'source_session_id')
    const projectId = requiredString(input.project_id, 'project_id')
    const expectedProjectId = input.expected_project_id === null
      ? null
      : requiredString(input.expected_project_id, 'expected_project_id')
    return transaction(() => {
      const sourceSession = selectSourceSessionById.get(sourceSessionId)
      if (!sourceSession) {
        fail('SOURCE_SESSION_NOT_FOUND', 'source session does not exist', {
          source_session_id: sourceSessionId,
        })
      }
      const project = selectProject.get(projectId)
      if (!project || project.archived_at !== null) {
        fail('PROJECT_NOT_FOUND', 'project does not exist', { project_id: projectId })
      }
      if (sourceSession.project_id !== expectedProjectId) {
        fail('SOURCE_SESSION_PROJECT_CONFLICT', 'source session project changed', {
          source_session_id: sourceSession.id,
          expected_project_id: expectedProjectId,
          current_project_id: sourceSession.project_id,
        })
      }
      const attributedProjectIds = selectAttributedProjectIds
        .all(sourceSession.id)
        .map(({ project_id: id }) => id)
      if (attributedProjectIds.some((id) => id !== project.id)) {
        fail('SOURCE_SESSION_PROJECT_CONFLICT', 'accepted work belongs to another project', {
          source_session_id: sourceSession.id,
          attributed_project_ids: attributedProjectIds,
          requested_project_id: project.id,
        })
      }
      if (sourceSession.project_id === project.id) {
        return { source_session: sourceSession, project, changed: false }
      }
      setSourceSessionProject.run(project.id, sourceSession.id)
      return {
        source_session: selectSourceSessionById.get(sourceSession.id),
        project,
        changed: true,
      }
    })
  }

  return {
    appendObservation,
    startExecution,
    registerIntent,
    focus,
    correctAttribution,
    heartbeatExecution,
    endExecution,
    endSourceSessionExecutions,
    recoverExecutions,
    listSegments,
    listAttributions,
    executionLiveState,
    context,
    checkpoint,
    assignExecution,
    classifyExecution,
    updateExecutionAssignments,
    assignSourceSessionProject,
  }
}
