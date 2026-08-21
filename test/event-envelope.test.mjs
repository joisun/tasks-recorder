import assert from 'node:assert/strict'
import test from 'node:test'

import { parseEventEnvelope } from '../mcp/src/event-envelope.mjs'

function startedEvent(overrides = {}) {
  return {
    source: 'codex',
    event_type: 'execution.started',
    external_event_id: 'codex:session-1:turn-1:start',
    observed_at: '2026-08-20T01:00:00.000Z',
    source_session_key: 'session-1',
    source_turn_key: 'turn-1',
    source_agent_key: null,
    workfolder: '/workspace/project-a',
    git_root: '/workspace/project-a',
    git_common_dir: '/workspace/project-a/.git',
    git_remote: 'https://token@example.com/acme/project-a.git',
    worktree: '/workspace/project-a',
    branch: 'feature/a',
    payload: { kind: 'main' },
    ...overrides,
  }
}

test('normalizes an allowlisted Event Envelope without retaining remote credentials', () => {
  const normalized = parseEventEnvelope(startedEvent())
  assert.deepEqual(normalized, {
    source: 'codex',
    event_type: 'execution.started',
    external_event_id: 'codex:session-1:turn-1:start',
    observed_at: '2026-08-20T01:00:00.000Z',
    source_session_key: 'session-1',
    root_session_key: null,
    source_turn_key: 'turn-1',
    source_agent_key: null,
    project_id: null,
    workfolder: '/workspace/project-a',
    git_root: '/workspace/project-a',
    git_common_dir: '/workspace/project-a/.git',
    git_remote: 'example.com/acme/project-a',
    worktree: '/workspace/project-a',
    branch: 'feature/a',
    payload: { kind: 'main' },
  })
  assert.deepEqual(parseEventEnvelope(normalized), normalized)
})

test('rejects unknown top-level fields and privacy-sensitive payload fields before persistence', () => {
  assert.throws(
    () => parseEventEnvelope(startedEvent({ prompt: 'must never persist' })),
    (error) => error.code === 'EVENT_ENVELOPE_INVALID'
      && error.details.fields.includes('prompt'),
  )
  assert.throws(
    () => parseEventEnvelope(startedEvent({ payload: { kind: 'main', tool_input: 'secret' } })),
    (error) => error.code === 'EVENT_PAYLOAD_INVALID'
      && error.details.fields.includes('tool_input'),
  )
  assert.throws(
    () => parseEventEnvelope(startedEvent({ payload: { kind: { nested: true } } })),
    (error) => error.code === 'EVENT_PAYLOAD_INVALID',
  )
})

test('enforces source, event type, identity and event-specific payload contracts', () => {
  assert.throws(
    () => parseEventEnvelope(startedEvent({ source: 'unknown-host' })),
    (error) => error.code === 'EVENT_SOURCE_UNSUPPORTED',
  )
  assert.throws(
    () => parseEventEnvelope(startedEvent({ event_type: 'tool.raw-output' })),
    (error) => error.code === 'EVENT_TYPE_UNSUPPORTED',
  )
  assert.throws(
    () => parseEventEnvelope(startedEvent({ source_turn_key: null })),
    (error) => error.code === 'EVENT_ENVELOPE_INVALID'
      && error.details.field === 'source_turn_key',
  )
  assert.throws(
    () => parseEventEnvelope(startedEvent({ observed_at: 'not-a-date' })),
    (error) => error.code === 'EVENT_ENVELOPE_INVALID'
      && error.details.field === 'observed_at',
  )
})

test('accepts bounded heartbeat and stop metadata but rejects arbitrary values', () => {
  const heartbeat = parseEventEnvelope(startedEvent({
    event_type: 'execution.heartbeat',
    external_event_id: 'codex:session-1:turn-1:heartbeat:1',
    payload: { activity: 'tool_use', coalesced_count: 3 },
  }))
  assert.deepEqual(heartbeat.payload, { activity: 'tool_use', coalesced_count: 3 })

  const stopped = parseEventEnvelope(startedEvent({
    event_type: 'execution.stop',
    external_event_id: 'codex:session-1:turn-1:stop',
    payload: { end_reason: 'completed' },
  }))
  assert.deepEqual(stopped.payload, { end_reason: 'completed' })

  assert.throws(
    () => parseEventEnvelope(startedEvent({
      event_type: 'execution.heartbeat',
      payload: { activity: 'shell command: cat ~/.ssh/id_rsa' },
    })),
    (error) => error.code === 'EVENT_PAYLOAD_INVALID',
  )
})
