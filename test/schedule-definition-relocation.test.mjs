import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  createDeferredDefinitionDiffHandler,
  createSwitchableScheduleDefinitionRepository,
  stageScheduleDefinitionRelocation,
} from '../server/src/scheduler/schedule-definition-relocation.mjs'
import { createScheduleDefinitionRepository } from '../server/src/scheduler/schedule-definition-repository.mjs'

function definition(id, title) {
  return `---
type: tasks-recorder/schedule
id: ${id}
title: ${title}
workspace: /tmp/project
schedule:
  kind: daily
  at: "09:00"
---

Review the project.
`
}

test('relocates source definitions into a merged target registry and archives originals on commit', async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), 'tasks-recorder-relocation-'))
  t.after(() => rm(fixture, { recursive: true, force: true }))
  const sourceRoot = join(fixture, 'source')
  const targetRoot = join(fixture, 'target')
  await mkdir(join(sourceRoot, 'team'), { recursive: true })
  await mkdir(targetRoot)
  const sourceId = randomUUID()
  const targetId = randomUUID()
  await writeFile(join(sourceRoot, 'team', 'source.md'), definition(sourceId, 'Source schedule'))
  await writeFile(join(targetRoot, 'target.md'), definition(targetId, 'Target schedule'))
  await writeFile(join(targetRoot, 'notes.md'), '# Keep me\n')
  const source = createScheduleDefinitionRepository({ rootDirectory: sourceRoot })

  const transaction = await stageScheduleDefinitionRelocation({
    sourceRepository: source,
    targetDirectory: targetRoot,
    clock: () => new Date('2026-08-26T04:00:00.000Z'),
  })

  assert.deepEqual(
    (await transaction.candidateRepository.list()).map(({ id }) => id).sort(),
    [sourceId, targetId].sort(),
  )
  assert.equal(transaction.movedCount, 1)
  assert.equal(transaction.mergedCount, 1)
  assert.match(await readFile(join(targetRoot, 'team', 'source.md'), 'utf8'), /Source schedule/)
  assert.equal(await readFile(join(targetRoot, 'notes.md'), 'utf8'), '# Keep me\n')

  const committed = await transaction.commit()
  assert.equal(committed.cleanupWarning, null)
  await assert.rejects(readFile(join(sourceRoot, 'team', 'source.md'), 'utf8'), { code: 'ENOENT' })
  assert.match(
    await readFile(join(sourceRoot, '.trash', 'migrated-2026-08-26T04-00-00-000Z', 'team', 'source.md'), 'utf8'),
    /Source schedule/,
  )
})

test('switchable definition repository changes every consumer to one active registry', async () => {
  const calls = []
  const repository = (rootDirectory, id) => ({
    rootDirectory,
    async scan() { return { jobs: [{ id }], invalid: [] } },
    async list() { calls.push(id); return [{ id }] },
    async invalid() { return [] },
    async get() { return { id } },
    async create() {},
    async update() {},
    async setEnabled() {},
    async remove() {},
  })
  const first = repository('/first', 'first')
  const second = repository('/second', 'second')
  const registry = createSwitchableScheduleDefinitionRepository(first)

  assert.equal(registry.rootDirectory, '/first')
  assert.deepEqual(await registry.list(), [{ id: 'first' }])
  assert.equal(registry.replace(second), first)
  assert.equal(registry.rootDirectory, '/second')
  assert.deepEqual(await registry.list(), [{ id: 'second' }])
  assert.deepEqual(calls, ['first', 'second'])
})

test('definition diffs stay non-blocking during registry handoff and drain before live delivery', async () => {
  const events = []
  const handler = createDeferredDefinitionDiffHandler({
    live: async (diff) => { events.push(`live:${diff.id}`) },
  })

  await handler.handle({ id: 'one' })
  await handler.handle({ id: 'two' })
  assert.deepEqual(events, [])
  await handler.activate(async (diff) => { events.push(`handoff:${diff.id}`) })
  await handler.handle({ id: 'three' })

  assert.deepEqual(events, ['handoff:one', 'handoff:two', 'live:three'])
})

