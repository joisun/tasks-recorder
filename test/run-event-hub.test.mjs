import assert from 'node:assert/strict'
import test from 'node:test'

import { createRunEventHub } from '../server/src/runs/run-event-hub.mjs'

const RUN_ID = '11111111-1111-4111-8111-111111111111'

function event(sequence, type = 'status') {
  return Object.freeze({
    runId: RUN_ID,
    sequence,
    observedAt: '2026-08-27T09:00:00.000Z',
    type,
    payload: Object.freeze({ state: `state-${sequence}` }),
  })
}

test('event hub replays only events after the requested sequence', () => {
  const hub = createRunEventHub({ maximumEventsPerRun: 2 })
  hub.publish(event(1))
  hub.publish(event(2))
  const received = []
  const unsubscribe = hub.subscribe(
    RUN_ID,
    (value) => received.push(value),
    { afterSequence: 1 },
  )

  assert.deepEqual(received.map(({ sequence }) => sequence), [2])
  hub.publish(event(3))
  assert.deepEqual(received.map(({ sequence }) => sequence), [2, 3])
  unsubscribe()

  const replay = []
  hub.subscribe(RUN_ID, (value) => replay.push(value), { afterSequence: 0 })()
  assert.deepEqual(replay.map(({ sequence }) => sequence), [2, 3])
  hub.close()
})

test('event hub rejects non-monotonic events for one Run', () => {
  const hub = createRunEventHub({ maximumEventsPerRun: 2 })
  hub.publish(event(2))
  assert.throws(() => hub.publish(event(2)), /strictly increasing/)
  hub.close()
})

test('event hub evicts a terminal replay buffer after its last subscriber leaves', () => {
  const timers = []
  const hub = createRunEventHub({
    maximumEventsPerRun: 4,
    retentionMs: 30_000,
    setTimer(callback, delay) {
      const timer = { callback, delay, cleared: false, unref() {} }
      timers.push(timer)
      return timer
    },
    clearTimer(timer) {
      if (timer) timer.cleared = true
    },
  })
  hub.publish(event(1))
  hub.publish(event(2, 'done'))
  const unsubscribe = hub.subscribe(RUN_ID, () => {})
  unsubscribe()

  const eviction = timers.find(({ delay, cleared }) => delay === 30_000 && !cleared)
  assert.ok(eviction)
  eviction.callback()

  const replay = []
  hub.subscribe(RUN_ID, (value) => replay.push(value))()
  assert.deepEqual(replay, [])
  hub.close()
})

test('event hub reports replay gaps even when the retained buffer is absent', () => {
  const hub = createRunEventHub()
  assert.deepEqual(hub.replayState('run-1', 4), { reset_required: true })
  assert.deepEqual(hub.replayState('run-1', 0), { reset_required: false })

  hub.publish({
    runId: 'run-1', sequence: 3,
    observedAt: '2026-08-27T09:00:03.000Z',
    type: 'status', payload: { state: 'running' },
  })
  assert.deepEqual(hub.replayState('run-1', 1), { reset_required: true })
  assert.deepEqual(hub.replayState('run-1', 2), { reset_required: false })
  hub.close()
})
