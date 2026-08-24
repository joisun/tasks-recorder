import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import { createCodexSessionInventory } from '../server/src/codex/session-inventory.mjs'

const SESSION_ID = '019fa297-4567-7bf0-a69a-84fd23b3aaab'

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'tasks-recorder-session-inventory-'))
  const sessionsRoot = join(directory, 'sessions')
  await mkdir(sessionsRoot, { recursive: true })
  return {
    directory,
    sessionsRoot,
    async add(relativePath, sessionId = SESSION_ID) {
      const path = join(sessionsRoot, relativePath)
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, `${JSON.stringify({
        timestamp: '2026-08-24T08:00:00.000Z',
        type: 'session_meta',
        payload: { id: sessionId, cwd: '/workspace' },
      })}\n`)
      return path
    },
    async cleanup() { await rm(directory, { recursive: true, force: true }) },
  }
}

test('indexes standard Codex rollout filenames and verifies their metadata before launch', async () => {
  const current = await fixture()
  try {
    await current.add(`2026/08/24/rollout-2026-08-24T08-00-00-${SESSION_ID}.jsonl`)
    const inventory = createCodexSessionInventory({ sessionsRoot: current.sessionsRoot })

    assert.deepEqual([...await inventory.ids()], [SESSION_ID])
    assert.equal(await inventory.has(SESSION_ID), true)
    assert.equal(await inventory.has('01900000-0000-0000-0000-000000000000'), false)
  } finally {
    await current.cleanup()
  }
})

test('does not advertise mismatched, ambiguous, malformed, or non-standard transcripts', async () => {
  const current = await fixture()
  try {
    await current.add(`a/rollout-${SESSION_ID}.jsonl`, '01900000-0000-0000-0000-000000000000')
    await current.add(`b/rollout-${SESSION_ID}.jsonl`)
    await current.add('legacy-name.jsonl')
    const inventory = createCodexSessionInventory({ sessionsRoot: current.sessionsRoot })

    assert.deepEqual([...await inventory.ids()], [])
    assert.equal(await inventory.has(SESSION_ID), false)
  } finally {
    await current.cleanup()
  }
})

test('refreshes the filename index after the bounded cache expires', async () => {
  const current = await fixture()
  let now = 0
  try {
    const inventory = createCodexSessionInventory({
      sessionsRoot: current.sessionsRoot,
      cacheTtlMs: 10,
      clock: () => now,
    })
    assert.deepEqual([...await inventory.ids()], [])

    await current.add(`rollout-${SESSION_ID}.jsonl`)
    assert.deepEqual([...await inventory.ids()], [])
    now = 10
    assert.deepEqual([...await inventory.ids()], [SESSION_ID])
  } finally {
    await current.cleanup()
  }
})
