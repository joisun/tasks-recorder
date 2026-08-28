import { expect, test } from 'vitest'

import type { DashboardSnapshot, TaskRecord } from '@/lib/api/types'
import { chooseTimelineScale, projectTaskSnapshot } from './task-projection'

const NOW = new Date('2026-08-28T12:00:00.000Z')

function task(overrides: Partial<TaskRecord> & Pick<TaskRecord, 'id' | 'title'>): TaskRecord {
  const { id, title, ...rest } = overrides
  return {
    id,
    parent_id: 'project:recorder',
    project_id: 'recorder',
    entity_type: 'main_task',
    title,
    description: null,
    lifecycle: 'in_progress',
    status: 'active',
    rollup_state: 'in_progress',
    sort_order: 0,
    revision: 1,
    archived_at: null,
    progress: null,
    agent: 'Codex',
    next_action: null,
    planned: null,
    actual: null,
    actual_segments: [],
    actual_segment_count: 0,
    start: null,
    end: null,
    last_activity: '2026-08-28T10:00:00.000Z',
    updated_at: '2026-08-28T10:00:00.000Z',
    session_id: null,
    session_source: null,
    resume_available: false,
    workspace: '/Users/me/project',
    workfolder: '/Users/me/project',
    worktree: '/Users/me/project',
    branch: 'main',
    execution_count: 0,
    active_execution_count: 0,
    running_execution_count: 0,
    idle_execution_count: 0,
    stale_execution_count: 0,
    active_agent_count: 0,
    live_state: 'none',
    blocked_count: 0,
    ...rest,
  }
}

function snapshot(tasks: TaskRecord[]): DashboardSnapshot {
  return {
    server_instance_id: 'server-a', revision: 1, schema_version: 3,
    generated_at: NOW.toISOString(), home_directory: '/Users/me', tasks,
    projects: [], warnings: [], project_inbox: [], project_inbox_count: 0,
    attribution_inbox_count: 0, unassigned_execution_count: 0,
  }
}

test('projects Project → Main Task → Subtask in latest-active sibling order', () => {
  const tasks = [
    task({
      id: 'project:recorder', title: 'Recorder', parent_id: null, project_id: 'recorder',
      entity_type: 'project', last_activity: '2026-08-28T11:00:00.000Z',
    }),
    task({ id: 'older', title: 'Older', last_activity: '2026-08-26T10:00:00.000Z' }),
    task({ id: 'newer', title: 'Newer', last_activity: '2026-08-28T10:30:00.000Z' }),
    task({
      id: 'child', title: 'Child', parent_id: 'newer', entity_type: 'subtask',
      last_activity: '2026-08-28T10:45:00.000Z',
    }),
  ]

  const { rows } = projectTaskSnapshot(snapshot(tasks), { viewportWidth: 900, now: NOW })

  expect(rows.map(({ id, parent, entity_type }) => [id, parent, entity_type])).toEqual([
    ['project:recorder', 0, 'project'],
    ['newer', 'project:recorder', 'main_task'],
    ['child', 'newer', 'subtask'],
    ['older', 'project:recorder', 'main_task'],
  ])
})

test('all done children display their group as complete without mutating source lifecycle', () => {
  const tasks = [
    task({ id: 'project:recorder', title: 'Recorder', parent_id: null, entity_type: 'project' }),
    task({
      id: 'main', title: 'Main', rollup_state: 'done', progress: {
        remaining: 0, total: 2, completed: 2, ratio: 1,
      },
    }),
    task({ id: 'a', title: 'A', parent_id: 'main', entity_type: 'subtask', lifecycle: 'done', status: 'done', rollup_state: 'done' }),
    task({ id: 'b', title: 'B', parent_id: 'main', entity_type: 'subtask', lifecycle: 'done', status: 'done', rollup_state: 'done' }),
  ]

  const main = projectTaskSnapshot(snapshot(tasks), { viewportWidth: 900, now: NOW })
    .rows.find(({ id }) => id === 'main')

  expect(main?.status).toBe('done')
  expect(main?.status_indicator).toBe('bar')
  expect(main?.progress_count).toBe('2/2')
  expect(tasks[1].lifecycle).toBe('in_progress')
})

