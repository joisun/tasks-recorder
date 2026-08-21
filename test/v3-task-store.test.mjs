import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import { createSchemaV3 } from '../mcp/src/schema-v3.mjs'
import { createV3TaskStore } from '../mcp/src/v3-task-store.mjs'

function fixture() {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  createSchemaV3(db)
  db.exec(`
    INSERT INTO projects (id, name, created_at, updated_at)
    VALUES
      ('project-a', 'Project A', '2026-08-19T00:00:00.000Z', '2026-08-19T00:00:00.000Z'),
      ('project-b', 'Project B', '2026-08-19T00:00:00.000Z', '2026-08-19T00:00:00.000Z');
  `)
  let now = new Date('2026-08-19T01:00:00.000Z')
  const store = createV3TaskStore({ db, clock: () => now })
  return { db, store, setNow(value) { now = new Date(value) } }
}

test('v3 task create accepts active only as an input alias and stores in_progress', () => {
  const { db, store } = fixture()
  try {
    const created = store.create({
      id: 'main-task',
      project_id: 'project-a',
      title: 'Main task',
      status: 'active',
      planned_start_at: '2026-08-19T00:00:00.000Z',
      next_action: 'Continue',
    })
    assert.equal(created.task.lifecycle, 'in_progress')
    assert.equal('status' in created.task, false)
    assert.equal(created.task.revision, 1)
    assert.equal(store.show('main-task').events[0].event_type, 'created')
  } finally {
    db.close()
  }
})

test('v3 task tree enforces project and depth while revisions stay entity-scoped', () => {
  const { db, store, setNow } = fixture()
  try {
    const root = store.create({
      id: 'main-task', project_id: 'project-a', title: 'Main task', lifecycle: 'in_progress',
    }).task
    const child = store.create({
      id: 'child-task',
      project_id: 'project-a',
      parent_id: 'main-task',
      title: 'Child task',
      lifecycle: 'planned',
    }).task
    assert.equal(root.revision, 1)
    assert.equal(child.revision, 1)
    assert.throws(
      () => store.create({
        id: 'cross-project',
        project_id: 'project-b',
        parent_id: 'main-task',
        title: 'Cross project',
        lifecycle: 'planned',
      }),
      /task parent must belong to the same project/,
    )
    assert.throws(
      () => store.create({
        id: 'grandchild',
        project_id: 'project-a',
        parent_id: 'child-task',
        title: 'Grandchild',
        lifecycle: 'planned',
      }),
      /task hierarchy supports one subtask level/,
    )

    setNow('2026-08-19T02:00:00.000Z')
    const updated = store.update({
      id: 'child-task',
      expected_revision: 1,
      patch: { title: 'Renamed child', lifecycle: 'in_progress' },
    })
    assert.equal(updated.task.revision, 2)
    assert.equal(store.show('main-task').task.revision, 1)
    assert.throws(
      () => store.update({
        id: 'child-task', expected_revision: 1, patch: { title: 'Stale' },
      }),
      (error) => error.code === 'TASK_VERSION_CONFLICT'
        && error.details.current.revision === 2,
    )
  } finally {
    db.close()
  }
})

test('explicit completion preserves child gate and derived progress', () => {
  const { db, store, setNow } = fixture()
  try {
    store.create({
      id: 'main-task', project_id: 'project-a', title: 'Main task', lifecycle: 'in_progress',
    })
    store.create({
      id: 'child-task',
      project_id: 'project-a',
      parent_id: 'main-task',
      title: 'Child task',
      lifecycle: 'in_progress',
    })
    assert.throws(
      () => store.updateLifecycle({
        id: 'main-task', expected_revision: 1, lifecycle: 'done',
      }),
      (error) => error.code === 'CHILD_TASKS_INCOMPLETE'
        && error.details.child_ids[0] === 'child-task',
    )
    setNow('2026-08-19T02:00:00.000Z')
    store.updateLifecycle({
      id: 'child-task', expected_revision: 1, lifecycle: 'done',
    })
    setNow('2026-08-19T03:00:00.000Z')
    const completed = store.updateLifecycle({
      id: 'main-task', expected_revision: 1, lifecycle: 'done',
    })
    assert.equal(completed.task.lifecycle, 'done')
    assert.equal(completed.task.completed_at, '2026-08-19T03:00:00.000Z')
    assert.deepEqual(store.show('main-task').progress, {
      completed: 1,
      total: 1,
      remaining: 0,
      ratio: 1,
    })
  } finally {
    db.close()
  }
})
