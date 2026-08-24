import assert from 'node:assert/strict'
import test from 'node:test'

import {
  SVAR_GRID_COLUMNS,
  SVAR_ROW_HEIGHT,
  SVAR_SCALE_HEIGHT,
  createSvarScales,
  createSvarTaskProjection,
  currentTimePosition,
  filterSvarTasks,
  normalizeRendererState,
} from '../ui/src/svar-gantt-state.mjs'

const NOW = new Date('2026-08-16T10:00:00.000Z')
const tasks = [
  {
    id: 'child-b', parent_id: 'root', title: 'Second child', status: 'waiting',
    start: '2026-08-15T09:00:00.000Z', end: null, last_activity: '2026-08-16T09:50:00.000Z',
    session_id: 'session-child', workfolder: '/Users/me/project', worktree: null,
    branch: 'feature/svar', next_action: 'Wait for review', agent: 'Codex',
    active_agent_count: 1, execution_count: 2, updated_at: '2026-08-16T09:50:00.000Z',
  },
  {
    id: 'history-child', parent_id: 'history-root', title: 'Historical child', status: 'done',
    start: '2026-08-10T08:00:00.000Z', end: '2026-08-10T09:00:00.000Z',
    last_activity: '2026-08-10T09:00:00.000Z', active_agent_count: 0, execution_count: 1,
    updated_at: '2026-08-10T09:00:00.000Z',
  },
  {
    id: 'root', parent_id: null, title: 'Ship SVAR dashboard', status: 'active',
    start: '2026-08-14T08:00:00.000Z', end: null, last_activity: '2026-08-16T09:45:00.000Z',
    progress: { remaining: 1, total: 2, completed: 1, ratio: 0.5 },
    session_id: '019fa297-4567-7bf0-a69a-84fd23b3aaab',
    workfolder: '/Users/me/project', worktree: '/Users/me/project/.worktree/feature-svar',
    branch: 'feature/svar', next_action: 'Finish renderer integration', agent: 'Codex',
    active_agent_count: 2, execution_count: 5, updated_at: '2026-08-16T09:45:00.000Z',
  },
  {
    id: 'history-root', parent_id: null, title: 'Old dashboard work', status: 'done',
    start: '2026-08-10T08:00:00.000Z', end: '2026-08-10T09:00:00.000Z',
    last_activity: '2026-08-10T09:00:00.000Z', archived_at: '2026-08-10T10:00:00.000Z',
    active_agent_count: 0, execution_count: 1, updated_at: '2026-08-10T09:00:00.000Z',
  },
  {
    id: 'child-a', parent_id: 'root', title: 'First child', status: 'done',
    start: '2026-08-14T08:00:00.000Z', end: '2026-08-15T08:00:00.000Z',
    last_activity: '2026-08-15T08:00:00.000Z', active_agent_count: 0, execution_count: 3,
    updated_at: '2026-08-15T08:00:00.000Z',
  },
]

test('projects matching root subtrees in stable tree order without inventing rows', () => {
  const projected = createSvarTaskProjection(tasks, {
    filter: 'all',
    openIds: new Set(['root']),
    now: NOW,
    homeDirectory: '/Users/me',
  })

  assert.deepEqual(projected.map(({ id, parent, open }) => ({ id, parent, open })), [
    { id: 'root', parent: 0, open: true },
    { id: 'child-b', parent: 'root', open: false },
    { id: 'child-a', parent: 'root', open: false },
  ])
  assert.deepEqual(filterSvarTasks(tasks, 'history').map(({ id }) => id), [
    'history-root', 'history-child',
  ])
})

