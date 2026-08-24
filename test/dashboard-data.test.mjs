import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createDashboardSnapshot,
  createJournalDashboardSnapshot,
} from '../mcp/src/dashboard-data.mjs'

const baseTask = {
  id: 'task-a', parent_id: null, project: 'Project', title: 'Task A', status: 'active',
  description: null, agent_key: null, sort_order: 0, revision: 1,
  start_date: '2026-08-10', due_date: null, next_action: 'Continue', completed_at: null,
  archived_at: null, deleted_at: null,
  created_at: '2026-08-10T08:00:00.000Z', updated_at: '2026-08-10T08:00:00.000Z',
}

test('dashboard snapshot uses newest session activity and agent', () => {
  const result = createDashboardSnapshot({
    tasks: [baseTask],
    sessions: [
      { task_id: 'task-a', session_id: 'old', agent: 'Claude', last_seen_at: '2026-08-10T09:00:00.000Z' },
      { task_id: 'task-a', session_id: 'new', agent: 'Codex', last_seen_at: '2026-08-12T09:30:00.000Z' },
    ],
  }, { now: new Date('2026-08-12T09:47:00.000Z') })

  assert.deepEqual(result.tasks[0], {
    id: 'task-a', parent_id: null, title: 'Task A', description: null,
    status: 'active', agent_key: null, sort_order: 0, revision: 1, archived_at: null,
    progress: null, execution_count: 0, active_execution_count: 0, active_agent_count: 0,
    agent: 'Codex',
    start: '2026-08-10T08:00:00.000Z', end: null,
    last_activity: '2026-08-12T09:30:00.000Z', next_action: 'Continue',
    session_id: 'new',
    workfolder: null, worktree: null, branch: null,
    updated_at: '2026-08-10T08:00:00.000Z',
  })
  assert.deepEqual(result.warnings, [])
})

test('dashboard snapshot takes context from one newest valid session', () => {
  const result = createDashboardSnapshot({
    tasks: [baseTask],
    sessions: [
      {
        task_id: 'task-a', session_id: 'old', workfolder: '/Users/me/old',
        worktree: '/Users/me/old', branch: 'old', agent: 'Claude',
        last_seen_at: '2026-08-12T09:20:00.000Z',
      },
      {
        task_id: 'task-a', session_id: 'new', workfolder: '/Users/me/new',
        worktree: null, branch: null, agent: null,
        last_seen_at: '2026-08-12T09:30:00.000Z',
      },
      {
        task_id: 'task-a', session_id: 'invalid', workfolder: '/invalid',
        worktree: '/invalid', branch: 'invalid', agent: 'Invalid',
        last_seen_at: 'not-an-instant',
      },
    ],
  }, {
    now: new Date('2026-08-12T09:47:00.000Z'),
    homeDirectory: '/Users/me',
  })

  assert.equal(result.home_directory, '/Users/me')
  assert.deepEqual(result.tasks[0], {
    id: 'task-a', parent_id: null, title: 'Task A', description: null,
    status: 'active', agent_key: null, sort_order: 0, revision: 1, archived_at: null,
    progress: null, execution_count: 0, active_execution_count: 0, active_agent_count: 0,
    agent: 'Claude',
    start: '2026-08-10T08:00:00.000Z', end: null,
    last_activity: '2026-08-12T09:30:00.000Z', next_action: 'Continue',
    session_id: 'new',
    workfolder: '/Users/me/new', worktree: null, branch: null,
    updated_at: '2026-08-10T08:00:00.000Z',
  })
})

test('dashboard snapshot keeps latest activity while falling back to newest known Agent', () => {
  const result = createDashboardSnapshot({
    tasks: [baseTask],
    sessions: [
      { task_id: 'task-a', session_id: 'known', agent: 'Codex', last_seen_at: '2026-08-12T09:20:00.000Z' },
      { task_id: 'task-a', session_id: 'legacy', agent: null, last_seen_at: '2026-08-12T09:30:00.000Z' },
    ],
  }, { now: new Date('2026-08-12T09:47:00.000Z') })

  assert.equal(result.tasks[0].last_activity, '2026-08-12T09:30:00.000Z')
  assert.equal(result.tasks[0].agent, 'Codex')
})

