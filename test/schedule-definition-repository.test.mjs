import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { test } from 'node:test'

import { createScheduleDefinitionRepository } from '../server/src/scheduler/schedule-definition-repository.mjs'

function definition(id, title = 'Daily review') {
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

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'tasks-recorder-definitions-'))
  t.after(async () => (await import('node:fs/promises')).rm(root, { recursive: true, force: true }))
  return { root, repository: createScheduleDefinitionRepository({ rootDirectory: root }) }
}

test('recursively scans marked Markdown, ignores ordinary files and dot directories', async (t) => {
  const { root, repository } = await fixture(t)
  const id = randomUUID()
  await mkdir(join(root, 'team'), { recursive: true })
  await mkdir(join(root, '.drafts'), { recursive: true })
  await writeFile(join(root, 'notes.md'), '# Notes\n')
  await writeFile(join(root, 'team', 'review.md'), definition(id))
  await writeFile(join(root, '.drafts', 'ignored.md'), definition(randomUUID()))

  const result = await repository.scan()
  assert.deepEqual(result.jobs.map(({ id: value }) => value), [id])
  assert.equal(result.invalid.length, 0)
  assert.equal(result.jobs[0].source_path, await realpath(join(root, 'team', 'review.md')))
  assert.match(result.jobs[0].updated_at, /^\d{4}-\d{2}-\d{2}T/)
})

test('fails duplicate IDs closed and reports both bounded source paths', async (t) => {
  const { root, repository } = await fixture(t)
  const id = randomUUID()
  await writeFile(join(root, 'one.md'), definition(id, 'One'))
  await writeFile(join(root, 'two.md'), definition(id, 'Two'))

  const result = await repository.scan()
  assert.equal(result.jobs.length, 0)
  assert.equal(result.invalid.length, 2)
  assert.ok(result.invalid.every(({ error_code }) => error_code === 'SCHEDULE_DEFINITION_DUPLICATE_ID'))
})

test('creates, CAS-updates, pauses and recoverably removes definitions', async (t) => {
  const { root, repository } = await fixture(t)
  const id = randomUUID()
  const created = await repository.create({
    id,
    title: 'Daily review',
    prompt: 'Review the project.',
    workspace: '/tmp/project',
    cadence: { kind: 'daily', hour: 9, minute: 0 },
    sandbox_mode: 'read-only',
    timeout_seconds: 7200,
  })
  assert.equal(created.id, id)
  assert.match(basename(created.source_path), /^daily-review--[0-9a-f]{8}\.md$/)
  assert.equal((await readFile(created.source_path, 'utf8')).includes('type: tasks-recorder/schedule'), true)

  const updated = await repository.update(id, created.etag, { title: 'Morning review' })
  assert.equal(updated.title, 'Morning review')
  assert.notEqual(updated.etag, created.etag)
  await assert.rejects(() => repository.update(id, created.etag, { title: 'Stale write' }), (error) => error.code === 'SCHEDULE_VERSION_CONFLICT')

  const paused = await repository.setEnabled(id, updated.etag, false)
  assert.equal(paused.enabled, false)
  const removed = await repository.remove(id, paused.etag)
  assert.equal(removed.id, id)
  assert.match(removed.trashed_path, /\/\.trash\//)
  assert.equal((await repository.scan()).jobs.length, 0)
  assert.match(await readFile(removed.trashed_path, 'utf8'), /id:/)
})

test('does not follow definition symlinks', async (t) => {
  const { root, repository } = await fixture(t)
  const outside = join(root, '..', `outside-${randomUUID()}.md`)
  t.after(async () => (await import('node:fs/promises')).rm(outside, { force: true }))
  await writeFile(outside, definition(randomUUID()))
  await symlink(outside, join(root, 'linked.md'))
  const result = await repository.scan()
  assert.equal(result.jobs.length, 0)
  assert.equal(result.invalid.length, 1)
  assert.equal(result.invalid[0].error_code, 'SCHEDULE_DEFINITION_UNSAFE_FILE')
})

test('surfaces malformed marked files without blocking valid definitions', async (t) => {
  const { root, repository } = await fixture(t)
  const id = randomUUID()
  await writeFile(join(root, 'valid.md'), definition(id))
  await writeFile(join(root, 'broken.md'), '---\ntype: tasks-recorder/schedule\nid: [broken\n---\nPrompt\n')
  const result = await repository.scan()
  assert.deepEqual(result.jobs.map(({ id: value }) => value), [id])
  assert.equal(result.invalid.length, 1)
  assert.equal(result.invalid[0].error_code, 'SCHEDULE_DEFINITION_YAML_INVALID')
})