test('retains every Dashboard field and converts dates and progress for SVAR', () => {
  const [root] = createSvarTaskProjection(tasks, {
    filter: 'active', openIds: new Set(['root']), now: NOW, homeDirectory: '/Users/me',
    timeZone: 'UTC',
  })

  assert.equal(root.type, 'summary')
  assert.equal(root.text, 'Ship SVAR dashboard')
  assert.equal(root.start.toISOString(), '2026-08-14T08:00:00.000Z')
  assert.equal(root.end.toISOString(), '2026-08-16T10:10:00.000Z')
  assert.equal(root.progress, 50)
  assert.equal(root.status, 'active')
  assert.equal(root.session_id, '019fa297-4567-7bf0-a69a-84fd23b3aaab')
  assert.equal(root.workspace, '/Users/me/project')
  assert.equal(root.workspace_display, '~/project')
  assert.equal(root.branch, 'feature/svar')
  assert.equal(root.note, 'Finish renderer integration')
  assert.equal(root.active_agent_count, 2)
  assert.equal(root.execution_count, 5)
  assert.equal(root.last_activity, '2026-08-16T09:45:00.000Z')
  assert.equal(root.updated_at, '2026-08-16T09:45:00.000Z')
  assert.deepEqual(root.activity, {
    text: '15m ago', title: '2026-08-16 09:45', tone: 'default', minutes: 15,
  })
})

test('summary tasks span the complete time envelope of every descendant', () => {
  const hierarchy = [
    {
      id: 'root', parent_id: null, title: 'Project scope', status: 'active',
      start: '2026-08-16T10:00:00.000Z', end: '2026-08-16T11:00:00.000Z',
      last_activity: '2026-08-16T11:00:00.000Z',
    },
    {
      id: 'early-child', parent_id: 'root', title: 'Discovery', status: 'done',
      start: '2026-08-14T08:00:00.000Z', end: '2026-08-15T08:00:00.000Z',
      last_activity: '2026-08-15T08:00:00.000Z',
    },
    {
      id: 'late-child', parent_id: 'root', title: 'Delivery', status: 'active',
      start: '2026-08-17T08:00:00.000Z', end: '2026-08-18T18:00:00.000Z',
      last_activity: '2026-08-18T18:00:00.000Z',
    },
    {
      id: 'nested-child', parent_id: 'late-child', title: 'Release', status: 'done',
      start: '2026-08-18T12:00:00.000Z', end: '2026-08-20T09:00:00.000Z',
      last_activity: '2026-08-20T09:00:00.000Z',
    },
  ]

  const projected = createSvarTaskProjection(hierarchy, { now: NOW })
  const root = projected.find(({ id }) => id === 'root')
  const lateChild = projected.find(({ id }) => id === 'late-child')

  assert.equal(root.start.toISOString(), '2026-08-14T08:00:00.000Z')
  assert.equal(root.end.toISOString(), '2026-08-20T09:00:00.000Z')
  assert.equal(lateChild.start.toISOString(), '2026-08-17T08:00:00.000Z')
  assert.equal(lateChild.end.toISOString(), '2026-08-20T09:00:00.000Z')
})

test('summary envelopes include descendant planned and actual ranges even when the parent has canonical dates', () => {
  const hierarchy = [
    {
      id: 'project', parent_id: null, entity_type: 'project', title: 'Project', status: 'active',
      start: '2026-08-01T00:00:00.000Z', end: null,
      actual: { start: '2026-08-01T00:00:00.000Z', end: '2026-08-10T00:00:00.000Z' },
      planned: { start: '2026-08-01T00:00:00.000Z', end: '2026-08-14T00:00:00.000Z' },
    },
    {
      id: 'rollout', parent_id: 'project', entity_type: 'main_task', title: 'Rollout', status: 'planned',
      start: '2026-08-23T00:00:00.000Z', end: null,
      actual: null,
      planned: { start: '2026-08-23T00:00:00.000Z', end: '2026-09-05T00:00:00.000Z' },
    },
  ]

  const projected = createSvarTaskProjection(hierarchy, { now: NOW })
  const project = projected.find(({ id }) => id === 'project')

  assert.equal(project.start.toISOString(), '2026-08-01T00:00:00.000Z')
  assert.equal(project.end.toISOString(), '2026-09-05T00:00:00.000Z')
  assert.equal(project.base_start.toISOString(), '2026-08-01T00:00:00.000Z')
  assert.equal(project.base_end.toISOString(), '2026-09-05T00:00:00.000Z')
})