test('parent time scope contains every descendant planned and actual range', () => {
  const tasks = [
    task({ id: 'project:recorder', title: 'Recorder', parent_id: null, entity_type: 'project' }),
    task({
      id: 'main', title: 'Main',
      planned: { start: '2026-08-20T00:00:00.000Z', end: '2026-08-25T00:00:00.000Z' },
    }),
    task({
      id: 'early', title: 'Early', parent_id: 'main', entity_type: 'subtask',
      actual: { start: '2026-08-16T08:00:00.000Z', end: '2026-08-18T10:00:00.000Z' },
    }),
    task({
      id: 'late', title: 'Late', parent_id: 'main', entity_type: 'subtask',
      planned: { start: '2026-08-26T00:00:00.000Z', end: '2026-09-04T23:59:59.999Z' },
    }),
  ]

  const rows = projectTaskSnapshot(snapshot(tasks), { viewportWidth: 900, now: NOW }).rows
  const main = rows.find(({ id }) => id === 'main')

  expect(main?.start.toISOString()).toBe('2026-08-16T08:00:00.000Z')
  expect(main?.end.toISOString()).toBe('2026-09-04T23:59:59.999Z')
})

test('independent tasks keep full hierarchy treatment while subtasks use dots', () => {
  const tasks = [
    task({ id: 'project:recorder', title: 'Recorder', parent_id: null, entity_type: 'project' }),
    task({ id: 'independent', title: 'Independent', status: 'planned', lifecycle: 'planned' }),
    task({ id: 'main', title: 'Main' }),
    task({ id: 'child', title: 'Child', parent_id: 'main', entity_type: 'subtask', status: 'planned', lifecycle: 'planned' }),
  ]
  const rows = projectTaskSnapshot(snapshot(tasks), { viewportWidth: 900, now: NOW }).rows

  expect(rows.find(({ id }) => id === 'independent')).toMatchObject({
    status_indicator: 'ring', planned_pattern: 'dash-dot',
  })
  expect(rows.find(({ id }) => id === 'child')).toMatchObject({
    status_indicator: 'dot', planned_pattern: 'dash-dot',
  })
})

test('viewport width changes scale density only, never row identity or order', () => {
  const tasks = [
    task({ id: 'project:recorder', title: 'Recorder', parent_id: null, entity_type: 'project' }),
    task({
      id: 'main', title: 'Main',
      planned: { start: '2026-08-01T00:00:00.000Z', end: '2026-08-24T00:00:00.000Z' },
    }),
  ]
  const wide = projectTaskSnapshot(snapshot(tasks), { viewportWidth: 1200, now: NOW })
  const narrow = projectTaskSnapshot(snapshot(tasks), { viewportWidth: 360, now: NOW })

  expect(wide.rowIds).toEqual(narrow.rowIds)
  expect(wide.scale.id).not.toBe(narrow.scale.id)
})

test('handles empty, archived, and mixed-offset snapshots without invalid dates', () => {
  expect(projectTaskSnapshot(snapshot([]), { viewportWidth: 900, now: NOW })).toMatchObject({
    rows: [], empty: true,
  })
  const result = projectTaskSnapshot(snapshot([
    task({ id: 'archived', title: 'Old', parent_id: null, archived_at: '2026-08-20T00:00:00.000Z' }),
    task({
      id: 'offset', title: 'Offset', parent_id: null,
      actual: { start: '2026-08-20T08:00:00+08:00', end: '2026-08-20T11:00:00+08:00' },
    }),
  ]), { viewportWidth: 900, now: NOW })

  expect(result.rowIds).toEqual(['offset'])
  expect(result.rows[0].start.toISOString()).toBe('2026-08-20T00:00:00.000Z')
})

test('does not open a project whose only children are filtered from the visible tree', () => {
  const result = projectTaskSnapshot(snapshot([
    task({ id: 'project:recorder', title: 'Recorder', parent_id: null, entity_type: 'project' }),
    task({
      id: 'archived-child', title: 'Archived', archived_at: '2026-08-20T00:00:00.000Z',
    }),
  ]), { viewportWidth: 900, now: NOW })

  expect(result.rows).toHaveLength(1)
  expect(result.rows[0]).toMatchObject({ id: 'project:recorder', type: 'summary', open: false })
})

test('scale selection fits project control horizons instead of forcing day detail', () => {
  const domain = {
    minimum: new Date('2026-01-01T00:00:00.000Z'),
    maximum: new Date('2026-06-01T00:00:00.000Z'),
  }
  const scale = chooseTimelineScale(domain, 900)

  expect(scale.id).toBe('month')
  expect(scale.cellWidth).toBeLessThanOrEqual(4)
  expect(scale.start.getTime()).toBeLessThan(domain.minimum.getTime())
  expect(scale.end.getTime()).toBeGreaterThan(domain.maximum.getTime())
})
