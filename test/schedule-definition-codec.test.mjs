import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  definitionEtag,
  parseScheduleDefinition,
  serializeScheduleDefinition,
} from '../server/src/scheduler/schedule-definition-codec.mjs'

const DAILY = `---
type: tasks-recorder/schedule
id: 34826d22-b33b-4d1d-b9d0-8459d71009dc
title: Codex daily news
enabled: true
workspace: /tmp/project
schedule:
  kind: daily
  at: "09:05"
sandbox: read-only
model: gpt-5.6-sol
reasoning: ultra
timeout: 2h
---

Check official Codex sources and summarize changes.
`

test('ignores ordinary Markdown without the Schedule marker', () => {
  assert.equal(parseScheduleDefinition('# Notes\n\nNothing scheduled.\n'), null)
  assert.equal(parseScheduleDefinition('---\ntitle: Notes\n---\n\nBody\n'), null)
})

test('parses human-friendly daily front matter into the scheduler domain shape', () => {
  const parsed = parseScheduleDefinition(DAILY, { sourcePath: '/tmp/schedules/daily.md' })
  assert.deepEqual(parsed, {
    id: '34826d22-b33b-4d1d-b9d0-8459d71009dc',
    title: 'Codex daily news',
    enabled: true,
    workspace: '/tmp/project',
    agent: 'codex',
    cadence: { kind: 'daily', hour: 9, minute: 5, timezone_mode: 'system' },
    sandbox_mode: 'read-only',
    model: 'gpt-5.6-sol',
    reasoning_effort: 'ultra',
    timeout_seconds: 7200,
    capabilities: { skills: 'inherit', integrations: 'inherit' },
    thread_mode: 'new',
    timezone_mode: 'system',
    prompt: 'Check official Codex sources and summarize changes.',
    source_path: '/tmp/schedules/daily.md',
    etag: definitionEtag(DAILY),
  })
})

test('normalizes weekly weekday names and supports a disabled definition', () => {
  const parsed = parseScheduleDefinition(`---
type: tasks-recorder/schedule
id: 54c9a3ac-86e8-4bed-9514-67f42f4b4821
title: Weekly review
enabled: false
workspace: /tmp/project
schedule:
  kind: weekly
  on: [fri, mon, fri]
  at: "18:30"
---

Review the week.
`)
  assert.equal(parsed.enabled, false)
  assert.deepEqual(parsed.cadence, {
    kind: 'weekly', weekdays: [1, 5], hour: 18, minute: 30, timezone_mode: 'system',
  })
})

test('serializes and parses without changing the executable definition', () => {
  const original = parseScheduleDefinition(DAILY)
  const source = serializeScheduleDefinition(original)
  const roundTrip = parseScheduleDefinition(source)
  for (const key of [
    'id', 'title', 'enabled', 'workspace', 'agent', 'cadence', 'sandbox_mode', 'model',
    'reasoning_effort', 'timeout_seconds', 'capabilities', 'thread_mode', 'timezone_mode', 'prompt',
  ]) assert.deepEqual(roundTrip[key], original[key], key)
  assert.match(source, /^---\n/)
  assert.match(source, /type: tasks-recorder\/schedule/)
})

test('round-trips exact capability isolation and rejects unsupported policy', () => {
  const isolated = DAILY.replace(
    'sandbox: read-only',
    'capabilities:\n  skills: disabled\n  integrations: disabled\nsandbox: read-only',
  )
  const parsed = parseScheduleDefinition(isolated)
  assert.deepEqual(parsed.capabilities, { skills: 'disabled', integrations: 'disabled' })

  const serialized = serializeScheduleDefinition(parsed)
  assert.match(serialized, /capabilities:\n  skills: disabled\n  integrations: disabled\n/)
  assert.deepEqual(parseScheduleDefinition(serialized).capabilities, parsed.capabilities)

  assert.throws(
    () => parseScheduleDefinition(isolated.replace('skills: disabled', 'skills: enabled')),
    { code: 'SCHEDULE_DEFINITION_INVALID' },
  )
  assert.throws(
    () => parseScheduleDefinition(isolated.replace('integrations: disabled', 'integrations: disabled\n  web_search: disabled')),
    { code: 'SCHEDULE_DEFINITION_INVALID' },
  )
})

test('uses the repository clock and preserves an expired disabled once definition', () => {
  const clock = () => new Date('2001-01-01T00:00:00.000Z')
  const source = serializeScheduleDefinition({
    id: 'd114e257-e9bd-4ae3-a8df-1789bc7aedc4',
    title: 'Completed once schedule',
    enabled: false,
    workspace: '/tmp/project',
    cadence: { kind: 'once', at: '2000-01-01T00:00:00.000Z' },
    sandbox_mode: 'read-only',
    timeout_seconds: 7200,
    prompt: 'Keep the historical definition readable.',
  }, { clock })
  const parsed = parseScheduleDefinition(source, { clock })
  assert.equal(parsed.enabled, false)
  assert.equal(parsed.cadence.at, '2000-01-01T00:00:00.000Z')
})

test('accepts bounded duration units and rejects unsafe or unsupported fields', () => {
  const source = DAILY.replace('timeout: 2h', 'timeout: 90m')
  assert.equal(parseScheduleDefinition(source).timeout_seconds, 5400)
  assert.throws(() => parseScheduleDefinition(DAILY.replace('timeout: 2h', 'timeout: 25h')), /timeout/i)
  assert.throws(() => parseScheduleDefinition(DAILY.replace('timeout: 2h', 'shell: rm -rf /')), /unsupported.*shell/i)
  assert.throws(() => parseScheduleDefinition(DAILY.replace('34826d22-b33b-4d1d-b9d0-8459d71009dc', '../daily')), /id/i)
  assert.throws(() => parseScheduleDefinition(DAILY.replace('gpt-5.6-sol', '../unsafe')), /model/i)
  assert.throws(() => parseScheduleDefinition(DAILY.replace('reasoning: ultra', 'reasoning: HIGH!')), /reasoning/i)
})

test('legacy definitions default to codex while new writes persist a safe agent ID', () => {
  const parsed = parseScheduleDefinition(DAILY)
  assert.equal(parsed.agent, 'codex')
  assert.equal(DAILY.includes('\nagent:'), false)

  const source = serializeScheduleDefinition({ ...parsed, agent: 'claude-code' })
  assert.match(source, /\nagent: claude-code\n/)
  assert.equal(parseScheduleDefinition(source).agent, 'claude-code')
  assert.throws(
    () => parseScheduleDefinition(DAILY.replace('sandbox: read-only', 'agent: ../codex\nsandbox: read-only')),
    { code: 'SCHEDULE_DEFINITION_INVALID' },
  )
})

test('reports malformed marked YAML and invalid cadence precisely', () => {
  assert.throws(() => parseScheduleDefinition(`---
type: tasks-recorder/schedule
id: [broken
---
prompt
`), /front matter|yaml/i)
  assert.throws(() => parseScheduleDefinition(DAILY.replace('at: "09:05"', 'at: "25:00"')), /schedule\.at/i)
})
