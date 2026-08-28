import assert from 'node:assert/strict'
import test from 'node:test'

import { createSchedulerClock } from '../server/src/scheduler/scheduler-clock.mjs'

const SCHEDULE = Object.freeze({
  id: '11111111-1111-4111-8111-111111111111',
  etag: 'a'.repeat(64),
  title: 'Hourly review',
  prompt: 'Review the project.',
  workspace: '/tmp/project',
  cadence: Object.freeze({
    kind: 'hourly',
    minute: 15,
    timezone_mode: 'system',
  }),
  enabled: true,
  agent: 'codex',
  sandbox_mode: 'read-only',
  timeout_seconds: 7_200,
  updated_at: '2026-08-27T00:00:00.000Z',
})

function fixture() {
  let now = new Date('2026-08-27T05:47:00.000Z')
  const timers = []
  const created = []
  const latest = new Map()
  const runService = {
    latestOccurrence: (scheduleId) => latest.get(scheduleId) ?? null,
    create: async (input) => {
      created.push(input)
      latest.set(input.schedule.id, {
        occurrence_key: input.occurrence_key,
        scheduled_for: input.scheduled_for,
      })
      return { run: { id: String(created.length), status: 'queued' } }
    },
  }
  const scheduler = createSchedulerClock({
    definitions: { list: async () => [SCHEDULE] },
    runService,
    clock: () => new Date(now),
    setTimer(callback, delay) {
      const timer = { callback, delay, cleared: false, unref() {} }
      timers.push(timer)
      return timer
    },
    clearTimer(timer) {
      if (timer) timer.cleared = true
    },
    intervalMs: 30_000,
  })
  return {
    scheduler,
    created,
    timers,
    setNow(value) { now = new Date(value) },
  }
}

test('scheduler startup ticks immediately and coalesces missed occurrences', async () => {
  const current = fixture()
  current.scheduler.start()
  await current.scheduler.whenIdle()

  assert.equal(current.created.length, 1)
  assert.equal(
    current.created[0].scheduled_for,
    '2026-08-27T05:15:00.000Z',
  )
  assert.equal(current.created[0].origin, 'catchup')
  assert.equal(current.created[0].occurrence_key, '2026-08-27T05:15:00.000Z')

  await current.scheduler.tick()
  assert.equal(current.created.length, 1)
  await current.scheduler.close()
})

test('definition notifications debounce an immediate wall-clock tick', async () => {
  const current = fixture()
  current.scheduler.start()
  await current.scheduler.whenIdle()
  current.setNow('2026-08-27T06:17:00.000Z')

  current.scheduler.notifyDefinitionsChanged()
  current.scheduler.notifyDefinitionsChanged()
  const immediate = current.timers.filter(({ delay, cleared }) => delay === 0 && !cleared)
  assert.equal(immediate.length, 1)
  immediate[0].callback()
  await current.scheduler.whenIdle()

  assert.equal(current.created.length, 2)
  assert.equal(current.created[1].scheduled_for, '2026-08-27T06:15:00.000Z')
  await current.scheduler.close()
})
