import assert from 'node:assert/strict'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import {
  parseCodexImport,
  resolveCodexSession,
} from '../server/src/codex/importer.mjs'
import { readCodexTranscript } from '../server/src/codex/transcript-reader.mjs'

const FIXTURE_ROOT = new URL('./fixtures/codex/root-session.jsonl', import.meta.url)
const FIXTURE_CHILD = new URL('./fixtures/codex/child-session.jsonl', import.meta.url)

async function temporaryCodexHome() {
  const directory = await mkdtemp(join(tmpdir(), 'tasks-recorder-codex-import-'))
  const codexHome = join(directory, '.codex')
  const sessionsRoot = join(codexHome, 'sessions')
  await mkdir(sessionsRoot, { recursive: true })
  return {
    directory,
    codexHome,
    sessionsRoot,
    path(relativePath) { return join(sessionsRoot, relativePath) },
    async add(relativePath, source) {
      const target = join(sessionsRoot, relativePath)
      await mkdir(dirname(target), { recursive: true })
      await copyFile(source, target)
      return target
    },
    async cleanup() { await rm(directory, { recursive: true, force: true }) },
  }
}

test('resolves an exact Codex session and rejects missing or ambiguous metadata matches', async () => {
  const fixture = await temporaryCodexHome()
  try {
    const rootPath = await fixture.add(
      '2026/08/14/rollout-2026-08-14T09-00-00-root-session.jsonl',
      FIXTURE_ROOT,
    )
    await fixture.add(
      '2026/08/14/rollout-2026-08-14T09-01-00-child-session.jsonl',
      FIXTURE_CHILD,
    )

    const resolved = await resolveCodexSession({
      sessionId: 'root-session',
      codexHome: fixture.codexHome,
    })
    assert.equal(resolved.path, rootPath)
    assert.equal(resolved.metadata.session_id, 'root-session')

    await assert.rejects(
      resolveCodexSession({ sessionId: 'root', codexHome: fixture.codexHome }),
      (error) => error.code === 'CODEX_SESSION_NOT_FOUND',
    )

    await fixture.add('duplicate/root-session.jsonl', FIXTURE_ROOT)
    await assert.rejects(
      resolveCodexSession({ sessionId: 'root-session', codexHome: fixture.codexHome }),
      (error) => error.code === 'CODEX_SESSION_AMBIGUOUS',
    )
  } finally {
    await fixture.cleanup()
  }
})

test('reads only lifecycle projections and reports malformed recognized lines', async () => {
  const fixture = await temporaryCodexHome()
  try {
    const rootPath = await fixture.add('root-session.jsonl', FIXTURE_ROOT)
    const parsed = await readCodexTranscript(rootPath, { sessionsRoot: fixture.sessionsRoot })

    assert.equal(parsed.metadata.session_id, 'root-session')
    assert.deepEqual(parsed.turns.map(({ turn_id, status }) => ({ turn_id, status })), [
      { turn_id: 'turn-1', status: 'completed' },
      { turn_id: 'turn-2', status: 'interrupted' },
    ])
    assert.equal(parsed.successful_spawns.length, 2)
    assert.equal(parsed.failed_spawns.length, 1)
    assert.deepEqual(parsed.warnings.map(({ code }) => code), ['TRANSCRIPT_LINE_MALFORMED'])

    const serialized = JSON.stringify(parsed)
    for (const privateMarker of [
      'synthetic private delegation text',
      'synthetic assistant content',
      'synthetic failure details',
      'base_instructions',
      'last_agent_message',
    ]) {
      assert.equal(serialized.includes(privateMarker), false)
    }
  } finally {
    await fixture.cleanup()
  }
})

test('normalizes root turns and actual child transcripts without guessing Tasks', async () => {
  const fixture = await temporaryCodexHome()
  try {
    await fixture.add('2026/08/14/root-session.jsonl', FIXTURE_ROOT)
    await fixture.add('2026/08/14/child-session.jsonl', FIXTURE_CHILD)

    const first = await parseCodexImport({
      sessionId: 'root-session',
      codexHome: fixture.codexHome,
    })
    const second = await parseCodexImport({
      sessionId: 'root-session',
      codexHome: fixture.codexHome,
    })

    assert.deepEqual(first, second)
    assert.equal(first.source, 'codex')
    assert.equal(first.session_id, 'root-session')
    assert.equal(first.root_turns, 2)
    assert.equal(first.subagent_executions, 1)
    assert.equal(first.records.length, 3)
    assert.deepEqual(first.records.map(({ external_key }) => external_key), [
      'codex:turn:root-session:turn-1:0',
      'codex:turn:root-session:turn-2:0',
      'codex:import:subagent:root-session:child-session',
    ])
    assert.deepEqual(first.records.map(({ status }) => status), [
      'completed', 'interrupted', 'completed',
    ])
    assert.equal(first.records[2].turn_id, 'turn-1')
    assert.equal(first.records[2].parent_external_key, 'codex:turn:root-session:turn-1:0')
    assert.ok(first.records.every(({ task_id, classification }) => (
      task_id === null && classification === 'unknown'
    )))
    assert.deepEqual(first.warnings.map(({ code }) => code).sort(), [
      'CODEX_CHILD_TRANSCRIPT_MISSING',
      'CODEX_SUBAGENT_SPAWN_FAILED',
      'TRANSCRIPT_LINE_MALFORMED',
    ])

    const serialized = JSON.stringify(first)
    assert.equal(serialized.includes('synthetic'), false)
    assert.equal(serialized.includes('message'), false)
    assert.equal(serialized.includes('reasoning'), false)
  } finally {
    await fixture.cleanup()
  }
})

