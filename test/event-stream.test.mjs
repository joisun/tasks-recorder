import assert from 'node:assert/strict'
import test from 'node:test'

import { createEventStream } from '../ui/src/event-stream.mjs'

class FakeEventSource {
  constructor(url) {
    this.url = url
    this.listeners = new Map()
    this.closed = false
  }

  addEventListener(name, listener) {
    this.listeners.set(name, listener)
  }

  emit(name) {
    this.listeners.get(name)?.()
  }

  close() {
    this.closed = true
  }
}

test('event stream explicitly recreates EventSource after a failed reconnect', () => {
  const sources = []
  const scheduled = []
  const states = []
  let invalidations = 0
  const stream = createEventStream({
    url: '/api/v1/events',
    createSource: (url) => {
      const source = new FakeEventSource(url)
      sources.push(source)
      return source
    },
    invalidate: () => { invalidations += 1 },
    onConnectionState: (state) => states.push(state),
    schedule: (callback, delay) => { scheduled.push({ callback, delay }); return scheduled.length },
    cancelSchedule: () => {},
    retryMinMs: 1_000,
    retryMaxMs: 4_000,
  })

  stream.start()
  assert.equal(sources.length, 1)
  sources[0].emit('ready')
  assert.equal(invalidations, 1)
  assert.equal(states.at(-1), 'connected')

  sources[0].onerror()
  assert.equal(sources[0].closed, true)
  assert.deepEqual(scheduled.map(({ delay }) => delay), [1_000])
  assert.equal(states.at(-1), 'disconnected')

  scheduled.shift().callback()
  assert.equal(sources.length, 2)
  sources[1].emit('ready')
  sources[1].emit('changed')
  assert.equal(invalidations, 3)
  assert.equal(states.at(-1), 'connected')
  stream.stop()
  assert.equal(sources[1].closed, true)
})
