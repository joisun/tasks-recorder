import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createDefinitionScheduleService } from '../server/src/scheduler/scheduler-service.mjs'

const ID = '11111111-1111-4111-8111-111111111111'

function repository(seed = []) {
  const jobs = new Map(seed.map((job) => [job.id, { ...job }]))
  return {
    async list() { return [...jobs.values()].map((job) => ({ ...job })) },
    async invalid() { return [] },
    async get(id) {
      const job = jobs.get(id)
      if (!job) throw Object.assign(new Error('missing'), { code: 'SCHEDULE_NOT_FOUND' })
      return { ...job }
    },
    async create(input) {
      const job = { ...input, id: ID, etag: 'a'.repeat(64), enabled: true }
      jobs.set(job.id, job)
      return { ...job }
    },
    async update(id, etag, patch) {
      const job = { ...jobs.get(id), ...patch, etag: 'b'.repeat(64) }
      jobs.set(id, job)
      return { ...job }
    },
    async setEnabled(id, etag, enabled) {
      const job = { ...jobs.get(id), enabled, etag: 'c'.repeat(64) }
      jobs.set(id, job)
      return { ...job }
    },
    async remove(id) {
      jobs.delete(id)
      return { id, trashed_path: `/trash/${id}.md` }
    },
  }
}

test('definition Schedule service validates a registered agent without probing its binary', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'tasks-recorder-definition-service-'))
  const definitions = repository()
  const requested = []
  const runtimeRegistry = {
    get(id) {
      requested.push(id)
      if (id !== 'codex') throw Object.assign(new Error('unknown'), { code: 'RUNTIME_NOT_FOUND' })
      return { id }
    },
    resolve() { throw new Error('definition CRUD must not probe a runtime') },
  }
  try {
    const service = createDefinitionScheduleService({ definitions, runtimeRegistry })
    const result = await service.createJob({
      title: 'Daily review',
      prompt: 'Review the repository.',
      workspace,
      agent: 'codex',
      cadence: { kind: 'daily', hour: 9, minute: 30 },
      sandbox_mode: 'read-only',
      model: null,
      reasoning_effort: null,
      timeout_seconds: 600,
      capabilities: { skills: 'disabled', integrations: 'disabled' },
    })

    assert.equal(result.job.agent, 'codex')
    assert.equal(result.job.workspace, await realpath(workspace))
    assert.deepEqual(result.job.capabilities, { skills: 'disabled', integrations: 'disabled' })
    assert.deepEqual(requested, ['codex'])
    assert.equal('runNow' in service, false)
    assert.equal('listRuns' in service, false)
    assert.equal('capability' in service, false)
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})
test('definition Schedule service rejects an unknown agent before writing Markdown', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'tasks-recorder-definition-service-'))
  let writes = 0
  const definitions = repository()
  definitions.create = async () => { writes += 1 }
  try {
    const service = createDefinitionScheduleService({
      definitions,
      runtimeRegistry: {
        get() { throw Object.assign(new Error('unknown'), { code: 'RUNTIME_NOT_FOUND' }) },
      },
    })
    await assert.rejects(
      service.createJob({
        title: 'Unknown runtime',
        prompt: 'Do work.',
        workspace,
        agent: 'missing-agent',
        cadence: { kind: 'hourly', minute: 5 },
      }),
      { code: 'RUNTIME_NOT_FOUND' },
    )
    assert.equal(writes, 0)
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})
