import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'

import {
  cadenceSummary,
  latestDueOccurrence,
  launchdCalendars,
  nextOccurrence,
  validateCadence,
} from '../server/src/scheduler/cadence.mjs'

test('normalizes weekly cadence without changing ISO weekdays', () => {
  assert.deepEqual(validateCadence({
    kind: 'weekly', weekdays: [5, 1, 5], hour: 9, minute: 30,
  }), { kind: 'weekly', weekdays: [1, 5], hour: 9, minute: 30, timezone_mode: 'system' })
})

test('maps ISO Sunday to launchd Sunday without exposing raw plist input', () => {
  assert.deepEqual(launchdCalendars(validateCadence({
    kind: 'weekly', weekdays: [7], hour: 8, minute: 0,
  })), [{ Weekday: 0, Hour: 8, Minute: 0 }])
})

test('accepts exact cadence shapes and returns fresh copies', () => {
  const input = { kind: 'weekly', weekdays: [2, 4], hour: 9, minute: 5 }
  const cadence = validateCadence(input)
  assert.notEqual(cadence, input)
  assert.notEqual(cadence.weekdays, input.weekdays)
  assert.deepEqual(validateCadence({ kind: 'hourly', minute: 12 }), { kind: 'hourly', minute: 12, timezone_mode: 'system' })
  assert.deepEqual(validateCadence({ kind: 'daily', hour: 3, minute: 4 }), { kind: 'daily', hour: 3, minute: 4, timezone_mode: 'system' })
  assert.deepEqual(validateCadence({ kind: 'monthly', day: 31, hour: 23, minute: 59 }), { kind: 'monthly', day: 31, hour: 23, minute: 59, timezone_mode: 'system' })
})

test('rejects unknown keys, invalid ranges, empty weekdays, and non-system timezone', () => {
  assert.throws(() => validateCadence({ kind: 'hourly', minute: 1, extra: true }), /unknown/i)
  assert.throws(() => validateCadence({ kind: 'hourly', minute: 60 }), /minute/i)
  assert.throws(() => validateCadence({ kind: 'daily', hour: 24, minute: 0 }), /hour/i)
  assert.throws(() => validateCadence({ kind: 'weekly', weekdays: [], hour: 1, minute: 0 }), /weekday/i)
  assert.throws(() => validateCadence({ kind: 'weekly', weekdays: [0], hour: 1, minute: 0 }), /weekday/i)
  assert.throws(() => validateCadence({ kind: 'monthly', day: 32, hour: 1, minute: 0 }), /day/i)
  assert.throws(() => validateCadence({ kind: 'hourly', minute: 1, timezone_mode: 'UTC' }), /timezone/i)
})

test('validates one-time window and invalid local dates', () => {
  const now = new Date('2026-01-01T12:00:00.000Z')
  assert.deepEqual(validateCadence({ kind: 'once', at: '2026-01-02T12:00:00.000Z' }, { now }), {
    kind: 'once', at: '2026-01-02T12:00:00.000Z', timezone_mode: 'system',
  })
  assert.throws(() => validateCadence({ kind: 'once', at: 'not-a-date' }, { now }), /date|time/i)
  assert.throws(() => validateCadence({ kind: 'once', at: '2026-02-30T09:00:00' }, { now }), /date|time/i)
  assert.throws(() => validateCadence({ kind: 'once', at: '2026-01-01T12:00:00.000Z' }, { now }), /future/i)
  assert.throws(() => validateCadence({ kind: 'once', at: '2027-01-03T12:00:00.000Z' }, { now }), /366|days/i)
})

test('computes recurring occurrences and skips missing monthly dates', () => {
  const after = new Date('2026-01-31T10:00:00')
  const monthly = nextOccurrence(validateCadence({ kind: 'monthly', day: 31, hour: 9, minute: 0 }), after)
  assert.deepEqual([monthly.getFullYear(), monthly.getMonth() + 1, monthly.getDate(), monthly.getHours(), monthly.getMinutes()], [2026, 3, 31, 9, 0])
  const weekly = nextOccurrence(validateCadence({ kind: 'weekly', weekdays: [1], hour: 9, minute: 0 }), new Date('2026-01-04T10:00:00'))
  assert.deepEqual([weekly.getFullYear(), weekly.getMonth() + 1, weekly.getDate(), weekly.getHours(), weekly.getMinutes()], [2026, 1, 5, 9, 0])
  const daily = nextOccurrence(validateCadence({ kind: 'daily', hour: 9, minute: 0 }), new Date('2026-01-05T09:00:00'), { inclusive: true })
  assert.deepEqual([daily.getFullYear(), daily.getMonth() + 1, daily.getDate(), daily.getHours(), daily.getMinutes()], [2026, 1, 5, 9, 0])
  assert.equal(nextOccurrence(validateCadence({ kind: 'once', at: '2026-01-06T09:00:00' }, { now: new Date('2026-01-01T00:00:00') }), new Date('2026-01-07T00:00:00')), null)
})