test('failed verification never deletes a target definition changed by another writer', async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), 'tasks-recorder-relocation-race-'))
  t.after(() => rm(fixture, { recursive: true, force: true }))
  const sourceRoot = join(fixture, 'source')
  const targetRoot = join(fixture, 'target')
  await mkdir(sourceRoot)
  await mkdir(targetRoot)
  const scheduleId = randomUUID()
  const targetPath = join(targetRoot, 'source.md')
  await writeFile(join(sourceRoot, 'source.md'), definition(scheduleId, 'Source schedule'))
  const source = createScheduleDefinitionRepository({ rootDirectory: sourceRoot })
  let scans = 0

  await assert.rejects(stageScheduleDefinitionRelocation({
    sourceRepository: source,
    targetDirectory: targetRoot,
    createRepository: ({ rootDirectory }) => ({
      rootDirectory,
      async scan() {
        scans += 1
        if (scans === 1) return { jobs: [], invalid: [] }
        await writeFile(targetPath, '# Changed by an editor\n')
        return {
          jobs: [],
          invalid: [{ source_path: targetPath, error_code: 'EXTERNAL_CHANGE', message: 'changed' }],
        }
      },
    }),
  }), { code: 'SCHEDULE_RELOCATION_VERIFICATION_FAILED' })

  assert.equal(await readFile(targetPath, 'utf8'), '# Changed by an editor\n')
})

test('rejects invalid source definitions and target ID or relative-path conflicts without overwriting files', async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), 'tasks-recorder-relocation-conflict-'))
  t.after(() => rm(fixture, { recursive: true, force: true }))
  const sourceRoot = join(fixture, 'source')
  const targetRoot = join(fixture, 'target')
  await mkdir(sourceRoot)
  await mkdir(targetRoot)
  const scheduleId = randomUUID()
  const sourcePath = join(sourceRoot, 'same.md')
  const targetPath = join(targetRoot, 'same.md')
  await writeFile(sourcePath, definition(scheduleId, 'Source'))
  await writeFile(targetPath, '# Existing note\n')
  const source = createScheduleDefinitionRepository({ rootDirectory: sourceRoot })

  await assert.rejects(stageScheduleDefinitionRelocation({
    sourceRepository: source,
    targetDirectory: targetRoot,
  }), { code: 'SCHEDULE_RELOCATION_PATH_CONFLICT' })
  assert.equal(await readFile(targetPath, 'utf8'), '# Existing note\n')
  assert.match(await readFile(sourcePath, 'utf8'), /title: Source/)

  await rm(targetPath)
  await writeFile(join(targetRoot, 'different.md'), definition(scheduleId, 'Different target'))
  await assert.rejects(stageScheduleDefinitionRelocation({
    sourceRepository: source,
    targetDirectory: targetRoot,
  }), { code: 'SCHEDULE_RELOCATION_ID_CONFLICT' })

  await writeFile(join(sourceRoot, 'broken.md'), '---\ntype: tasks-recorder/schedule\nid: [broken\n---\nPrompt\n')
  await assert.rejects(stageScheduleDefinitionRelocation({
    sourceRepository: source,
    targetDirectory: targetRoot,
  }), { code: 'SCHEDULE_RELOCATION_SOURCE_INVALID' })
})

test('rollback removes only owned target copies while a cleanup race leaves the source recoverable', async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), 'tasks-recorder-relocation-rollback-'))
  t.after(() => rm(fixture, { recursive: true, force: true }))
  const sourceRoot = join(fixture, 'source')
  const targetRoot = join(fixture, 'target')
  await mkdir(sourceRoot)
  await mkdir(targetRoot)
  const scheduleId = randomUUID()
  const sourcePath = join(sourceRoot, 'source.md')
  const targetPath = join(targetRoot, 'source.md')
  await writeFile(sourcePath, definition(scheduleId, 'Source'))
  const source = createScheduleDefinitionRepository({ rootDirectory: sourceRoot })

  const rolledBack = await stageScheduleDefinitionRelocation({
    sourceRepository: source,
    targetDirectory: targetRoot,
  })
  assert.equal((await rolledBack.rollback()).cleanupWarning, null)
  await assert.rejects(readFile(targetPath, 'utf8'), { code: 'ENOENT' })
  assert.match(await readFile(sourcePath, 'utf8'), /title: Source/)

  const cleanupRace = await stageScheduleDefinitionRelocation({
    sourceRepository: source,
    targetDirectory: targetRoot,
  })
  await writeFile(sourcePath, definition(scheduleId, 'Edited during cleanup'))
  const committed = await cleanupRace.commit()
  assert.match(committed.cleanupWarning, /source\.md/)
  assert.match(await readFile(sourcePath, 'utf8'), /Edited during cleanup/)
  assert.match(await readFile(targetPath, 'utf8'), /title: Source/)
})