test('dashboard snapshot safely omits invalid hierarchy, dates, and status', () => {
  const result = createDashboardSnapshot({
    tasks: [
      baseTask,
      { ...baseTask, id: 'orphan', parent_id: 'missing' },
      { ...baseTask, id: 'orphan-child', parent_id: 'orphan' },
      { ...baseTask, id: 'cycle-a', parent_id: 'cycle-b' },
      { ...baseTask, id: 'cycle-b', parent_id: 'cycle-a' },
      { ...baseTask, id: 'invalid-date', created_at: 'not-a-date' },
      { ...baseTask, id: 'impossible-date', start_date: '2026-02-30' },
      { ...baseTask, id: 'invalid-status', status: 'stale' },
      { ...baseTask, id: 'invalid-version', updated_at: 'not-an-instant' },
    ],
    sessions: [],
  }, { now: new Date('2026-08-12T09:47:00.000Z') })

  assert.deepEqual(result.tasks.map(({ id }) => id), ['task-a'])
  assert.deepEqual(result.warnings.map(({ code }) => code).sort(), [
    'TASK_ANCESTOR_INVALID', 'TASK_DATE_INVALID', 'TASK_DATE_INVALID', 'TASK_DATE_INVALID',
    'TASK_HIERARCHY_CYCLE', 'TASK_HIERARCHY_CYCLE',
    'TASK_PARENT_MISSING', 'TASK_STATUS_INVALID',
  ])
  assert.equal(result.tasks[0].agent, 'Unknown')
  assert.equal(result.tasks[0].last_activity, '2026-08-10T08:00:00.000Z')
})

test('dashboard snapshot exposes completed and due-date end instants', () => {
  const result = createDashboardSnapshot({
    tasks: [
      { ...baseTask, id: 'done-task', status: 'done', completed_at: '2026-08-11T11:12:00.000Z' },
      { ...baseTask, id: 'due-task', due_date: '2026-08-14' },
    ],
    sessions: [],
  }, { now: new Date('2026-08-12T09:47:00.000Z') })

  assert.equal(result.tasks[0].end, '2026-08-11T11:12:00.000Z')
  assert.equal(result.tasks[1].end, '2026-08-14T23:59:59.999Z')
})

test('dashboard snapshot exposes v2 tree and execution aggregates without full histories', () => {
  const result = createDashboardSnapshot({
    tasks: [
      {
        ...baseTask,
        id: 'root',
        title: 'Ship task tree',
        description: 'One delivery goal',
        revision: 7,
        agent_key: 'codex',
        sort_order: 0,
        archived_at: null,
        deleted_at: null,
      },
      { ...baseTask, id: 'done-child', parent_id: 'root', status: 'done', revision: 2 },
      { ...baseTask, id: 'active-child', parent_id: 'root', status: 'active', revision: 3 },
      { ...baseTask, id: 'canceled-child', parent_id: 'root', status: 'canceled', revision: 4 },
      {
        ...baseTask,
        id: 'deleted-child',
        parent_id: 'root',
        status: 'active',
        revision: 5,
        deleted_at: '2026-08-12T08:00:00.000Z',
      },
      {
        ...baseTask,
        id: 'archived-root',
        status: 'done',
        revision: 2,
        archived_at: '2026-08-12T08:00:00.000Z',
      },
      {
        ...baseTask,
        id: 'deleted-root',
        revision: 2,
        deleted_at: '2026-08-12T08:00:00.000Z',
      },
    ],
    sessions: [],
    task_execution_aggregates: [{
      task_id: 'root',
      execution_count: 5,
      active_execution_count: 2,
      active_agent_count: 2,
      recent_execution: {
        session_id: 'session-new',
        agent_type: 'Codex',
        workfolder: '/Users/me/project',
        worktree: '/Users/me/project/.worktree/feature-tree',
        branch: 'feature/tree',
        last_seen_at: '2026-08-12T09:45:00.000Z',
      },
    }],
    unassigned_execution_count: 3,
  }, {
    now: new Date('2026-08-12T09:47:00.000Z'),
    homeDirectory: '/Users/me',
  })

  assert.deepEqual(result.tasks.map(({ id }) => id), [
    'root', 'done-child', 'active-child', 'canceled-child', 'archived-root',
  ])
  const root = result.tasks.find(({ id }) => id === 'root')
  assert.deepEqual(root.progress, { remaining: 1, total: 2, completed: 1, ratio: 0.5 })
  assert.equal(root.description, 'One delivery goal')
  assert.equal(root.revision, 7)
  assert.equal(root.agent_key, 'codex')
  assert.equal(root.execution_count, 5)
  assert.equal(root.active_execution_count, 2)
  assert.equal(root.active_agent_count, 2)
  assert.equal(root.session_id, 'session-new')
  assert.equal(root.worktree, '/Users/me/project/.worktree/feature-tree')
  assert.equal(result.tasks.find(({ id }) => id === 'active-child').progress, null)
  assert.equal(result.tasks.find(({ id }) => id === 'archived-root').archived_at, '2026-08-12T08:00:00.000Z')
  assert.equal(result.unassigned_execution_count, 3)
  assert.equal('executions' in result, false)
  assert.equal('task_events' in result, false)
})

