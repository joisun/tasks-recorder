import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createScheduleDefinitionMonitor } from '../server/src/scheduler/schedule-definition-monitor.mjs'

function job(id, etag) { return { id, etag, source_path: `/tmp/${id}.md` } }

test('emits added, changed, removed and invalid diffs from watcher and safety rescans', async () => {
  const scans = [
    { jobs: [job('one', 'a')], invalid: [] },
    { jobs: [job('one', 'b'), job('two', 'a')], invalid: [] },
    { jobs: [job('two', 'a')], invalid: [{ source_path: '/tmp/one.md', error_code: 'BROKEN', message: 'broken' }] },
  ]
  const diffs = []
  let watchCallback
  let intervalCallback
  const repository = {
    rootDirectory: '/tmp/schedules',
    async scan() { return scans.shift() ?? { jobs: [job('two', 'a')], invalid: [] } },
  }
  const monitor = createScheduleDefinitionMonitor({
    repository,
    onDiff: (diff) => diffs.push(diff),
    watchFactory(_root, _options, callback) { watchCallback = callback; return { close() {} } },
    schedule(callback) { callback(); return 1 },
    clearSchedule() {},
    setIntervalImpl(callback) { intervalCallback = callback; return 2 },
    clearIntervalImpl() {},
  })

  await monitor.start()
  assert.deepEqual(diffs[0].added.map(({ id }) => id), ['one'])
  watchCallback('change', 'one.md')
  await monitor.settled()
  assert.deepEqual(diffs[1].added.map(({ id }) => id), ['two'])
  assert.deepEqual(diffs[1].changed.map(({ id }) => id), ['one'])
  await intervalCallback()
  assert.deepEqual(diffs[2].removed.map(({ id }) => id), ['one'])
  assert.equal(diffs[2].invalid[0].error_code, 'BROKEN')
  await monitor.close()
})

test('coalesces concurrent refreshes and emits nothing for an unchanged scan', async () => {
  let scans = 0
  const diffs = []
  const repository = {
    rootDirectory: '/tmp/schedules',
    async scan() { scans += 1; return { jobs: [job('one', 'a')], invalid: [] } },
  }
  const monitor = createScheduleDefinitionMonitor({
    repository,
    onDiff: (diff) => diffs.push(diff),
    watchFactory() { return { close() {} } },
    setIntervalImpl() { return 1 },
    clearIntervalImpl() {},
  })
  await monitor.start()
  await Promise.all([monitor.refresh(), monitor.refresh()])
  assert.equal(diffs.length, 1)
  assert.ok(scans >= 2)
  await monitor.close()
})

test('can establish a watcher baseline without replaying every definition as newly added', async () => {
  const diffs = []
  const repository = {
    rootDirectory: '/tmp/schedules',
    async scan() { return { jobs: [job('one', 'a')], invalid: [] } },
  }
  const monitor = createScheduleDefinitionMonitor({
    repository,
    onDiff: (diff) => diffs.push(diff),
    watchFactory() { return { close() {} } },
    setIntervalImpl() { return 1 },
    clearIntervalImpl() {},
  })

  await monitor.start({ emitInitial: false })
  assert.deepEqual(diffs, [])
  await monitor.refresh()
  assert.deepEqual(diffs, [])
  await monitor.close()
})
