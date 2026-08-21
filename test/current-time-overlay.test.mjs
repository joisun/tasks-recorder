import assert from 'node:assert/strict'
import test from 'node:test'

import {
  currentTimeOverlayModel,
  separatorWidthFromKey,
  separatorWidthFromPointer,
  timelineLocateShouldDefer,
} from '../ui/src/current-time-overlay.mjs'

test('maps current time into the chart viewport and offsets it from the Grid', () => {
  assert.deepEqual(currentTimeOverlayModel({
    now: new Date('2026-08-16T10:00:00.000Z'),
    timelineStart: new Date('2026-08-16T08:00:00.000Z'),
    timelineEnd: new Date('2026-08-16T12:00:00.000Z'),
    contentWidth: 800,
    scrollLeft: 100,
    viewportWidth: 500,
    chartLeft: 720,
  }), {
    visible: true,
    left: 1020,
    contentX: 400,
  })

  assert.deepEqual(currentTimeOverlayModel({
    now: new Date('2026-08-16T11:45:00.000Z'),
    timelineStart: new Date('2026-08-16T08:00:00.000Z'),
    timelineEnd: new Date('2026-08-16T12:00:00.000Z'),
    contentWidth: 800,
    scrollLeft: 0,
    viewportWidth: 500,
    chartLeft: 720,
  }), {
    visible: false,
    left: 720,
    contentX: 750,
  })
})

test('defers locate requests until the renderer restore cycle can consume them last', () => {
  assert.equal(timelineLocateShouldDefer({ apiReady: false, restoreScheduled: false }), true)
  assert.equal(timelineLocateShouldDefer({ apiReady: true, restoreScheduled: true }), true)
  assert.equal(timelineLocateShouldDefer({ apiReady: true, restoreScheduled: false }), false)
})

test('turns separator keyboard actions into bounded Grid widths', () => {
  const base = { width: 720, containerWidth: 1440, minimum: 240, timelineMinimum: 329 }
  assert.equal(separatorWidthFromKey({ ...base, key: 'ArrowLeft' }), 704)
  assert.equal(separatorWidthFromKey({ ...base, key: 'ArrowRight' }), 736)
  assert.equal(separatorWidthFromKey({ ...base, key: 'Home' }), 240)
  assert.equal(separatorWidthFromKey({ ...base, key: 'End' }), 1111)
  assert.equal(separatorWidthFromKey({ ...base, key: 'Enter' }), null)
  assert.equal(separatorWidthFromKey({ ...base, width: 240, key: 'ArrowLeft' }), 240)
})

test('turns separator pointer positions into bounded Grid widths', () => {
  const base = { containerLeft: 100, containerWidth: 1440, minimum: 240, timelineMinimum: 329 }
  assert.equal(separatorWidthFromPointer({ ...base, clientX: 820 }), 720)
  assert.equal(separatorWidthFromPointer({ ...base, clientX: 120 }), 240)
  assert.equal(separatorWidthFromPointer({ ...base, clientX: 1500 }), 1111)
  assert.equal(separatorWidthFromPointer({ ...base, clientX: Number.NaN }), null)
})
