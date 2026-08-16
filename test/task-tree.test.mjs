import assert from 'node:assert/strict'
import test from 'node:test'

import { taskInput, temporaryStore } from './helpers.mjs'

test('root progress excludes canceled children from the remaining total', async () => {
  const fixture = await temporaryStore()
  try {
    fixture.store.upsert(taskInput({ id: 'root', title: 'Root' }))
    fixture.store.upsert(taskInput({
      id: 'done-child', parent_id: 'root', title: 'Done child', status: 'done',
    }))
    fixture.store.upsert(taskInput({
      id: 'canceled-child', parent_id: 'root', title: 'Canceled child', status: 'canceled',
    }))

    assert.deepEqual(fixture.store.show('root').progress, {
      total: 1,
      remaining: 0,
      completed: 1,
      ratio: 1,
    })
  } finally {
    await fixture.cleanup()
  }
})

test('creating a child increments the root tree revision', async () => {
  const fixture = await temporaryStore()
  try {
    const root = fixture.store.upsert(taskInput({ id: 'root', title: 'Root' })).task
    assert.equal(root.revision, 1)

    const child = fixture.store.upsert(taskInput({
      id: 'child', parent_id: 'root', title: 'Child', status: 'planned',
    })).task

    assert.equal(child.revision, 1)
    assert.equal(fixture.store.show('root').task.revision, 2)
  } finally {
    await fixture.cleanup()
  }
})

test('updating child metadata preserves identity and increments node and tree revisions', async () => {
  let current = new Date('2026-08-14T01:00:00.000Z')
  const fixture = await temporaryStore({ clock: () => current })
  try {
    fixture.store.upsert(taskInput({ id: 'root', title: 'Root' }))
    fixture.store.upsert(taskInput({
      id: 'child', parent_id: 'root', title: 'Initial child', status: 'planned',
    }))
    current = new Date('2026-08-14T02:00:00.000Z')

    const updated = fixture.store.upsert(taskInput({
      id: 'child',
      parent_id: 'root',
      title: 'Renamed child',
      description: 'A clarified deliverable',
      agent_key: 'child-worker',
      sort_order: 4,
      status: 'active',
    })).task

    assert.equal(updated.id, 'child')
    assert.equal(updated.title, 'Renamed child')
    assert.equal(updated.description, 'A clarified deliverable')
    assert.equal(updated.agent_key, 'child-worker')
    assert.equal(updated.sort_order, 4)
    assert.equal(updated.revision, 2)
    assert.equal(fixture.store.show('root').task.revision, 3)
  } finally {
    await fixture.cleanup()
  }
})

test('session-only upsert replay does not change task or tree revisions', async () => {
  let current = new Date('2026-08-14T01:00:00.000Z')
  const fixture = await temporaryStore({ clock: () => current })
  try {
    fixture.store.upsert(taskInput({ id: 'root', title: 'Root' }))
    fixture.store.upsert(taskInput({
      id: 'child', parent_id: 'root', title: 'Child', status: 'active',
    }))
    const beforeChild = fixture.store.show('child').task
    const beforeRoot = fixture.store.show('root').task
    current = new Date('2026-08-14T02:00:00.000Z')

    const replayed = fixture.store.upsert(taskInput({
      id: 'child', parent_id: 'root', title: 'Child', status: 'active',
    }))

    assert.equal(replayed.changed, false)
    assert.equal(replayed.task.revision, beforeChild.revision)
    assert.equal(replayed.task.updated_at, beforeChild.updated_at)
    assert.equal(fixture.store.show('root').task.revision, beforeRoot.revision)
    assert.equal(replayed.session.last_seen_at, '2026-08-14T02:00:00.000Z')
  } finally {
    await fixture.cleanup()
  }
})

test('task activity records creation and each semantic metadata change', async () => {
  let current = new Date('2026-08-14T01:00:00.000Z')
  const fixture = await temporaryStore({ clock: () => current })
  try {
    fixture.store.upsert(taskInput({ id: 'root', title: 'Root' }))
    fixture.store.upsert(taskInput({
      id: 'child', parent_id: 'root', title: 'Initial child', status: 'planned',
    }))
    current = new Date('2026-08-14T02:00:00.000Z')
    fixture.store.upsert(taskInput({
      id: 'child',
      parent_id: 'root',
      title: 'Renamed child',
      description: 'Clarified scope',
      status: 'active',
    }))

    const events = fixture.store.show('child').events
    assert.ok(Array.isArray(events))
    assert.deepEqual(events.map(({ event_type }) => event_type), [
      'created',
      'renamed',
      'description_changed',
      'status_changed',
    ])
    assert.deepEqual(JSON.parse(events[1].before_json), { title: 'Initial child' })
    assert.deepEqual(JSON.parse(events[1].after_json), { title: 'Renamed child' })
    assert.equal(events[1].actor, 'agent')
    assert.equal(events[1].source_session_id, 'session-1')
  } finally {
    await fixture.cleanup()
  }
})