const v3Project = {
  id: 'recorder', name: 'Tasks Recorder', description: 'Local project journalist', revision: 2,
  archived_at: null, created_at: '2026-08-18T08:00:00.000Z', updated_at: '2026-08-20T08:00:00.000Z',
}

function v3Task(overrides = {}) {
  return {
    id: 'main', project_id: 'recorder', parent_id: null, title: 'Ship journalist model',
    description: null, lifecycle: 'in_progress', planned_start_at: '2026-08-18T00:00:00.000Z',
    planned_due_at: '2026-08-28T23:59:59.999Z', next_action: 'Finish dashboard', sort_order: 0,
    revision: 3, completed_at: null, archived_at: null, deleted_at: null,
    created_at: '2026-08-18T08:00:00.000Z', updated_at: '2026-08-20T08:00:00.000Z',
    ...overrides,
  }
}

function v3Snapshot() {
  return {
    projects: [v3Project],
    project_locations: [{
      id: 'location-recorder', project_id: 'recorder', kind: 'workspace',
      normalized_value: '/Users/me/tasks-recorder', display_value: '/Users/me/tasks-recorder',
      last_seen_at: '2026-08-20T09:00:00.000Z', created_at: '2026-08-18T08:00:00.000Z',
    }],
    tasks: [
      v3Task(),
      v3Task({
        id: 'dashboard', parent_id: 'main', title: 'Build Project dashboard', lifecycle: 'in_progress',
        planned_start_at: '2026-08-19T00:00:00.000Z', planned_due_at: '2026-08-22T23:59:59.999Z',
      }),
      v3Task({
        id: 'release', parent_id: 'main', title: 'Release safely', lifecycle: 'planned',
        planned_start_at: '2026-08-23T00:00:00.000Z', planned_due_at: '2026-08-28T23:59:59.999Z',
      }),
    ],
    source_sessions: [{
      id: 'source-session-1', source: 'codex', external_session_id: 'session-external-1',
      root_external_session_id: 'session-external-1', project_id: 'recorder',
      first_seen_at: '2026-08-19T08:00:00.000Z', last_seen_at: '2026-08-20T09:59:00.000Z',
    }, {
      id: 'source-session-unresolved', source: 'claude', external_session_id: 'session-unresolved',
      root_external_session_id: 'session-unresolved', project_id: null,
      first_seen_at: '2026-08-20T07:00:00.000Z', last_seen_at: '2026-08-20T07:30:00.000Z',
    }],
    executions: [{
      id: 'execution-1', source_session_id: 'source-session-1', source_turn_key: 'turn-1',
      source_agent_key: 'codex-main', parent_execution_id: null, kind: 'main', classification: 'work',
      workfolder: '/Users/me/tasks-recorder', git_root: '/Users/me/tasks-recorder',
      git_common_dir: '/Users/me/tasks-recorder/.git', git_remote: null,
      worktree: '/Users/me/tasks-recorder/.worktree/feature-journalist-model-v3',
      branch: 'feature/journalist-model-v3', started_at: '2026-08-19T08:00:00.000Z',
      ended_at: null, last_seen_at: '2026-08-20T09:59:00.000Z', end_reason: null,
      created_at: '2026-08-19T08:00:00.000Z', updated_at: '2026-08-20T09:59:00.000Z',
    }],
    segments: [
      {
        id: 'segment-a1', execution_id: 'execution-1', task_id: 'dashboard',
        attribution_id: 'attribution-a1', attribution_provenance: 'agent_explicit',
        started_at: '2026-08-19T08:00:00.000Z', ended_at: '2026-08-19T10:00:00.000Z',
        last_seen_at: '2026-08-19T10:00:00.000Z', close_reason: 'focus_changed', summary: null,
        created_at: '2026-08-19T08:00:00.000Z', updated_at: '2026-08-19T10:00:00.000Z',
      },
      {
        id: 'segment-b', execution_id: 'execution-1', task_id: 'release',
        attribution_id: 'attribution-b', attribution_provenance: 'agent_explicit',
        started_at: '2026-08-19T10:00:00.000Z', ended_at: '2026-08-19T11:00:00.000Z',
        last_seen_at: '2026-08-19T11:00:00.000Z', close_reason: 'focus_changed', summary: null,
        created_at: '2026-08-19T10:00:00.000Z', updated_at: '2026-08-19T11:00:00.000Z',
      },
      {
        id: 'segment-a2', execution_id: 'execution-1', task_id: 'dashboard',
        attribution_id: 'attribution-a2', attribution_provenance: 'agent_explicit',
        started_at: '2026-08-19T11:00:00.000Z', ended_at: null,
        last_seen_at: '2026-08-20T09:59:00.000Z', close_reason: null, summary: 'Continue dashboard',
        created_at: '2026-08-19T11:00:00.000Z', updated_at: '2026-08-20T09:59:00.000Z',
      },
    ],
    project_inbox_count: 1,
    attribution_inbox_count: 3,
  }
}

