import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createRunStore } from '../server/src/runs/run-store.mjs'

const NOW = '2026-08-27T09:00:00.000Z'

function schedule(overrides = {}) {
  return {
    id: randomUUID(),
    etag: 'a'.repeat(64),
    title: 'Daily project review',
    prompt: 'Review the project and report concrete risks.',
    workspace: '/tmp/project',
    cadence: { kind: 'daily', hour: 9, minute: 30, timezone_mode: 'system' },
    enabled: true,
    agent: 'codex',
    sandbox_mode: 'read-only',
    model: null,
    reasoning_effort: null,
    timeout_seconds: 7_200,
    ...overrides,
  }
}

async function withStore(t, run) {
  const root = await mkdtemp(join(tmpdir(), 'tasks-recorder-run-store-'))
  const databasePath = join(root, 'runs.sqlite')
  let nextId = 0
  const store = createRunStore({
    databasePath,
    clock: () => new Date(NOW),
    createId: () => `00000000-0000-4000-8000-${String(++nextId).padStart(12, '0')}`,
  })
  t.after(() => {
    store.close()
    return rm(root, { recursive: true, force: true })
  })
  await run({ store, databasePath })
}

test('Run creation is durable before launch and deduplicates an occurrence', async (t) => {
  await withStore(t, ({ store }) => {
    const definition = schedule()
    const input = {
      schedule: definition,
      runtime_id: 'codex',
      origin: 'scheduled',
      occurrence_key: '2026-08-27T09:30+08:00',
      scheduled_for: '2026-08-27T01:30:00.000Z',
      idempotency_key: null,
    }
    const first = store.create(input)

    assert.equal(first.status, 'queued')
    assert.equal(first.snapshot.prompt, definition.prompt)
    assert.equal(store.hasOccurrence(definition.id, input.occurrence_key), true)
    assert.throws(() => store.create({ ...input, origin: 'catchup' }), {
      code: 'RUN_OCCURRENCE_EXISTS',
    })
  })
})

test('one Schedule can have only one queued or running Run', async (t) => {
  await withStore(t, ({ store }) => {
    const definition = schedule()
    store.create({
      schedule: definition,
      runtime_id: 'codex',
      origin: 'manual',
      occurrence_key: null,
      scheduled_for: null,
      idempotency_key: 'request-1',
    })
    assert.throws(() => store.create({
      schedule: definition,
      runtime_id: 'codex',
      origin: 'manual',
      occurrence_key: null,
      scheduled_for: null,
      idempotency_key: 'request-2',
    }), { code: 'RUN_ALREADY_ACTIVE' })
  })
})

test('manual idempotency returns the same Run and rejects cross-Schedule reuse', async (t) => {
  await withStore(t, ({ store }) => {
    const firstSchedule = schedule()
    const secondSchedule = schedule()
    const input = {
      schedule: firstSchedule,
      runtime_id: 'codex',
      origin: 'manual',
      occurrence_key: null,
      scheduled_for: null,
      idempotency_key: 'dashboard-click-1',
    }
    const first = store.create(input)
    assert.equal(store.create(input).id, first.id)
    assert.throws(() => store.create({ ...input, schedule: secondSchedule }), {
      code: 'RUN_IDEMPOTENCY_CONFLICT',
    })
  })
})

test('terminal completion clears the active constraint and review is monotonic', async (t) => {
  await withStore(t, ({ store }) => {
    const definition = schedule()
    const first = store.create({
      schedule: definition,
      runtime_id: 'codex',
      origin: 'manual',
      occurrence_key: null,
      scheduled_for: null,
      idempotency_key: 'request-1',
    })
    assert.equal(store.markRunning(first.id, {
      runtime_version: 'codex-cli 0.150.0',
      executable_digest: 'b'.repeat(64),
      pid: 123,
    }).status, 'running')
    assert.equal(store.complete(first.id, {
      status: 'succeeded',
      exit_code: 0,
      session_id: 'session-1',
      final_message: 'Done.',
    }).status, 'succeeded')

    const reviewed = store.markReviewed(first.id)
    assert.equal(reviewed.reviewed_at, NOW)
    assert.equal(store.markReviewed(first.id).reviewed_at, NOW)
    assert.equal(store.create({
      schedule: definition,
      runtime_id: 'codex',
      origin: 'manual',
      occurrence_key: null,
      scheduled_for: null,
      idempotency_key: 'request-2',
    }).status, 'queued')
  })
})

test('restart recovery interrupts open Runs and list omits private prompts', async (t) => {
  await withStore(t, ({ store }) => {
    const definition = schedule()
    const run = store.create({
      schedule: definition,
      runtime_id: 'codex',
      origin: 'scheduled',
      occurrence_key: '2026-08-27T09:30+08:00',
      scheduled_for: '2026-08-27T01:30:00.000Z',
      idempotency_key: null,
    })
    store.markRunning(run.id, { pid: 321 })

    assert.equal(store.interruptOpen(), 1)
    assert.equal(store.get(run.id).status, 'interrupted')
    const [summary] = store.list()
    assert.equal(Object.hasOwn(summary, 'snapshot'), false)
    assert.equal(JSON.stringify(summary).includes(definition.prompt), false)
  })
})