test('child status mutation updates node revision, tree revision, progress, and activity', async () => {
  let current = new Date('2026-08-14T01:00:00.000Z')
  const fixture = await temporaryStore({ clock: () => current })
  try {
    fixture.store.upsert(taskInput({ id: 'root', title: 'Root' }))
    const child = fixture.store.upsert(taskInput({
      id: 'child', parent_id: 'root', title: 'Child', status: 'active',
    })).task
    const rootBefore = fixture.store.show('root').task
    current = new Date('2026-08-14T02:00:00.000Z')

    const changed = fixture.store.updateStatus({
      id: 'child', status: 'done', expected_updated_at: child.updated_at,
    })

    assert.equal(changed.task.revision, 2)
    assert.equal(fixture.store.show('root').task.revision, rootBefore.revision + 1)
    assert.deepEqual(fixture.store.show('root').progress, {
      total: 1, remaining: 0, completed: 1, ratio: 1,
    })
    assert.deepEqual(
      fixture.store.show('child').events.map(({ event_type }) => event_type),
      ['created', 'status_changed'],
    )
  } finally {
    await fixture.cleanup()
  }
})

test('canceled children do not block explicit root completion', async () => {
  const fixture = await temporaryStore()
  try {
    fixture.store.upsert(taskInput({ id: 'root', title: 'Root' }))
    fixture.store.upsert(taskInput({
      id: 'canceled-child', parent_id: 'root', title: 'Canceled child', status: 'canceled',
    }))
    const root = fixture.store.show('root').task

    const completed = fixture.store.updateStatus({
      id: 'root', status: 'done', expected_updated_at: root.updated_at,
    }).task

    assert.equal(completed.status, 'done')
    assert.equal(completed.completed_at, completed.updated_at)
  } finally {
    await fixture.cleanup()
  }
})

test('explicit task update uses revision concurrency and returns no-op for identical metadata', async () => {
  const fixture = await temporaryStore()
  try {
    const root = fixture.store.upsert(taskInput({ id: 'root', title: 'Initial root' })).task
    assert.equal(typeof fixture.store.updateTask, 'function')

    const updated = fixture.store.updateTask({
      id: 'root',
      expected_revision: root.revision,
      patch: { title: 'Renamed root', description: 'Clarified outcome' },
      actor: 'user',
    })
    assert.equal(updated.changed, true)
    assert.equal(updated.task.revision, 2)
    assert.equal(updated.task.title, 'Renamed root')
    assert.equal(updated.task.description, 'Clarified outcome')

    assert.throws(
      () => fixture.store.updateTask({
        id: 'root', expected_revision: 1, patch: { title: 'Stale overwrite' }, actor: 'user',
      }),
      (error) => error.code === 'TASK_VERSION_CONFLICT'
        && error.details.expected_revision === 1
        && error.details.actual_revision === 2,
    )

    const replayed = fixture.store.updateTask({
      id: 'root',
      expected_revision: updated.task.revision,
      patch: { title: 'Renamed root', description: 'Clarified outcome' },
      actor: 'user',
    })
    assert.equal(replayed.changed, false)
    assert.equal(replayed.task.revision, 2)
    assert.deepEqual(
      fixture.store.show('root').events.map(({ event_type }) => event_type),
      ['created', 'renamed', 'description_changed'],
    )
  } finally {
    await fixture.cleanup()
  }
})

test('archive, soft delete, and restore preserve the task with revisioned activity', async () => {
  let current = new Date('2026-08-14T01:00:00.000Z')
  const fixture = await temporaryStore({ clock: () => current })
  try {
    fixture.store.upsert(taskInput({ id: 'root', title: 'Root' }))
    const active = fixture.store.upsert(taskInput({
      id: 'child', parent_id: 'root', title: 'Child', status: 'active',
    })).task
    assert.equal(typeof fixture.store.archiveTask, 'function')
    assert.throws(
      () => fixture.store.archiveTask({ id: 'child', expected_revision: active.revision }),
      (error) => error.code === 'TASK_ARCHIVE_STATUS_INVALID',
    )

    current = new Date('2026-08-14T02:00:00.000Z')
    const done = fixture.store.updateStatus({
      id: 'child', status: 'done', expected_updated_at: active.updated_at,
    }).task
    const archived = fixture.store.archiveTask({
      id: 'child', expected_revision: done.revision, actor: 'user',
    }).task
    assert.equal(archived.archived_at, '2026-08-14T02:00:00.001Z')
    assert.equal(archived.revision, 3)
    assert.equal(fixture.store.show('root').progress.total, 1)

    current = new Date('2026-08-14T03:00:00.000Z')
    const deleted = fixture.store.deleteTask({
      id: 'child', expected_revision: archived.revision, actor: 'user',
    }).task
    assert.equal(deleted.deleted_at, '2026-08-14T03:00:00.000Z')
    assert.equal(fixture.store.list().some(({ id }) => id === 'child'), false)
    assert.equal(fixture.store.list({ deleted: true })[0].id, 'child')
    assert.equal(fixture.store.show('child').task.id, 'child')

    current = new Date('2026-08-14T04:00:00.000Z')
    const restored = fixture.store.restoreTask({
      id: 'child', expected_revision: deleted.revision, actor: 'user',
    }).task
    assert.equal(restored.archived_at, null)
    assert.equal(restored.deleted_at, null)
    assert.equal(fixture.store.list().some(({ id }) => id === 'child'), true)
    assert.deepEqual(
      fixture.store.show('child').events.map(({ event_type }) => event_type),
      ['created', 'status_changed', 'archived', 'deleted', 'restored'],
    )
  } finally {
    await fixture.cleanup()
  }
})