test('defines six decision-focused grid columns with activity second', () => {
  assert.equal(SVAR_ROW_HEIGHT, 30)
  assert.equal(SVAR_SCALE_HEIGHT, 24)
  assert.deepEqual(SVAR_GRID_COLUMNS.map(({ id, header }) => [id, header]), [
    ['text', '任务'],
    ['activity', '最近活跃'],
    ['status', '状态 / 进度'],
    ['workspace', 'Workspace'],
    ['branch', 'Branch'],
    ['session_id', 'Session ID'],
  ])
  assert.equal(SVAR_GRID_COLUMNS.find(({ id }) => id === 'activity').width, 100)
  assert.equal(SVAR_GRID_COLUMNS.reduce((total, { width }) => total + width, 0), 684)
  assert.deepEqual(SVAR_GRID_COLUMNS.map(({ id, resize }) => [id, resize]), [
    ['text', true],
    ['activity', true],
    ['status', true],
    ['workspace', true],
    ['branch', true],
    ['session_id', false],
  ])
})

test('history keeps ancestors as context while current hides archived task branches', () => {
  const hierarchy = [
    { id: 'project', parent_id: null, entity_type: 'project', title: 'Project', status: 'active' },
    { id: 'main', parent_id: 'project', entity_type: 'main_task', title: 'Main', status: 'active' },
    { id: 'current', parent_id: 'main', entity_type: 'subtask', title: 'Current', status: 'active' },
    {
      id: 'archived', parent_id: 'main', entity_type: 'subtask', title: 'Archived', status: 'done',
      archived_at: '2026-08-16T09:00:00.000Z',
    },
  ]

  assert.deepEqual(filterSvarTasks(hierarchy, 'all').map(({ id }) => id), [
    'project', 'main', 'current',
  ])
  assert.deepEqual(filterSvarTasks(hierarchy, 'history').map(({ id, history_context }) => (
    [id, Boolean(history_context)]
  )), [
    ['project', true], ['main', true], ['archived', false],
  ])
})

test('maps canonical actual segments to native split tasks and planned range to baseline', () => {
  const canonical = [{
    id: 'subtask', parent_id: null, entity_type: 'subtask', title: 'Dashboard read model',
    status: 'active', lifecycle: 'in_progress',
    actual: { start: '2026-08-19T08:00:00.000Z', end: '2026-08-19T13:00:00.000Z' },
    actual_segments: [
      { id: 'segment-1', start: '2026-08-19T08:00:00.000Z', end: '2026-08-19T10:00:00.000Z' },
      { id: 'segment-2', start: '2026-08-19T12:00:00.000Z', end: '2026-08-19T13:00:00.000Z' },
    ],
    planned: { start: '2026-08-19T00:00:00.000Z', end: '2026-08-21T23:59:59.999Z' },
    last_activity: '2026-08-19T13:00:00.000Z', updated_at: '2026-08-19T13:00:00.000Z',
  }]
  const [projected] = createSvarTaskProjection(canonical, { now: NOW })

  assert.equal(projected.start.toISOString(), '2026-08-19T08:00:00.000Z')
  assert.equal(projected.end.toISOString(), '2026-08-19T13:00:00.000Z')
  assert.equal(projected.base_start.toISOString(), '2026-08-19T00:00:00.000Z')
  assert.equal(projected.base_end.toISOString(), '2026-08-21T23:59:59.999Z')
  assert.deepEqual(projected.segments.map(({ start, end }) => [start.toISOString(), end.toISOString()]), [
    ['2026-08-19T08:00:00.000Z', '2026-08-19T10:00:00.000Z'],
    ['2026-08-19T12:00:00.000Z', '2026-08-19T13:00:00.000Z'],
  ])
  assert.equal(projected.visual_mode, 'actual_with_plan')
})

test('uses an outline planned bar when no actual segment exists', () => {
  const [projected] = createSvarTaskProjection([{
    id: 'planned', parent_id: null, entity_type: 'main_task', title: 'Release', status: 'planned',
    planned: { start: '2026-08-23T00:00:00.000Z', end: '2026-08-28T23:59:59.999Z' },
    actual: null, actual_segments: [], last_activity: null,
    updated_at: '2026-08-20T00:00:00.000Z',
  }], { now: NOW })

  assert.equal(projected.start.toISOString(), '2026-08-23T00:00:00.000Z')
  assert.equal(projected.end.toISOString(), '2026-08-28T23:59:59.999Z')
  assert.equal(projected.base_start, undefined)
  assert.equal(projected.visual_mode, 'planned_only')
})

