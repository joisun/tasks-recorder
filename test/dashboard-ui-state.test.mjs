import assert from 'node:assert/strict'
import test from 'node:test'

import * as dashboardState from '../ui/src/dashboard-state.mjs'

import {
  createTaskIndex,
  createGanttLayout,
  endOf,
  escapeHtml,
  estimatedTimelineLabelWidth,
  formatHomePath,
  isArchivedGroup,
  isHistoricalRoot,
  labelPlacement,
  progressOf,
  readBooleanPreference,
  retainedGridScroll,
  relativeActivity,
  resolvePreferenceStorage,
  statusMutationMessage,
  tabCount,
  timelineBounds,
  isTaskOpen,
  writeBooleanPreference,
} from '../ui/src/dashboard-state.mjs'

const tasks = [
  { id: 'group', parent_id: null, status: 'done', start: '2026-08-12T08:00:00.000Z', end: null, last_activity: '2026-08-12T09:00:00.000Z' },
  { id: 'child-a', parent_id: 'group', status: 'done', start: '2026-08-12T08:00:00.000Z', end: '2026-08-12T08:30:00.000Z' },
  { id: 'child-b', parent_id: 'group', status: 'done', start: '2026-08-12T08:30:00.000Z', end: '2026-08-12T09:00:00.000Z' },
  { id: 'single-done', parent_id: null, status: 'done', start: '2026-08-12T08:00:00.000Z', end: '2026-08-12T08:05:00.000Z' },
  { id: 'blocked', parent_id: null, status: 'blocked', start: '2026-08-12T08:00:00.000Z', end: null, last_activity: '2026-08-12T08:55:00.000Z' },
]

test('merges completed roots and fully completed groups into history', () => {
  const index = createTaskIndex(tasks)
  assert.equal(isArchivedGroup(index.byId.get('group'), index), true)
  assert.equal(isArchivedGroup(index.byId.get('single-done'), index), false)
  assert.equal(isHistoricalRoot(index.byId.get('group'), index), true)
  assert.equal(isHistoricalRoot(index.byId.get('single-done'), index), true)
  assert.equal(isHistoricalRoot(index.byId.get('blocked'), index), false)
  assert.equal(tabCount('history', tasks, index), 2)
  assert.equal(tabCount('all', tasks, index), 1)
  assert.equal(tabCount('blocked', tasks, index), 1)
})

test('computes runtime end, project progress, and relative activity', () => {
  const now = new Date('2026-08-12T09:47:00.000Z')
  const index = createTaskIndex(tasks)
  assert.equal(endOf(index.byId.get('blocked'), now).toISOString(), '2026-08-12T09:47:00.000Z')
  assert.equal(progressOf(index.byId.get('group'), index), 1)
  assert.deepEqual(relativeActivity(index.byId.get('blocked'), now), {
    text: '52m', tone: 'stale', minutes: 52,
  })
})

test('places short and right-edge labels outside without overflowing', () => {
  assert.equal(estimatedTimelineLabelWidth('Investigate API timeout'), 166)
  assert.equal(labelPlacement({ text: 'Short', barLeft: 100, barWidth: 16, scrollLeft: 0, clientWidth: 600 }), 'right')
  assert.equal(labelPlacement({ text: 'Near edge', barLeft: 540, barWidth: 16, scrollLeft: 0, clientWidth: 600 }), 'left')
  assert.equal(labelPlacement({ text: 'Wide', barLeft: 100, barWidth: 180, scrollLeft: 0, clientWidth: 600 }), 'inside')
})

test('escapes task-controlled HTML', () => {
  assert.equal(escapeHtml('<img src=x onerror="bad">'), '&lt;img src=x onerror=&quot;bad&quot;&gt;')
})

test('formats only the configured home path segment', () => {
  assert.equal(formatHomePath('/Users/me/project', '/Users/me'), '~/project')
  assert.equal(formatHomePath('/Users/me', '/Users/me'), '~')
  assert.equal(formatHomePath('/Users/other/project', '/Users/me'), '/Users/other/project')
  assert.equal(formatHomePath(null, '/Users/me'), '—')
  assert.equal(formatHomePath('/Users/me-too/project', '/Users/me'), '/Users/me-too/project')
})

