import assert from 'node:assert/strict'
import test from 'node:test'

import { createDashboardSnapshot } from '../mcp/src/dashboard-data.mjs'

const baseTask = {
  id: 'task-a', parent_id: null, project: 'Project', title: 'Task A', status: 'active',
  start_date: '2026-08-10', due_date: null, next_action: 'Continue', completed_at: null,
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
    id: 'task-a', parent_id: null, title: 'Task A', status: 'active', agent: 'Codex',
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
    id: 'task-a', parent_id: null, title: 'Task A', status: 'active', agent: 'Claude',
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
