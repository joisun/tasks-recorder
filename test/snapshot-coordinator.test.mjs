import assert from 'node:assert/strict'
import test from 'node:test'

import { createSnapshotCoordinator } from '../ui/src/snapshot-coordinator.mjs'

function deferred() {
  let resolve
  let reject
  const promise = new Promise((accept, fail) => { resolve = accept; reject = fail })
  return { promise, resolve, reject }
}

test('events during one snapshot request collapse into exactly one follow-up fetch', async () => {
  const first = deferred()
  const snapshots = [first.promise, Promise.resolve({ tasks: [{ id: 'latest' }] })]
  const rendered = []
  let loadCalls = 0
  const coordinator = createSnapshotCoordinator({
    load: () => snapshots[loadCalls++],
    render: (snapshot, options) => rendered.push({ snapshot, options }),
  })

  const settled = coordinator.invalidate()
  coordinator.invalidate()
  coordinator.invalidate()
  assert.equal(loadCalls, 1)

  first.resolve({ tasks: [{ id: 'first' }] })
  await settled

  assert.equal(loadCalls, 2)
  assert.deepEqual(rendered.map(({ snapshot }) => snapshot.tasks[0].id), ['first', 'latest'])
  assert.deepEqual(rendered.map(({ options }) => options.initial), [true, false])
})

test('failed refresh keeps prior data and a later ready event can recover', async () => {
  const outcomes = [
    { tasks: [{ id: 'stable' }] },
    new Error('disconnected'),
    { tasks: [{ id: 'recovered' }] },
  ]
  const rendered = []
  const states = []
  const coordinator = createSnapshotCoordinator({
    load: async () => {
      const value = outcomes.shift()
      if (value instanceof Error) throw value
      return value
    },
    render: (snapshot) => rendered.push(snapshot.tasks[0].id),
    onStatus: ({ state }) => states.push(state),
  })

  await coordinator.invalidate()
  await coordinator.invalidate()
  await coordinator.invalidate()

  assert.deepEqual(rendered, ['stable', 'recovered'])
  assert.deepEqual(states, ['fresh', 'stale', 'fresh'])
})