test('keeps full context values available while shortening only their display', () => {
  assert.deepEqual(
    dashboardState.contextPathPresentation?.(
      '/Users/me/projects/example/.worktree/feature-dashboard',
      '/Users/me',
    ),
    {
      display: '~/projects/example/.worktree/feature-dashboard',
      full: '/Users/me/projects/example/.worktree/feature-dashboard',
      empty: false,
    },
  )
  assert.deepEqual(dashboardState.contextPathPresentation?.(null, '/Users/me'), {
    display: '—', full: null, empty: true,
  })
})

test('allocates a wider default Timeline and clamps only the effective Grid width', () => {
  assert.deepEqual(dashboardState.gridPanelWidthBounds?.(1440), { minimum: 240, maximum: 1111 })
  assert.equal(dashboardState.effectiveGridPanelWidth?.({ containerWidth: 1440 }), 936)
  assert.equal(dashboardState.effectiveGridPanelWidth?.({ containerWidth: 1440, preferredWidth: 1040 }), 1040)
  assert.equal(dashboardState.effectiveGridPanelWidth?.({ containerWidth: 768, preferredWidth: 1040 }), 439)
  assert.equal(dashboardState.effectiveGridPanelWidth?.({ containerWidth: 375, preferredWidth: 1040 }), 240)
  assert.equal(dashboardState.effectiveGridPanelWidth?.({ containerWidth: 1440, preferredWidth: 1040 }), 1040)
})

test('steps separator width by keyboard within its current bounds', () => {
  assert.equal(dashboardState.nextGridPanelWidth?.({
    key: 'ArrowLeft', currentWidth: 640, minimum: 240, maximum: 1111,
  }), 624)
  assert.equal(dashboardState.nextGridPanelWidth?.({
    key: 'ArrowRight', currentWidth: 1104, minimum: 240, maximum: 1111,
  }), 1111)
  assert.equal(dashboardState.nextGridPanelWidth?.({
    key: 'Home', currentWidth: 640, minimum: 240, maximum: 1111,
  }), 240)
  assert.equal(dashboardState.nextGridPanelWidth?.({
    key: 'End', currentWidth: 640, minimum: 240, maximum: 1111,
  }), 1111)
  assert.equal(dashboardState.nextGridPanelWidth?.({
    key: 'Escape', currentWidth: 640, minimum: 240, maximum: 1111,
  }), null)
})

test('safely persists a finite Grid width preference', () => {
  const values = new Map()
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  }
  assert.equal(dashboardState.readNumberPreference?.(storage, 'grid'), null)
  assert.equal(dashboardState.writeNumberPreference?.(storage, 'grid', 720), true)
  assert.equal(dashboardState.readNumberPreference?.(storage, 'grid'), 720)
  values.set('grid', 'NaN')
  assert.equal(dashboardState.readNumberPreference?.(storage, 'grid'), null)
  values.set('grid', '10001')
  assert.equal(dashboardState.readNumberPreference?.(storage, 'grid'), null)
  const denied = {
    getItem: () => { throw new Error('denied') },
    setItem: () => { throw new Error('denied') },
  }
  assert.equal(dashboardState.readNumberPreference?.(denied, 'grid'), null)
  assert.equal(dashboardState.writeNumberPreference?.(denied, 'grid', 720), false)
})

test('keeps the full context popover inside the viewport and flips it above near the bottom', () => {
  assert.deepEqual(dashboardState.contextPopoverPosition?.({
    anchor: { left: 1300, top: 100, bottom: 122 },
    popover: { width: 320, height: 48 },
    viewport: { width: 1440, height: 900 },
  }), { left: 1112, top: 128 })
  assert.deepEqual(dashboardState.contextPopoverPosition?.({
    anchor: { left: 300, top: 870, bottom: 892 },
    popover: { width: 320, height: 48 },
    viewport: { width: 1440, height: 900 },
  }), { left: 300, top: 816 })
})