test('discovers 98 unique direct child session transcripts deterministically', async () => {
  const fixture = await temporaryCodexHome()
  try {
    const rootLines = [JSON.stringify({
      timestamp: '2026-08-14T00:00:00.000Z',
      type: 'session_meta',
      payload: { id: 'generated-root', session_id: 'generated-root', cwd: '/workspace' },
    }), JSON.stringify({
      timestamp: '2026-08-14T00:00:01.000Z',
      type: 'event_msg',
      payload: { type: 'task_started', turn_id: 'generated-turn' },
    })]
    for (let index = 0; index < 98; index += 1) {
      const callId = `spawn-${String(index).padStart(3, '0')}`
      const agentPath = `/root/worker-${String(index).padStart(3, '0')}`
      rootLines.push(
        JSON.stringify({
          timestamp: `2026-08-14T00:01:${String(index % 60).padStart(2, '0')}.000Z`,
          type: 'response_item',
          payload: {
            type: 'function_call', name: 'spawn_agent', call_id: callId,
            arguments: JSON.stringify({ task_name: agentPath.slice(6), message: 'discard me' }),
          },
        }),
        JSON.stringify({
          timestamp: `2026-08-14T00:02:${String(index % 60).padStart(2, '0')}.000Z`,
          type: 'response_item',
          payload: { type: 'function_call_output', call_id: callId, output: JSON.stringify({ task_name: agentPath }) },
        }),
      )
    }
    rootLines.push(JSON.stringify({
      timestamp: '2026-08-14T00:59:00.000Z',
      type: 'event_msg',
      payload: { type: 'task_complete', turn_id: 'generated-turn' },
    }))
    await mkdir(dirname(fixture.path('root/generated-root.jsonl')), { recursive: true })
    await writeFile(fixture.path('root/generated-root.jsonl'), rootLines.join('\n'))

    for (let index = 0; index < 98; index += 1) {
      const suffix = String(index).padStart(3, '0')
      const child = [
        JSON.stringify({
          timestamp: `2026-08-14T00:03:${String(index % 60).padStart(2, '0')}.000Z`,
          type: 'session_meta',
          payload: {
            id: `generated-child-${suffix}`,
            session_id: 'generated-root',
            parent_thread_id: 'generated-root',
            cwd: '/workspace',
            source: { subagent: { thread_spawn: {
              parent_thread_id: 'generated-root', agent_path: `/root/worker-${suffix}`,
              agent_role: 'worker',
            } } },
            agent_path: `/root/worker-${suffix}`,
            agent_role: 'worker',
          },
        }),
        JSON.stringify({
          timestamp: `2026-08-14T00:04:${String(index % 60).padStart(2, '0')}.000Z`,
          type: 'event_msg',
          payload: { type: 'task_started', turn_id: `child-turn-${suffix}` },
        }),
        JSON.stringify({
          timestamp: `2026-08-14T00:05:${String(index % 60).padStart(2, '0')}.000Z`,
          type: 'event_msg',
          payload: { type: 'task_complete', turn_id: `child-turn-${suffix}` },
        }),
      ]
      const path = fixture.path(`children/generated-child-${suffix}.jsonl`)
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, child.join('\n'))
    }

    const imported = await parseCodexImport({
      sessionId: 'generated-root', codexHome: fixture.codexHome,
    })
    assert.equal(imported.root_turns, 1)
    assert.equal(imported.subagent_executions, 98)
    assert.equal(new Set(imported.records.map(({ external_key }) => external_key)).size, 99)
    assert.equal(imported.warnings.length, 0)
  } finally {
    await fixture.cleanup()
  }
})

test('fixture files remain explicitly synthetic and do not contain real session identifiers', async () => {
  const sources = await Promise.all([FIXTURE_ROOT, FIXTURE_CHILD].map((url) => readFile(url, 'utf8')))
  assert.ok(sources.every((source) => source.includes('synthetic')))
  assert.ok(sources.every((source) => !source.includes('019fa297-4567-7bf0-a69a-84fd23b3aaab')))
})
