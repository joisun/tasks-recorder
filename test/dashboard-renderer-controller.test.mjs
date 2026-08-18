import assert from 'node:assert/strict'
import test from 'node:test'

import { createDashboardRendererController } from '../ui/src/dashboard-renderer-controller.mjs'

const NOW = new Date('2026-08-16T10:00:00.000Z')
const snapshot = {
  home_directory: '/Users/me',
  tasks: [
    {
      id: 'root', parent_id: null, title: 'Active root', status: 'active',
      start: '2026-08-16T08:00:00.000Z', end: null, last_activity: '2026-08-16T09:50:00.000Z',
      progress: null, updated_at: '2026-08-16T09:50:00.000Z',
    },
    {
      id: 'child', parent_id: 'root', title: 'Child', status: 'active',
      start: '2026-08-16T08:30:00.000Z', end: null, last_activity: '2026-08-16T09:45:00.000Z',
      progress: null, updated_at: '2026-08-16T09:45:00.000Z',
    },
    {
      id: 'blocked', parent_id: null, title: 'Blocked root', status: 'blocked',
      start: '2026-08-16T09:00:00.000Z', end: null, last_activity: '2026-08-16T09:40:00.000Z',
      progress: null, updated_at: '2026-08-16T09:40:00.000Z',
    },
    {
      id: 'old-history', parent_id: null, title: 'Old completed work', status: 'done',
      start: '2025-01-03T09:00:00.000Z', end: '2025-01-03T10:00:00.000Z',
      last_activity: '2025-01-03T10:00:00.000Z', progress: null,
      updated_at: '2025-01-03T10:00:00.000Z',
    },
  ],
}

function fakeRenderer() {
  const calls = []
  const captured = {
    displayMode: 'all', gridWidth: 720, openIds: new Set(['root']), gridX: 18,
    timelineX: 96, verticalY: 44, selectedTaskId: 'child', taskColumnWidth: 260,
    labelsVisible: true,
  }
  return {
    calls,
    captured,
    render(model, view) { calls.push(['render', model, view]) },
    refreshTask(id, task) { calls.push(['refreshTask', id, task]) },
    setDisplayMode(mode) { calls.push(['setDisplayMode', mode]) },
    setGridWidth(width) { calls.push(['setGridWidth', width]) },
    setLabelsVisible(visible) { calls.push(['setLabelsVisible', visible]) },
    locateNow(date) { calls.push(['locateNow', date]) },
    captureState() { calls.push(['captureState']); return captured },
    destroy() { calls.push(['destroy']) },
  }
}

test('projects snapshots and root filters through the renderer boundary', () => {
  const renderer = fakeRenderer()
  const controller = createDashboardRendererController({ renderer, now: () => NOW })

  controller.setSnapshot(snapshot, { initial: true })
  assert.equal(renderer.calls[0][0], 'render')
  assert.deepEqual(renderer.calls[0][1].tasks.map(({ id }) => id), ['root', 'child', 'blocked'])
  assert.equal(renderer.calls[0][1].columns.length, 5)
  assert.equal(renderer.calls[0][1].start.getUTCFullYear(), 2026)
  assert.equal(renderer.calls[0][2].gridWidth, 792)

  controller.setFilter('blocked')
  const render = renderer.calls.at(-1)
  assert.equal(render[0], 'render')
  assert.deepEqual(render[1].tasks.map(({ id }) => id), ['blocked'])
})

test('maps pending rows and toolbar actions without exposing SVAR internals', () => {
  const renderer = fakeRenderer()
  const controller = createDashboardRendererController({ renderer, now: () => NOW })
  controller.setSnapshot(snapshot, { initial: true })

  controller.refreshTask('blocked', { statusPending: true })
  controller.setTimelineVisible(false)
  controller.setGridWidth(760)
  controller.setLabelsVisible(true)
  controller.locateNow()

  assert.deepEqual(renderer.calls.slice(-5).map(([name]) => name), [
    'refreshTask', 'setDisplayMode', 'setGridWidth', 'setLabelsVisible', 'locateNow',
  ])
  assert.equal(renderer.calls.at(-5)[2].statusPending, true)
  assert.equal(renderer.calls.at(-4)[1], 'grid')
  assert.equal(renderer.calls.at(-3)[1], 760)
  assert.equal(renderer.calls.at(-2)[1], true)
  assert.equal(renderer.calls.at(-1)[1].toISOString(), NOW.toISOString())
})

test('switches timeline granularity through semantic day, week, and month presets', () => {
  const renderer = fakeRenderer()
  const controller = createDashboardRendererController({ renderer, now: () => NOW })
  controller.setSnapshot(snapshot, { initial: true })

  const model = controller.setTimelineZoom('month')
  const render = renderer.calls.at(-1)

  assert.equal(model.lengthUnit, 'day')
  assert.equal(model.cellWidth, 4)
  assert.deepEqual(model.scales.map(({ unit }) => unit), ['year', 'month'])
  assert.equal(render[2].timelineZoom, 'month')
})

test('captures and restores tree, scroll, width, selection, and label state on refresh', () => {
  const renderer = fakeRenderer()
  const controller = createDashboardRendererController({ renderer, now: () => NOW })
  controller.setSnapshot(snapshot, { initial: true })
  renderer.calls.length = 0

  controller.setSnapshot({ ...snapshot, tasks: snapshot.tasks.map((task) => ({ ...task })) })

  assert.equal(renderer.calls[0][0], 'captureState')
  assert.equal(renderer.calls[1][0], 'render')
  assert.deepEqual(renderer.calls[1][2], renderer.captured)
  assert.equal(renderer.calls[1][1].tasks.find(({ id }) => id === 'root').open, true)
  assert.equal(renderer.calls[1][1].columns[0].width, 260)
})

test('keeps hidden summary expansion and selection while switching root filters', () => {
  const renderer = fakeRenderer()
  const controller = createDashboardRendererController({ renderer, now: () => NOW })
  controller.setSnapshot(snapshot, { initial: true })

  renderer.captured.openIds = new Set(['root'])
  renderer.captured.selectedTaskId = 'child'
  controller.setFilter('blocked')
  renderer.captured.openIds = new Set()
  renderer.captured.selectedTaskId = null
  const model = controller.setFilter('all')

  assert.equal(model.tasks.find(({ id }) => id === 'root').open, true)
  assert.equal(renderer.calls.at(-1)[2].selectedTaskId, 'child')
})