test('creates expanded and grid-only layouts without PRO resizers', () => {
  const expanded = createGanttLayout({ showTimeline: true, gridWidth: 640 })
  assert.equal(expanded.cols[0].width, 640)
  assert.equal(expanded.cols[0].rows[0].scrollX, 'gridScroll')
  assert.match(expanded.cols[1].html, /class="timeline-splitter"/)
  assert.equal(expanded.cols[1].css, 'timeline-splitter-cell')
  assert.equal(expanded.cols[1].width, 9)
  assert.equal(expanded.cols[2].rows[0].view, 'timeline')
  assert.equal(expanded.cols[2].rows[0].scrollX, 'timelineScroll')
  assert.equal(expanded.cols[0].rows[0].scrollY, 'sharedScroll')
  assert.equal(expanded.cols[2].rows[0].scrollY, 'sharedScroll')
  assert.equal(JSON.stringify(expanded).includes('"resizer":true'), false)

  const collapsed = createGanttLayout({ showTimeline: false, gridWidth: 640 })
  assert.equal(JSON.stringify(collapsed).includes('timeline-splitter'), false)
  assert.equal(collapsed.cols.some((cell) => JSON.stringify(cell).includes('timeline')), false)
  assert.equal('width' in collapsed.cols[0], false)
})

test('reads the DHTMLX runtime tree state before the source open fallback', () => {
  assert.equal(isTaskOpen({ $open: false, open: true }), false)
  assert.equal(isTaskOpen({ $open: true, open: false }), true)
  assert.equal(isTaskOpen({ open: false }), false)
  assert.equal(isTaskOpen({}), true)
})

test('retains the expanded Grid scroll when a full-width Grid cannot scroll', () => {
  assert.equal(retainedGridScroll({
    timelineVisible: true,
    gridX: 240,
    gridScrollable: true,
    rememberedGridX: 0,
  }), 240)
  assert.equal(retainedGridScroll({
    timelineVisible: false,
    gridX: 0,
    gridScrollable: true,
    gridScrollRange: 15,
    rememberedGridX: 240,
  }), 240)
  assert.equal(retainedGridScroll({
    timelineVisible: false,
    gridX: 100,
    gridScrollable: true,
    gridScrollRange: 400,
    rememberedGridX: 240,
  }), 100)
})

test('maps status mutation errors to actionable Chinese messages', () => {
  assert.equal(
    statusMutationMessage({ code: 'TASK_VERSION_CONFLICT' }),
    '任务已被其他 Agent 或页面更新，已刷新最新状态',
  )
  assert.equal(
    statusMutationMessage({
      code: 'CHILD_TASKS_INCOMPLETE',
      details: { child_ids: ['child-a', 'child-b'] },
    }),
    '请先完成子任务：child-a、child-b',
  )
  assert.equal(
    statusMutationMessage({ code: 'CHILD_TASKS_INCOMPLETE' }),
    '请先完成所有子任务',
  )
  assert.equal(
    statusMutationMessage({ code: 'TASK_NOT_FOUND' }),
    '任务已不存在，已刷新列表',
  )
  assert.equal(
    statusMutationMessage({ code: 'ORIGIN_REJECTED' }),
    '状态修改被本机安全策略拒绝',
  )
})

test('recomputes timeline bounds and safely persists the label preference', () => {
  const oneTask = [{
    id: 'live', status: 'active', start: '2026-08-12T08:00:00.000Z',
    end: null, last_activity: '2026-08-12T09:00:00.000Z',
  }]
  const first = timelineBounds(oneTask, new Date('2026-08-12T10:00:00.000Z'))
  const second = timelineBounds(oneTask, new Date('2026-08-14T10:00:00.000Z'))
  assert.ok(second.maximum > first.maximum)

  const values = new Map()
  const storage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) }
  assert.equal(readBooleanPreference(storage, 'labels'), false)
  assert.equal(writeBooleanPreference(storage, 'labels', true), true)
  assert.equal(readBooleanPreference(storage, 'labels'), true)
  const denied = { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('denied') } }
  assert.equal(readBooleanPreference(denied, 'labels', true), true)
  assert.equal(writeBooleanPreference(denied, 'labels', true), false)
  const sandboxedWindow = Object.defineProperty({}, 'localStorage', {
    get() { throw new Error('sandbox denied') },
  })
  assert.equal(resolvePreferenceStorage(sandboxedWindow), null)
})
