import assert from 'node:assert/strict'
import test from 'node:test'

import { createRunEventStream } from '../ui/src/run-event-stream.mjs'

class FakeEventSource {
  constructor(url) {
    this.url = url
    this.listeners = new Map()
    this.closed = false
    this.onerror = null
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener)
  }

  dispatch(type, event = {}) {
    this.listeners.get(type)?.(event)
  }

  close() { this.closed = true }
}

test('Run event stream reconnects from the latest sequence and reports reset', () => {
  const sources = []
  const scheduled = []
  const events = []
  const states = []
  let resets = 0
  const stream = createRunEventStream({
    runId: 'run-1',
    createSource(url) {
      const source = new FakeEventSource(url)
      sources.push(source)
      return source
    },
    onEvent: (event) => events.push(event),
    onReset: () => { resets += 1 },
    onState: (state) => states.push(state),
    schedule: (callback) => { scheduled.push(callback); return scheduled.length },
    cancelSchedule: () => {},
  })

  stream.connect()
  sources[0].dispatch('run', {
    lastEventId: '7',
    data: JSON.stringify({
      runId: 'run-1', sequence: 7, type: 'assistant_delta',
      payload: { delta: 'Checking.' },
    }),
  })
  assert.equal(stream.sequence(), 7)
  assert.equal(events.length, 1)

  sources[0].dispatch('reset', { data: JSON.stringify({ run_id: 'run-1' }) })
  assert.equal(resets, 1)
  sources[0].onerror()
  assert.equal(sources[0].closed, true)
  scheduled[0]()
  assert.equal(sources[1].url, '/api/v1/runs/run-1/events?after=7')
  assert.deepEqual(states, ['connecting', 'disconnected', 'connecting'])

  stream.close()
  assert.equal(sources[1].closed, true)
})
