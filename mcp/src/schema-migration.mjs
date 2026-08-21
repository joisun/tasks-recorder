import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { access, chmod, mkdir, stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { backup, DatabaseSync } from 'node:sqlite'

import { TaskRecorderError } from './errors.mjs'
import { checkSchemaV3Invariants, createSchemaV3, SCHEMA_V3 } from './schema-v3.mjs'

const LEGACY_SCHEMA_VERSION = 2

function fail(code, message, details) {
  throw new TaskRecorderError(code, message, details)
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

function stableProjectId(name, discriminator) {
  const slug = name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 36) || 'project'
  const suffix = createHash('sha256')
    .update(`${name}\0${discriminator}`)
    .digest('hex')
    .slice(0, 10)
  return `${slug}-${suffix}`
}

function rootTaskId(task, tasksById) {
  let current = task
  const visited = new Set()
  while (current.parent_id !== null) {
    if (visited.has(current.id)) {
      fail('SCHEMA_MIGRATION_INVALID_TREE', 'legacy task hierarchy contains a cycle', {
        task_id: task.id,
      })
    }
    visited.add(current.id)
    const parent = tasksById.get(current.parent_id)
    if (!parent) {
      fail('SCHEMA_MIGRATION_INVALID_TREE', 'legacy task parent is missing', {
        task_id: current.id,
        parent_id: current.parent_id,
      })
    }
    current = parent
  }
  return current.id
}

function evidenceForSessions(sessions) {
  const gitRoots = [...new Set(sessions.map(({ git_root: value }) => nonEmpty(value)).filter(Boolean))]
    .sort()
  if (gitRoots.length > 0) {
    return gitRoots.map((value) => ({ kind: 'git_root', value }))
  }
  const workfolders = [...new Set(sessions.map(({ workfolder: value }) => nonEmpty(value)).filter(Boolean))]
    .sort()
  return workfolders.map((value) => ({ kind: 'workspace', value }))
}

function buildProjectPlan(tasks, sessions) {
  const tasksById = new Map(tasks.map((task) => [task.id, task]))
  const sessionsByTask = new Map()
  for (const session of sessions) {
    const items = sessionsByTask.get(session.task_id) ?? []
    items.push(session)
    sessionsByTask.set(session.task_id, items)
  }

  const families = new Map()
  for (const task of tasks) {
    const rootId = rootTaskId(task, tasksById)
    const family = families.get(rootId) ?? { rootId, tasks: [], sessions: [] }
    family.tasks.push(task)
    family.sessions.push(...(sessionsByTask.get(task.id) ?? []))
    families.set(rootId, family)
  }

  const groups = new Map()
  for (const family of families.values()) {
    family.tasks.sort((left, right) => left.id.localeCompare(right.id))
    const names = [...new Set(family.tasks.map(({ project }) => project))]
    if (names.length !== 1) {
      fail('SCHEMA_MIGRATION_INVALID_TREE', 'legacy task family crosses project labels', {
        root_task_id: family.rootId,
        projects: names.sort(),
      })
    }
    const name = names[0]
    const evidence = evidenceForSessions(family.sessions)
    const discriminator = evidence.length === 1
      ? `${evidence[0].kind}:${evidence[0].value}`
      : `family:${family.rootId}`
    const key = `${name}\0${discriminator}`
    const group = groups.get(key) ?? {
      name,
      discriminator,
      evidence,
      task_ids: [],
      root_task_ids: [],
      ambiguous: evidence.length !== 1,
    }
    group.task_ids.push(...family.tasks.map(({ id }) => id))
    group.root_task_ids.push(family.rootId)
    groups.set(key, group)
  }

  const projects = [...groups.values()].map((group) => ({
    project_id: stableProjectId(group.name, group.discriminator),
    name: group.name,
    evidence: group.evidence,
    task_ids: [...new Set(group.task_ids)].sort(),
    root_task_ids: [...new Set(group.root_task_ids)].sort(),
    ambiguous: group.ambiguous,
  })).sort((left, right) => (
    left.name.localeCompare(right.name)
    || (left.evidence[0]?.value ?? '').localeCompare(right.evidence[0]?.value ?? '')
    || left.task_ids[0].localeCompare(right.task_ids[0])
  ))

  const projectsByEvidence = new Map()
  for (const project of projects) {
    if (project.evidence.length !== 1) continue
    const evidence = project.evidence[0]
    const key = `${evidence.kind}\0${evidence.value}`
    const matches = projectsByEvidence.get(key) ?? []
    matches.push(project)
    projectsByEvidence.set(key, matches)
  }
  const collisionAmbiguities = []
  const collidingProjectIds = new Set()
  for (const matches of projectsByEvidence.values()) {
    if (matches.length < 2) continue
    for (const project of matches) {
      project.ambiguous = true
      collidingProjectIds.add(project.project_id)
    }
    collisionAmbiguities.push({
      code: 'PROJECT_LOCATION_COLLISION',
      evidence: matches[0].evidence[0],
      legacy_projects: [...new Set(matches.map(({ name }) => name))].sort(),
      task_ids: matches.flatMap(({ task_ids: taskIds }) => taskIds).sort(),
    })
  }

  const ambiguities = projects.filter((project) => (
    project.ambiguous && !collidingProjectIds.has(project.project_id)
  )).map((project) => ({
    code: project.evidence.length === 0
      ? 'PROJECT_LOCATION_MISSING'
      : 'PROJECT_LOCATION_CONFLICT',
    legacy_project: project.name,
    task_ids: project.task_ids,
  })).concat(collisionAmbiguities).sort((left, right) => (
    left.code.localeCompare(right.code)
    || (left.legacy_project ?? left.legacy_projects?.[0] ?? '')
      .localeCompare(right.legacy_project ?? right.legacy_projects?.[0] ?? '')
  ))

  const taskProjectMap = projects.flatMap((project) => project.task_ids.map((taskId) => ({
    task_id: taskId,
    project_id: project.project_id,
  }))).sort((left, right) => left.task_id.localeCompare(right.task_id))

  return { projects, ambiguities, taskProjectMap }
}

export function inspectV2Migration(db) {
  if (!db || typeof db.prepare !== 'function') {
    throw new TypeError('db must be a node:sqlite DatabaseSync')
  }
  const actual = db.prepare('PRAGMA user_version').get().user_version
  if (actual !== LEGACY_SCHEMA_VERSION) {
    fail(
      'SCHEMA_MIGRATION_SOURCE_UNSUPPORTED',
      `schema v3 migration requires a version ${LEGACY_SCHEMA_VERSION} database`,
      { expected: LEGACY_SCHEMA_VERSION, actual },
    )
  }

  const tasks = db.prepare('SELECT * FROM tasks ORDER BY id').all()
  const sessions = db.prepare('SELECT * FROM task_sessions ORDER BY task_id, session_id').all()
  const executionCounts = db.prepare(`
    SELECT
      COUNT(*) AS execution_count,
      SUM(CASE WHEN task_id IS NOT NULL THEN 1 ELSE 0 END) AS bound_execution_count,
      SUM(CASE WHEN task_id IS NULL THEN 1 ELSE 0 END) AS unassigned_execution_count
    FROM task_executions
  `).get()
  const { projects, ambiguities, taskProjectMap } = buildProjectPlan(tasks, sessions)

  return {
    source_schema_version: LEGACY_SCHEMA_VERSION,
    target_schema_version: SCHEMA_V3,
    legacy: {
      schema_version: LEGACY_SCHEMA_VERSION,
      task_count: tasks.length,
      execution_count: executionCounts.execution_count,
      bound_execution_count: executionCounts.bound_execution_count ?? 0,
      unassigned_execution_count: executionCounts.unassigned_execution_count ?? 0,
    },
    projects,
    task_project_map: taskProjectMap,
    ambiguities,
  }
}

export function inspectV2MigrationPath(databasePath) {
  if (!nonEmpty(databasePath)) throw new TypeError('databasePath must be a non-empty string')
  const db = new DatabaseSync(databasePath, { readOnly: true })
  try {
    return inspectV2Migration(db)
  } finally {
    db.close()
  }
}

export function migrationCliReport(report, { dryRun }) {
  if (!report || typeof report !== 'object') throw new TypeError('report must be an object')
  const ambiguityCodes = {}
  for (const ambiguity of report.ambiguities ?? []) {
    const code = nonEmpty(ambiguity?.code) ?? 'UNKNOWN'
    ambiguityCodes[code] = (ambiguityCodes[code] ?? 0) + 1
  }
  const summary = {
    dry_run: Boolean(dryRun),
    source_schema_version: report.source_schema_version,
    target_schema_version: report.target_schema_version,
    legacy: report.legacy,
    plan: {
      project_count: report.projects?.length ?? 0,
      ambiguous_project_count: report.projects?.filter(({ ambiguous }) => ambiguous).length ?? 0,
      ambiguity_count: report.ambiguities?.length ?? 0,
      ambiguity_codes: ambiguityCodes,
    },
  }
  if (report.backup) summary.backup = report.backup
  if (report.migrated) summary.migrated = report.migrated
  if (report.invariants) {
    summary.invariants = {
      integrity_check: report.invariants.integrityCheck,
      foreign_key_violation_count: report.invariants.foreignKeyViolations?.length ?? 0,
      invariant_violation_count: report.invariants.invariantViolations?.length ?? 0,
    }
  }
  return summary
}

function stableRowId(prefix, value) {
  const suffix = createHash('sha256').update(value).digest('hex').slice(0, 20)
  return `${prefix}-${suffix}`
}

function instant(value, fallback) {
  return nonEmpty(value) ?? fallback
}

function plannedStart(value) {
  return nonEmpty(value) ? `${value}T00:00:00.000Z` : null
}

function plannedDue(value) {
  return nonEmpty(value) ? `${value}T23:59:59.999Z` : null
}

function targetLifecycle(value) {
  return value === 'active' ? 'in_progress' : value
}

async function sha256File(path) {
  const hash = createHash('sha256')
  await new Promise((resolve, reject) => {
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', resolve)
  })
  return hash.digest('hex')
}

async function createVerifiedBackup(db, backupPath) {
  try {
    await access(backupPath)
    fail('SCHEMA_MIGRATION_BACKUP_EXISTS', 'migration backup path already exists', {
      backup_path: backupPath,
    })
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  await mkdir(dirname(backupPath), { recursive: true, mode: 0o700 })
  await backup(db, backupPath)
  await chmod(backupPath, 0o600)
  const backupDb = new DatabaseSync(backupPath, { readOnly: true })
  let schemaVersion
  let integrityCheck
  try {
    schemaVersion = backupDb.prepare('PRAGMA user_version').get().user_version
    integrityCheck = backupDb.prepare('PRAGMA integrity_check').get().integrity_check
  } finally {
    backupDb.close()
  }
  if (schemaVersion !== LEGACY_SCHEMA_VERSION || integrityCheck !== 'ok') {
    fail('SCHEMA_MIGRATION_BACKUP_INVALID', 'migration backup failed verification', {
      schema_version: schemaVersion,
      integrity_check: integrityCheck,
    })
  }
  const metadata = await stat(backupPath)
  return {
    path: backupPath,
    bytes: metadata.size,
    sha256: await sha256File(backupPath),
    schema_version: schemaVersion,
    integrity_check: integrityCheck,
  }
}

function renameLegacyTables(db) {
  db.exec(`
    ALTER TABLE plan_observations RENAME TO legacy_plan_observations;
    ALTER TABLE task_events RENAME TO legacy_task_events;
    ALTER TABLE task_executions RENAME TO legacy_task_executions;
    ALTER TABLE task_sessions RENAME TO legacy_task_sessions;
    ALTER TABLE tasks RENAME TO legacy_tasks;
    PRAGMA user_version = 0;
  `)
}

function sourceSessionPlan(db, taskProjectMap, timestamp) {
  const projectByTask = new Map(taskProjectMap.map(({ task_id: taskId, project_id: projectId }) => (
    [taskId, projectId]
  )))
  const values = new Map()

  function observe(externalId, { at, rootExternalId = null, projectId = null } = {}) {
    const id = nonEmpty(externalId)
    if (!id) return
    const observedAt = instant(at, timestamp)
    const current = values.get(id) ?? {
      externalId: id,
      firstSeenAt: observedAt,
      lastSeenAt: observedAt,
      rootExternalIds: new Set(),
      projectIds: new Set(),
    }
    if (observedAt < current.firstSeenAt) current.firstSeenAt = observedAt
    if (observedAt > current.lastSeenAt) current.lastSeenAt = observedAt
    if (nonEmpty(rootExternalId)) current.rootExternalIds.add(rootExternalId)
    if (projectId) current.projectIds.add(projectId)
    values.set(id, current)
  }

  for (const session of db.prepare('SELECT * FROM legacy_task_sessions').all()) {
    observe(session.session_id, {
      at: session.first_seen_at,
      projectId: projectByTask.get(session.task_id) ?? null,
    })
    observe(session.session_id, {
      at: session.last_seen_at,
      projectId: projectByTask.get(session.task_id) ?? null,
    })
  }
  for (const execution of db.prepare('SELECT * FROM legacy_task_executions').all()) {
    const projectId = execution.task_id === null
      ? null
      : projectByTask.get(execution.task_id) ?? null
    observe(execution.session_id, {
      at: execution.started_at,
      rootExternalId: execution.root_session_id,
      projectId,
    })
    observe(execution.session_id, {
      at: execution.last_seen_at,
      rootExternalId: execution.root_session_id,
      projectId,
    })
    observe(execution.root_session_id, { at: execution.started_at, rootExternalId: execution.root_session_id })
  }
  for (const event of db.prepare('SELECT * FROM legacy_task_events').all()) {
    observe(event.source_session_id, {
      at: event.created_at,
      projectId: projectByTask.get(event.task_id) ?? null,
    })
  }
  for (const plan of db.prepare('SELECT * FROM legacy_plan_observations').all()) {
    observe(plan.session_id, { at: plan.observed_at })
  }

  return [...values.values()].map((value) => ({
    id: stableRowId('legacy-session', value.externalId),
    source: 'legacy',
    external_session_id: value.externalId,
    root_external_session_id: value.rootExternalIds.size === 1
      ? [...value.rootExternalIds][0]
      : null,
    project_id: value.projectIds.size === 1 ? [...value.projectIds][0] : null,
    first_seen_at: value.firstSeenAt,
    last_seen_at: value.lastSeenAt,
  })).sort((left, right) => left.external_session_id.localeCompare(right.external_session_id))
}

function insertProjects(db, report, timestamp) {
  const insertProject = db.prepare(`
    INSERT INTO projects (id, name, description, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `)
  const insertLocation = db.prepare(`
    INSERT INTO project_locations (
      id, project_id, kind, normalized_value, display_value, last_seen_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `)
  for (const project of report.projects) {
    insertProject.run(
      project.project_id,
      project.name,
      project.ambiguous ? 'Migrated from v2; project evidence requires review.' : null,
      timestamp,
      timestamp,
    )
    if (project.ambiguous) continue
    for (const evidence of project.evidence) {
      const kind = evidence.kind === 'git_root' ? 'workspace' : evidence.kind
      insertLocation.run(
        stableRowId('location', `${project.project_id}\0${kind}\0${evidence.value}`),
        project.project_id,
        kind,
        evidence.value,
        evidence.value,
        timestamp,
        timestamp,
      )
    }
  }
}

function insertTasks(db, taskProjectMap) {
  const projectByTask = new Map(taskProjectMap.map(({ task_id: taskId, project_id: projectId }) => (
    [taskId, projectId]
  )))
  const insert = db.prepare(`
    INSERT INTO tasks (
      id, project_id, parent_id, title, description, lifecycle,
      planned_start_at, planned_due_at, next_action, sort_order, revision,
      completed_at, archived_at, deleted_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const tasks = db.prepare(`
    SELECT * FROM legacy_tasks
    ORDER BY CASE WHEN parent_id IS NULL THEN 0 ELSE 1 END, sort_order, id
  `).all()
  for (const task of tasks) {
    insert.run(
      task.id,
      projectByTask.get(task.id),
      task.parent_id,
      task.title,
      task.description,
      targetLifecycle(task.status),
      plannedStart(task.start_date),
      plannedDue(task.due_date),
      task.next_action,
      task.sort_order,
      task.revision,
      task.completed_at,
      task.archived_at,
      task.deleted_at,
      task.created_at,
      task.updated_at,
    )
  }
  return tasks
}

function insertSourceSessions(db, sessions) {
  const insert = db.prepare(`
    INSERT INTO source_sessions (
      id, source, external_session_id, root_external_session_id, project_id,
      first_seen_at, last_seen_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `)
  for (const session of sessions) {
    insert.run(
      session.id,
      session.source,
      session.external_session_id,
      session.root_external_session_id,
      session.project_id,
      session.first_seen_at,
      session.last_seen_at,
    )
  }
}

function insertLegacySessionObservations(db, sessionIdByExternal, timestamp) {
  const insert = db.prepare(`
    INSERT INTO observations (
      id, source, external_event_id, event_type, observed_at, source_session_id,
      workfolder, git_root, worktree, branch, payload_json, created_at
    ) VALUES (?, 'legacy', ?, 'migration.task_session', ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  for (const session of db.prepare('SELECT * FROM legacy_task_sessions ORDER BY task_id, session_id').all()) {
    const externalEventId = `task-session:${session.task_id}:${session.session_id}`
    insert.run(
      stableRowId('observation', externalEventId),
      externalEventId,
      instant(session.last_seen_at, timestamp),
      sessionIdByExternal.get(session.session_id),
      session.workfolder,
      session.git_root,
      session.worktree,
      session.branch,
      JSON.stringify({ task_id: session.task_id, agent: session.agent }),
      timestamp,
    )
  }
}

function insertExecutions(db, sessionIdByExternal, timestamp) {
  const insertObservation = db.prepare(`
    INSERT INTO observations (
      id, source, external_event_id, event_type, observed_at, source_session_id,
      source_turn_key, source_agent_key, workfolder, git_root, worktree, branch,
      payload_json, created_at
    ) VALUES (?, 'legacy', ?, 'migration.execution', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const insertExecution = db.prepare(`
    INSERT INTO executions (
      id, source_session_id, source_turn_key, source_agent_key, parent_execution_id,
      kind, classification, workfolder, git_root, worktree, branch,
      started_at, ended_at, last_seen_at, end_reason, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const insertSegment = db.prepare(`
    INSERT INTO work_segments (
      id, execution_id, started_at, ended_at, last_seen_at, close_reason,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const insertAttribution = db.prepare(`
    INSERT INTO segment_attributions (
      id, segment_id, task_id, provenance, rationale_code, accepted_at, created_at
    ) VALUES (?, ?, ?, 'migration', 'legacy_direct_task_binding', ?, ?)
  `)
  const executions = db.prepare(`
    SELECT * FROM legacy_task_executions
    ORDER BY CASE WHEN parent_execution_id IS NULL THEN 0 ELSE 1 END, started_at, id
  `).all()
  let acceptedAttributionCount = 0
  for (const execution of executions) {
    const sourceSessionId = sessionIdByExternal.get(execution.session_id)
    const externalEventId = `execution:${execution.external_key}`
    insertObservation.run(
      stableRowId('observation', externalEventId),
      externalEventId,
      execution.started_at,
      sourceSessionId,
      execution.turn_id,
      execution.agent_id,
      execution.workfolder,
      execution.git_root,
      execution.worktree,
      execution.branch,
      JSON.stringify({
        kind: execution.kind,
        legacy_status: execution.status,
        legacy_classification: execution.classification,
      }),
      timestamp,
    )
    insertExecution.run(
      execution.id,
      sourceSessionId,
      execution.turn_id,
      execution.agent_id,
      execution.parent_execution_id,
      execution.kind,
      execution.classification,
      execution.workfolder,
      execution.git_root,
      execution.worktree,
      execution.branch,
      execution.started_at,
      execution.ended_at,
      execution.last_seen_at,
      execution.status === 'interrupted' ? 'legacy_interrupted' : null,
      execution.started_at,
      execution.last_seen_at,
    )
    const segmentId = stableRowId('segment', execution.id)
    insertSegment.run(
      segmentId,
      execution.id,
      execution.started_at,
      execution.ended_at,
      execution.last_seen_at,
      execution.ended_at === null ? null : 'execution_ended',
      execution.started_at,
      execution.last_seen_at,
    )
    if (execution.task_id !== null) {
      insertAttribution.run(
        stableRowId('attribution', execution.id),
        segmentId,
        execution.task_id,
        execution.started_at,
        timestamp,
      )
      acceptedAttributionCount += 1
    }
  }
  return { executionCount: executions.length, acceptedAttributionCount }
}

function insertExecutionIntents(db, tasks, sessionIdByExternal, timestamp) {
  const newestSession = db.prepare(`
    SELECT session_id FROM legacy_task_sessions
    WHERE task_id = ?
    ORDER BY last_seen_at DESC, session_id
    LIMIT 1
  `)
  const insert = db.prepare(`
    INSERT INTO execution_intents (
      id, source_session_id, external_agent_key, task_id, created_at, expires_at, consumed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `)
  for (const task of tasks) {
    if (!nonEmpty(task.agent_key)) continue
    const session = newestSession.get(task.id)
    const sourceSessionId = sessionIdByExternal.get(session?.session_id)
    if (!sourceSessionId) continue
    insert.run(
      stableRowId('intent', `${task.id}\0${task.agent_key}`),
      sourceSessionId,
      task.agent_key,
      task.id,
      task.updated_at,
      timestamp,
      timestamp,
    )
  }
}

function insertTaskEvents(db, sessionIdByExternal) {
  const insert = db.prepare(`
    INSERT INTO task_events (
      id, task_id, event_type, before_json, after_json, actor,
      source_session_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `)
  for (const event of db.prepare('SELECT * FROM legacy_task_events ORDER BY created_at, id').all()) {
    insert.run(
      event.id,
      event.task_id,
      event.event_type,
      event.before_json,
      event.after_json,
      event.actor,
      sessionIdByExternal.get(event.source_session_id) ?? null,
      event.created_at,
    )
  }
}

function insertPlanObservations(db, sessionIdByExternal) {
  const insert = db.prepare(`
    INSERT INTO plan_observations (
      external_key, source_session_id, source_turn_key, plan_revision,
      plan_json, observed_at, reconciled_task_id, reconciled_revision, reconciled_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  for (const plan of db.prepare('SELECT * FROM legacy_plan_observations ORDER BY observed_at').all()) {
    insert.run(
      plan.external_key,
      sessionIdByExternal.get(plan.session_id),
      plan.turn_id,
      plan.external_key,
      plan.plan_json,
      plan.observed_at,
      plan.reconciled_task_id,
      plan.reconciled_revision,
      plan.reconciled_at,
    )
  }
}

function dropLegacyTables(db) {
  db.exec(`
    DROP TABLE legacy_plan_observations;
    DROP TABLE legacy_task_events;
    DROP TABLE legacy_task_executions;
    DROP TABLE legacy_task_sessions;
    DROP TABLE legacy_tasks;
  `)
}

function migrateV2Rows(db, report, timestamp) {
  renameLegacyTables(db)
  createSchemaV3(db)
  insertProjects(db, report, timestamp)
  const tasks = insertTasks(db, report.task_project_map)
  const sessions = sourceSessionPlan(db, report.task_project_map, timestamp)
  insertSourceSessions(db, sessions)
  const sessionIdByExternal = new Map(sessions.map((session) => (
    [session.external_session_id, session.id]
  )))
  insertLegacySessionObservations(db, sessionIdByExternal, timestamp)
  const executionSummary = insertExecutions(db, sessionIdByExternal, timestamp)
  insertExecutionIntents(db, tasks, sessionIdByExternal, timestamp)
  insertTaskEvents(db, sessionIdByExternal)
  insertPlanObservations(db, sessionIdByExternal)
  dropLegacyTables(db)
  return {
    project_count: report.projects.length,
    task_count: tasks.length,
    execution_count: executionSummary.executionCount,
    segment_count: executionSummary.executionCount,
    accepted_attribution_count: executionSummary.acceptedAttributionCount,
  }
}

function migrationCountViolations(report, migrated) {
  return [
    ['MIGRATED_TASK_COUNT_MISMATCH', report.legacy.task_count, migrated.task_count],
    ['MIGRATED_EXECUTION_COUNT_MISMATCH', report.legacy.execution_count, migrated.execution_count],
    ['MIGRATED_SEGMENT_COUNT_MISMATCH', report.legacy.execution_count, migrated.segment_count],
    [
      'MIGRATED_ATTRIBUTION_COUNT_MISMATCH',
      report.legacy.bound_execution_count,
      migrated.accepted_attribution_count,
    ],
  ].filter(([, expected, actual]) => expected !== actual).map(([code, expected, actual]) => ({
    code,
    entity_id: null,
    expected,
    actual,
  }))
}

function migrationInvariants(db, report, migrated) {
  const invariants = checkSchemaV3Invariants(db)
  return {
    ...invariants,
    invariantViolations: [
      ...invariants.invariantViolations,
      ...migrationCountViolations(report, migrated),
    ],
  }
}

function assertMigrationInvariants(invariants) {
  if (
    invariants.integrityCheck !== 'ok'
    || invariants.foreignKeyViolations.length > 0
    || invariants.invariantViolations.length > 0
  ) {
    fail('SCHEMA_MIGRATION_INVALID', 'schema v3 migration failed invariants', invariants)
  }
}

export async function applyV2ToV3({
  databasePath,
  backupPath,
  clock = () => new Date(),
}) {
  if (!nonEmpty(databasePath) || !nonEmpty(backupPath)) {
    throw new TypeError('databasePath and backupPath must be non-empty strings')
  }
  if (resolve(databasePath) === resolve(backupPath)) {
    fail('SCHEMA_MIGRATION_BACKUP_INVALID', 'backup path must differ from database path')
  }
  const value = clock()
  const timestamp = (value instanceof Date ? value : new Date(value)).toISOString()
  const db = new DatabaseSync(databasePath)
  try {
    db.exec('PRAGMA foreign_keys = ON')
    db.exec('PRAGMA busy_timeout = 5000')
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    const report = inspectV2Migration(db)
    const backupMetadata = await createVerifiedBackup(db, backupPath)
    db.exec('PRAGMA foreign_keys = OFF')
    db.exec('BEGIN IMMEDIATE')
    let migrated
    let invariants
    try {
      migrated = migrateV2Rows(db, report, timestamp)
      invariants = migrationInvariants(db, report, migrated)
      assertMigrationInvariants(invariants)
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    } finally {
      db.exec('PRAGMA foreign_keys = ON')
    }
    return { ...report, backup: backupMetadata, migrated, invariants }
  } finally {
    db.close()
  }
}