test('latestDueOccurrence coalesces missed occurrences to the latest wall-clock slot', () => {
  const hourly = validateCadence({ kind: 'hourly', minute: 15 })
  assert.equal(latestDueOccurrence(hourly, {
    after: new Date('2026-08-27T00:00:00'),
    at: new Date('2026-08-27T05:47:00'),
  }).toISOString(), new Date('2026-08-27T05:15:00').toISOString())

  const monthly = validateCadence({ kind: 'monthly', day: 31, hour: 9, minute: 0 })
  const latest = latestDueOccurrence(monthly, {
    after: new Date('2026-01-31T09:00:00'),
    at: new Date('2026-04-15T12:00:00'),
  })
  assert.deepEqual(
    [latest.getFullYear(), latest.getMonth() + 1, latest.getDate(), latest.getHours()],
    [2026, 3, 31, 9],
  )
  assert.equal(latestDueOccurrence(hourly, {
    after: new Date('2026-08-27T05:15:00'),
    at: new Date('2026-08-27T05:15:00'),
  }), null)
})

test('uses system Date semantics for DST gaps and overlaps', () => {
  const script = `const gap=new Date(2026,2,8,2,30); const overlap=new Date(2026,10,1,1,30); console.log(JSON.stringify({gap:[gap.getHours(),gap.getMinutes(),gap.getTimezoneOffset()],overlap:[overlap.getHours(),overlap.getMinutes(),overlap.getTimezoneOffset()]}));`
  const result = spawnSync(process.execPath, ['-e', script], { env: { ...process.env, TZ: 'America/New_York' }, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  const parsed = JSON.parse(result.stdout)
  assert.deepEqual(parsed.gap.slice(0, 2), [3, 30])
  assert.equal(parsed.overlap[2], 240)
})

test('nextOccurrence normalizes DST gap and chooses earlier overlap', () => {
  const script = `import {validateCadence,nextOccurrence} from './server/src/scheduler/cadence.mjs'; const gap=nextOccurrence(validateCadence({kind:'daily',hour:2,minute:30}),new Date(2026,2,7,3,0)); const overlap=nextOccurrence(validateCadence({kind:'daily',hour:1,minute:30}),new Date(2026,9,31,2,0)); console.log(JSON.stringify({gap:[gap.getFullYear(),gap.getMonth()+1,gap.getDate(),gap.getHours(),gap.getMinutes()],overlap:[overlap.getFullYear(),overlap.getMonth()+1,overlap.getDate(),overlap.getHours(),overlap.getMinutes(),overlap.getTimezoneOffset()]}));`
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, TZ: 'America/New_York' }, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  const parsed = JSON.parse(result.stdout)
  assert.deepEqual(parsed.gap, [2026, 3, 8, 3, 30])
  assert.deepEqual(parsed.overlap, [2026, 11, 1, 1, 30, 240])
})

test('produces stable human summaries and launchd calendars', () => {
  assert.match(cadenceSummary(validateCadence({ kind: 'daily', hour: 9, minute: 5 })), /09:05/)
  assert.deepEqual(launchdCalendars(validateCadence({ kind: 'hourly', minute: 3 })), [{ Minute: 3 }])
  assert.deepEqual(launchdCalendars(validateCadence({ kind: 'monthly', day: 15, hour: 8, minute: 0 })), [{ Day: 15, Hour: 8, Minute: 0 }])
})

test('uses subprocess system timezone and preserves daily wall-clock hour across DST', () => {
  const script = `import {validateCadence,nextOccurrence} from './server/src/scheduler/cadence.mjs'; const c=validateCadence({kind:'daily',hour:9,minute:0}); const a=nextOccurrence(c,new Date('2026-03-07T09:30:00')); const b=nextOccurrence(c,a); console.log(JSON.stringify([a.toISOString(),b.toISOString(),a.getHours(),b.getHours()]));`
  for (const tz of ['America/New_York', 'Asia/Shanghai']) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, TZ: tz }, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    const [first, second, firstHour, secondHour] = JSON.parse(result.stdout)
    assert.notEqual(first, second)
    assert.equal(firstHour, 9)
    assert.equal(secondHour, 9)
  }
})