test('creates the date scale and normalizes malformed renderer state safely', () => {
  const bounds = {
    minimum: new Date('2026-08-14T00:00:00.000Z'),
    maximum: new Date('2026-08-18T00:00:00.000Z'),
  }
  const result = createSvarScales(bounds)
  assert.ok(result.start <= bounds.minimum)
  assert.ok(result.end >= bounds.maximum)
  assert.equal(result.resolvedZoom, 'day')
  assert.equal(result.lengthUnit, 'day')
  assert.equal(result.cellWidth, 44)
  assert.deepEqual(result.scales.map(({ unit, step }) => [unit, step]), [
    ['month', 1], ['day', 1],
  ])

  const day = createSvarScales(bounds, 'day')
  assert.equal(day.lengthUnit, 'day')
  assert.equal(day.cellWidth, 44)
  assert.ok(day.end - day.start >= 21 * 24 * 60 * 60_000)
  assert.deepEqual(day.scales.map(({ unit, step }) => [unit, step]), [
    ['month', 1], ['day', 1],
  ])

  const month = createSvarScales(bounds, 'month')
  assert.equal(month.lengthUnit, 'day')
  assert.equal(month.cellWidth, 4)
  assert.ok(month.end - month.start >= 240 * 24 * 60 * 60_000)
  assert.deepEqual(month.scales.map(({ unit, step }) => [unit, step]), [
    ['year', 1], ['month', 1],
  ])

  assert.deepEqual(normalizeRendererState({
    displayMode: 'invalid', gridWidth: -1, openIds: ['root', 42], timelineX: 'bad',
  }, { minimum: 240, maximum: 1111 }), {
    displayMode: 'all',
    gridWidth: 792,
    openIds: new Set(['root', '42']),
    gridX: 0,
    timelineX: 0,
    verticalY: 0,
    selectedTaskId: null,
    taskColumnWidth: 240,
    labelsVisible: false,
    timelineZoom: 'auto',
  })
})

test('auto scale follows the visible project extent from hours through quarters', () => {
  const at = (days) => ({
    minimum: new Date('2026-01-01T00:00:00.000Z'),
    maximum: new Date(Date.parse('2026-01-01T00:00:00.000Z') + days * 24 * 60 * 60_000),
  })
  const short = createSvarScales(at(1), 'auto')
  const sprint = createSvarScales(at(14), 'auto')
  const project = createSvarScales(at(75), 'auto')
  const portfolio = createSvarScales(at(240), 'auto')

  assert.deepEqual(
    [short.resolvedZoom, sprint.resolvedZoom, project.resolvedZoom, portfolio.resolvedZoom],
    ['hour', 'day', 'week', 'month'],
  )
  assert.deepEqual(short.scales.map(({ unit, step }) => [unit, step]), [['day', 1], ['hour', 6]])
  assert.deepEqual(project.scales.map(({ unit, step }) => [unit, step]), [['month', 1], ['week', 1]])
  assert.deepEqual(portfolio.scales.map(({ unit, step }) => [unit, step]), [['year', 1], ['quarter', 1]])
  for (const [bounds, scale] of [[at(1), short], [at(14), sprint], [at(75), project], [at(240), portfolio]]) {
    const padding = scale.end - scale.start - (bounds.maximum - bounds.minimum)
    assert.ok(padding >= (bounds.maximum - bounds.minimum) * 0.16)
    assert.ok(padding <= (bounds.maximum - bounds.minimum) * 0.25)
  }
})

test('positions current time only when it falls inside the visible timeline viewport', () => {
  const base = {
    timelineStart: new Date('2026-08-16T08:00:00.000Z'),
    timelineEnd: new Date('2026-08-16T12:00:00.000Z'),
    contentWidth: 800,
    viewportWidth: 500,
  }
  assert.deepEqual(currentTimePosition({
    ...base, now: new Date('2026-08-16T10:00:00.000Z'), scrollLeft: 100,
  }), { visible: true, x: 300, contentX: 400 })
  assert.deepEqual(currentTimePosition({
    ...base, now: new Date('2026-08-16T07:59:59.000Z'), scrollLeft: 0,
  }), { visible: false, x: 0, contentX: 0 })
  assert.deepEqual(currentTimePosition({
    ...base, now: new Date('2026-08-16T11:30:00.000Z'), scrollLeft: 500,
  }), { visible: true, x: 200, contentX: 700 })
})