test('legacy complete enforces child gates and records one revisioned status mutation', async () => {
  let current = new Date('2026-08-14T01:00:00.000Z')
  const fixture = await temporaryStore({ clock: () => current })
  try {
    fixture.store.upsert(taskInput({ id: 'root', title: 'Root' }))
    fixture.store.upsert(taskInput({
      id: 'child', parent_id: 'root', title: 'Child', status: 'active',
    }))
    assert.throws(
      () => fixture.store.complete(taskInput({ id: 'root' })),
      (error) => error.code === 'CHILD_TASKS_INCOMPLETE'
        && error.details.child_ids[0] === 'child',
    )

    current = new Date('2026-08-14T02:00:00.000Z')
    const completed = fixture.store.complete(taskInput({ id: 'child' }))
    assert.equal(completed.changed, true)
    assert.equal(completed.task.status, 'done')
    assert.equal(completed.task.revision, 2)
    assert.equal(fixture.store.show('root').task.revision, 3)

    current = new Date('2026-08-14T03:00:00.000Z')
    const replayed = fixture.store.complete(taskInput({ id: 'child' }))
    assert.equal(replayed.changed, false)
    assert.equal(replayed.task.revision, 2)
    assert.equal(replayed.session.last_seen_at, '2026-08-14T03:00:00.000Z')
    assert.deepEqual(
      fixture.store.show('child').events.map(({ event_type }) => event_type),
      ['created', 'status_changed'],
    )
  } finally {
    await fixture.cleanup()
  }
})

test('reopening a done child through task patch also reopens its done root', async () => {
  const fixture = await temporaryStore()
  try {
    fixture.store.upsert(taskInput({ id: 'root', title: 'Root' }))
    const child = fixture.store.upsert(taskInput({
      id: 'child', parent_id: 'root', title: 'Child', status: 'done',
    })).task
    const root = fixture.store.show('root').task
    fixture.store.updateStatus({
      id: 'root', status: 'done', expected_updated_at: root.updated_at,
    })

    const reopened = fixture.store.updateTask({
      id: 'child',
      expected_revision: child.revision,
      patch: { status: 'blocked' },
      actor: 'user',
    })

    assert.equal(reopened.task.status, 'blocked')
    assert.equal(reopened.affected_parent.status, 'active')
    assert.equal(reopened.affected_parent.completed_at, null)
    assert.deepEqual(
      fixture.store.show('root').events.map(({ event_type }) => event_type),
      ['created', 'status_changed', 'status_changed'],
    )
  } finally {
    await fixture.cleanup()
  }
})

test('soft-deleted roots hide descendants without rewriting child lifecycle state', async () => {
  const fixture = await temporaryStore()
  try {
    fixture.store.upsert(taskInput({ id: 'root', title: 'Root' }))
    const child = fixture.store.upsert(taskInput({
      id: 'child', parent_id: 'root', title: 'Child', status: 'planned',
    })).task
    const root = fixture.store.show('root').task

    const deleted = fixture.store.deleteTask({
      id: 'root', expected_revision: root.revision, actor: 'user',
    }).task
    assert.deepEqual(fixture.store.list().map(({ id }) => id), [])
    assert.deepEqual(fixture.store.list({ deleted: true }).map(({ id }) => id), ['root'])
    assert.equal(fixture.store.show('child').task.deleted_at, null)
    assert.equal(fixture.store.show('child').task.revision, child.revision)

    fixture.store.restoreTask({
      id: 'root', expected_revision: deleted.revision, actor: 'user',
    })
    assert.deepEqual(fixture.store.list().map(({ id }) => id), ['root', 'child'])
  } finally {
    await fixture.cleanup()
  }
})
