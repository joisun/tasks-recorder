import assert from 'node:assert/strict'
import test from 'node:test'

import { createCodexJsonlCollector } from '../server/src/scheduler/codex-jsonl.mjs'
import { parseCodexJsonLine } from '../server/src/runtime/parsers/codex-jsonl.mjs'

const RUN_ID = '22222222-2222-4222-8222-222222222222'
const SESSION_ID = '33333333-3333-4333-8333-333333333333'

test('normalizes a Codex thread into a bounded session event', () => {
  const events = parseCodexJsonLine(JSON.stringify({
    type: 'thread.started',
    thread_id: SESSION_ID,
  }), {
    runId: RUN_ID,
    sequence: 4,
    observedAt: '2026-08-27T00:00:00.000Z',
  })

  assert.deepEqual(events.at(-1), {
    runId: RUN_ID,
    sequence: 4,
    observedAt: '2026-08-27T00:00:00.000Z',
    type: 'session',
    payload: { session_id: SESSION_ID },
  })
})

test('normalizes only contained completed file changes and ignores unknown events', () => {
  const context = {
    runId: RUN_ID,
    sequence: 5,
    observedAt: '2026-08-27T00:00:01.000Z',
    workspace: '/workspace/project',
  }
  const events = parseCodexJsonLine(JSON.stringify({
    type: 'item.completed',
    item: {
      type: 'file_change',
      status: 'completed',
      changes: [
        { path: '/workspace/project/src/index.mjs', kind: 'update' },
        { path: '../outside.txt', kind: 'delete' },
        { path: '/workspace/project/unsafe.txt', kind: 'chmod' },
      ],
    },
  }), context)

  assert.deepEqual(events, [{
    runId: RUN_ID,
    sequence: 5,
    observedAt: '2026-08-27T00:00:01.000Z',
    type: 'file_change',
    payload: { changes: [{ path: 'src/index.mjs', kind: 'update' }] },
  }])
  assert.deepEqual(parseCodexJsonLine('{"type":"future.event"}', context), [])
  assert.deepEqual(parseCodexJsonLine('{malformed', context), [])
})

test('parses only chunk-split stdout JSONL, preserving UTF-8 and the final agent message', () => {
  const collector = createCodexJsonlCollector({ maxLineBytes: 1024, maxFinalMessageBytes: 64 })
  const lines = [
    JSON.stringify({ type: 'thread.started', thread_id: 'thread-123' }),
    JSON.stringify({ type: 'item.completed', item: { type: 'tool_call', name: 'shell' } }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'first' } }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '最终答复🙂' } }),
    JSON.stringify({ type: 'turn.completed' }),
  ].join('\n') + '\n'
  const bytes = Buffer.from(lines)
  collector.write(bytes.subarray(0, 17))
  collector.write(bytes.subarray(17, bytes.length - 2))
  collector.write(bytes.subarray(bytes.length - 2))
  const result = collector.finish()

  assert.equal(result.thread_id, 'thread-123')
  assert.equal(result.final_message, '最终答复🙂')
  assert.equal(result.malformed_lines, 0)
  assert.equal(result.terminal_seen, true)
})

test('never treats stderr-like input as protocol and bounds malformed, oversized, and final-message output', () => {
  const collector = createCodexJsonlCollector({ maxLineBytes: 24, maxFinalMessageBytes: 8 })
  collector.write(Buffer.from('{"type":"thread.started","thread_id":"from-stderr"}\n'))
  collector.write(Buffer.from('x'.repeat(40)))
  collector.write(Buffer.from('\n{not json}\n'))
  collector.write(Buffer.from(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '123456789' } }) + '\n'))
  const result = collector.finish()

  assert.equal(result.thread_id, null)
  assert.equal(result.final_message, null)
  assert.equal(result.oversized_lines >= 1, true)
  assert.equal(result.malformed_lines >= 1, true)
  assert.equal(JSON.stringify(result).includes('from-stderr'), false)
})

test('drops a huge unterminated line without retaining the whole chunk and locks the final message at turn completion', () => {
  const collector = createCodexJsonlCollector({ maxLineBytes: 1024, maxFinalMessageBytes: 64 })
  collector.write(Buffer.alloc(1024 * 1024, 0x78))
  collector.write(Buffer.from('\n'))
  collector.write(Buffer.from(`${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'for-this-turn' } })}\n`))
  collector.write(Buffer.from(`${JSON.stringify({ type: 'turn.completed' })}\n`))
  collector.write(Buffer.from(`${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'later-noise' } })}\n`))
  const result = collector.finish()
  assert.equal(result.buffered_bytes <= 1032, true)
  assert.equal(result.oversized_lines >= 1, true)
  assert.equal(result.final_message, 'for-this-turn')
})

test('does not copy a Buffer input before incrementally scanning it', () => {
  const collector = createCodexJsonlCollector({ maxLineBytes: 1024, maxFinalMessageBytes: 64 })
  const source = Buffer.from(`${JSON.stringify({ type: 'thread.started', thread_id: 'zero-copy' })}\n`)
  const from = Buffer.from
  Buffer.from = function guarded(value, ...rest) {
    if (value === source) throw new Error('copied source Buffer')
    return from.call(Buffer, value, ...rest)
  }
  try { collector.write(source) } finally { Buffer.from = from }
  assert.equal(collector.finish().thread_id, 'zero-copy')
})

test('collects only completed file changes contained by the Workspace as bounded relative evidence', () => {
  const collector = createCodexJsonlCollector({
    workspace: '/workspace/project',
    maxLineBytes: 4096,
    maxFinalMessageBytes: 64,
    maxFileChanges: 3,
  })
  const events = [
    { type: 'item.completed', item: { type: 'file_change', status: 'completed', changes: [
      { path: '/workspace/project/src/index.mjs', kind: 'add' },
      { path: 'README.md', kind: 'update' },
      { path: '/workspace/project/src/index.mjs', kind: 'update' },
      { path: '/workspace/other/private.txt', kind: 'delete' },
      { path: '../escape.txt', kind: 'add' },
    ] } },
    { type: 'item.completed', item: { type: 'file_change', status: 'failed', changes: [
      { path: '/workspace/project/failed.txt', kind: 'add' },
    ] } },
    { type: 'item.completed', item: { type: 'file_change', status: 'completed', changes: [
      { path: '/workspace/project/docs/guide.md', kind: 'delete' },
      { path: '/workspace/project/ignored-after-cap.md', kind: 'add' },
    ] } },
  ]
  collector.write(`${events.map((event) => JSON.stringify(event)).join('\n')}\n`)

  assert.deepEqual(collector.finish().file_changes, [
    { path: 'src/index.mjs', kind: 'update' },
    { path: 'README.md', kind: 'update' },
    { path: 'docs/guide.md', kind: 'delete' },
  ])
})