test('v3 dashboard read model roots the hierarchy at Project and keeps A to B to A segments', () => {
  const result = createJournalDashboardSnapshot(v3Snapshot(), {
    now: new Date('2026-08-20T10:00:00.000Z'), homeDirectory: '/Users/me',
    resumableSessionIds: new Set(['session-external-1']),
  })

  assert.equal(result.schema_version, 3)
  assert.deepEqual(result.tasks.map(({ id, parent_id, entity_type }) => ({ id, parent_id, entity_type })), [
    { id: 'project:recorder', parent_id: null, entity_type: 'project' },
    { id: 'main', parent_id: 'project:recorder', entity_type: 'main_task' },
    { id: 'dashboard', parent_id: 'main', entity_type: 'subtask' },
    { id: 'release', parent_id: 'main', entity_type: 'subtask' },
  ])
  const dashboard = result.tasks.find(({ id }) => id === 'dashboard')
  assert.deepEqual(dashboard.actual_segments.map(({ id, start, end }) => ({ id, start, end })), [
    { id: 'segment-a1', start: '2026-08-19T08:00:00.000Z', end: '2026-08-19T10:00:00.000Z' },
    { id: 'segment-a2', start: '2026-08-19T11:00:00.000Z', end: '2026-08-20T09:59:00.000Z' },
  ])
  assert.equal(dashboard.session_id, 'session-external-1')
  assert.equal(dashboard.session_source, 'codex')
  assert.equal(dashboard.resume_available, true)
  assert.equal(dashboard.live_state, 'running')
  assert.equal(dashboard.branch, 'feature/journalist-model-v3')
  assert.deepEqual(dashboard.planned, {
    start: '2026-08-19T00:00:00.000Z', end: '2026-08-22T23:59:59.999Z',
  })
  assert.equal(result.project_inbox_count, 1)
  assert.deepEqual(result.project_inbox, [{
    id: 'source-session-unresolved', source: 'claude',
    external_session_id: 'session-unresolved', root_external_session_id: 'session-unresolved',
    first_seen_at: '2026-08-20T07:00:00.000Z', last_seen_at: '2026-08-20T07:30:00.000Z',
    agent: 'Claude', workfolder: null, worktree: null, branch: null,
  }])
  assert.equal(result.attribution_inbox_count, 3)
  assert.equal(result.unassigned_execution_count, 3)
})

