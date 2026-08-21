import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import { createProjectStore } from '../mcp/src/project-store.mjs'
import { createSchemaV3 } from '../mcp/src/schema-v3.mjs'

function fixture() {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  createSchemaV3(db)
  let now = new Date('2026-08-19T01:00:00.000Z')
  const store = createProjectStore({ db, clock: () => now })
  return {
    db,
    store,
    setNow(value) { now = new Date(value) },
  }
}

test('project identity survives revisioned rename and archive operations', () => {
  const { db, store, setNow } = fixture()
  try {
    const created = store.create({ id: 'project-a', name: 'Project A' })
    assert.equal(created.changed, true)
    assert.deepEqual({ ...created.project }, {
      id: 'project-a',
      name: 'Project A',
      description: null,
      revision: 1,
      archived_at: null,
      created_at: '2026-08-19T01:00:00.000Z',
      updated_at: '2026-08-19T01:00:00.000Z',
    })

    setNow('2026-08-19T02:00:00.000Z')
    const renamed = store.update({
      id: 'project-a',
      expected_revision: 1,
      patch: { name: 'Renamed Project', description: 'Stable identity' },
    })
    assert.equal(renamed.project.id, 'project-a')
    assert.equal(renamed.project.revision, 2)
    assert.equal(renamed.project.name, 'Renamed Project')
    assert.throws(
      () => store.update({
        id: 'project-a',
        expected_revision: 1,
        patch: { name: 'Stale write' },
      }),
      (error) => error.code === 'PROJECT_VERSION_CONFLICT'
        && error.details.current.revision === 2,
    )

    setNow('2026-08-19T03:00:00.000Z')
    const archived = store.archive({ id: 'project-a', expected_revision: 2 })
    assert.equal(archived.project.id, 'project-a')
    assert.equal(archived.project.revision, 3)
    assert.equal(archived.project.archived_at, '2026-08-19T03:00:00.000Z')
    assert.deepEqual(store.list(), [])
    assert.equal(store.list({ archived: true })[0].id, 'project-a')
  } finally {
    db.close()
  }
})

test('project locations support multiple worktrees while exact local ownership stays unique', () => {
  const { db, store, setNow } = fixture()
  try {
    store.create({ id: 'project-a', name: 'Project A' })
    store.create({ id: 'project-b', name: 'Project B' })
    store.registerLocation({
      project_id: 'project-a',
      kind: 'workspace',
      value: '/repo/a/',
    })
    store.registerLocation({
      project_id: 'project-a',
      kind: 'workspace',
      value: '/repo/a/.worktree/feature-a',
    })
    setNow('2026-08-19T02:00:00.000Z')
    const replayed = store.registerLocation({
      project_id: 'project-a',
      kind: 'workspace',
      value: '/repo/a',
    })
    assert.equal(replayed.changed, true)
    assert.equal(replayed.location.normalized_value, '/repo/a')
    assert.equal(replayed.location.last_seen_at, '2026-08-19T02:00:00.000Z')

    assert.throws(
      () => store.registerLocation({
        project_id: 'project-b',
        kind: 'workspace',
        value: '/repo/a',
      }),
      (error) => error.code === 'PROJECT_LOCATION_CONFLICT'
        && error.details.project_id === 'project-a',
    )

    store.registerLocation({
      project_id: 'project-a',
      kind: 'git_remote',
      value: 'https://github.com/example/repo',
    })
    assert.doesNotThrow(() => store.registerLocation({
      project_id: 'project-b',
      kind: 'git_remote',
      value: 'https://github.com/example/repo',
    }))
    assert.equal(store.show('project-a').locations.length, 3)
  } finally {
    db.close()
  }
})
