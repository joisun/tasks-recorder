import { latestDueOccurrence } from './cadence.mjs'

const EXPECTED_CONFLICTS = new Set([
  'RUN_ALREADY_ACTIVE',
  'RUN_OCCURRENCE_EXISTS',
])

export function createSchedulerClock({
  definitions,
  runService,
  clock = () => new Date(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  intervalMs = 30_000,
} = {}) {
  if (typeof definitions?.list !== 'function'
    || typeof runService?.create !== 'function'
    || typeof runService?.latestOccurrence !== 'function'
    || typeof clock !== 'function' || typeof setTimer !== 'function'
    || typeof clearTimer !== 'function'
    || !Number.isSafeInteger(intervalMs) || intervalMs < 1_000) {
    throw new TypeError('scheduler clock dependencies are invalid')
  }

  let started = false
  let closed = false
  let intervalTimer = null
  let notificationTimer = null
  let pendingTick = null

  function start() {
    if (closed) throw new Error('scheduler clock is closed')
    if (started) return
    started = true
    void tick()
    armInterval()
  }

  function armInterval() {
    if (!started || closed || intervalTimer) return
    intervalTimer = setTimer(async () => {
      intervalTimer = null
      await tick()
      armInterval()
    }, intervalMs)
    intervalTimer?.unref?.()
  }

  function tick() {
    if (closed) return Promise.resolve()
    if (pendingTick) return pendingTick
    pendingTick = runTick()
      .finally(() => { pendingTick = null })
    return pendingTick
  }

  async function runTick() {
    const observedAt = validDate(clock(), 'clock')
    const schedules = await definitions.list()
    for (const schedule of schedules) {
      if (schedule?.enabled !== true) continue
      const latest = runService.latestOccurrence(schedule.id)
      const after = latest?.scheduled_for
        ? validDate(latest.scheduled_for, 'scheduled_for')
        : validDate(schedule.updated_at, 'updated_at')
      const due = latestDueOccurrence(schedule.cadence, {
        after,
        at: observedAt,
      })
      if (!due) continue

      try {
        await runService.create({
          schedule,
          origin: observedAt.getTime() - due.getTime() <= intervalMs * 2
            ? 'scheduled'
            : 'catchup',
          occurrence_key: due.toISOString(),
          scheduled_for: due.toISOString(),
          idempotency_key: null,
        })
      } catch (error) {
        if (!EXPECTED_CONFLICTS.has(error?.code)) throw error
      }
    }
  }

  function notifyDefinitionsChanged() {
    if (closed || notificationTimer) return
    notificationTimer = setTimer(() => {
      notificationTimer = null
      void tick()
    }, 0)
    notificationTimer?.unref?.()
  }

  async function whenIdle() {
    while (pendingTick) await pendingTick
  }

  async function close() {
    if (closed) return whenIdle()
    closed = true
    clearTimer(intervalTimer)
    clearTimer(notificationTimer)
    intervalTimer = null
    notificationTimer = null
    await whenIdle()
  }

  return Object.freeze({
    start,
    tick,
    notifyDefinitionsChanged,
    whenIdle,
    close,
  })
}

function validDate(value, field) {
  const date = value instanceof Date ? new Date(value) : new Date(value)
  if (!Number.isFinite(date.getTime())) {
    throw new RangeError(`${field} must be a valid date`)
  }
  return date
}