test('v3 dashboard summary ranges contain descendant actual and planned scopes', () => {
  const result = createJournalDashboardSnapshot(v3Snapshot(), {
    now: new Date('2026-08-20T10:00:00.000Z'), homeDirectory: '/Users/me',
  })
  const project = result.tasks.find(({ id }) => id === 'project:recorder')
  const main = result.tasks.find(({ id }) => id === 'main')

  for (const row of [project, main]) {
    assert.deepEqual(row.actual, {
      start: '2026-08-19T08:00:00.000Z', end: '2026-08-20T09:59:00.000Z',
    })
    assert.deepEqual(row.planned, {
      start: '2026-08-18T00:00:00.000Z', end: '2026-08-28T23:59:59.999Z',
    })
    assert.equal(row.actual_segment_count, 3)
    assert.equal(row.actual_segments.length, 1)
  }
  assert.deepEqual(main.progress, { remaining: 2, total: 2, completed: 0, ratio: 0 })
  assert.equal(project.blocked_count, 0)
  assert.equal(project.running_execution_count, 1)
})

test('v3 dashboard derives idle and stale without pretending every open execution is running', () => {
  const snapshot = v3Snapshot()
  snapshot.executions.push(
    { ...snapshot.executions[0], id: 'execution-idle', last_seen_at: '2026-08-20T09:52:00.000Z' },
    { ...snapshot.executions[0], id: 'execution-stale', last_seen_at: '2026-08-20T09:30:00.000Z' },
  )
  const result = createJournalDashboardSnapshot(snapshot, {
    now: new Date('2026-08-20T10:00:00.000Z'),
  })
  const project = result.tasks.find(({ entity_type }) => entity_type === 'project')
  assert.equal(project.running_execution_count, 1)
  assert.equal(project.idle_execution_count, 1)
  assert.equal(project.stale_execution_count, 1)
  assert.equal(project.active_execution_count, 3)
})

test('v3 dashboard derives completed groups and orders sibling branches by subtree activity', () => {
  const snapshot = v3Snapshot()
  snapshot.tasks = [
    v3Task({
      id: 'older-main', title: 'Older completed group', lifecycle: 'in_progress', sort_order: 0,
      updated_at: '2026-08-19T07:00:00.000Z',
    }),
    v3Task({
      id: 'older-child', parent_id: 'older-main', title: 'Older child', lifecycle: 'done',
      updated_at: '2026-08-19T08:00:00.000Z', completed_at: '2026-08-19T08:00:00.000Z',
    }),
    v3Task({
      id: 'newer-main', title: 'Newer completed group', lifecycle: 'in_progress', sort_order: 1,
      updated_at: '2026-08-20T07:00:00.000Z',
    }),
    v3Task({
      id: 'newer-child', parent_id: 'newer-main', title: 'Newer child', lifecycle: 'done',
      updated_at: '2026-08-20T08:30:00.000Z', completed_at: '2026-08-20T08:30:00.000Z',
    }),
  ]
  snapshot.segments = []
  snapshot.executions = []

  const result = createJournalDashboardSnapshot(snapshot, {
    now: new Date('2026-08-20T10:00:00.000Z'),
  })

  assert.deepEqual(result.tasks.map(({ id }) => id), [
    'project:recorder', 'newer-main', 'newer-child', 'older-main', 'older-child',
  ])
  const project = result.tasks[0]
  const newer = result.tasks.find(({ id }) => id === 'newer-main')
  assert.equal(newer.lifecycle, 'in_progress')
  assert.equal(newer.status, 'active')
  assert.equal(newer.rollup_state, 'done')
  assert.equal(newer.last_activity, '2026-08-20T08:30:00.000Z')
  assert.deepEqual(newer.progress, { remaining: 0, total: 1, completed: 1, ratio: 1 })
  assert.equal(project.rollup_state, 'done')
  assert.deepEqual(project.progress, { remaining: 0, total: 2, completed: 2, ratio: 1 })
  assert.equal(project.last_activity, '2026-08-20T08:30:00.000Z')
})
