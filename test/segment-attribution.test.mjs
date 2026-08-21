import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import { createSchemaV3 } from '../mcp/src/schema-v3.mjs'
import { createWorkStore } from '../mcp/src/work-store.mjs'

function fixture() {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  createSchemaV3(db)
  db.exec(`
    INSERT INTO projects (id, name, created_at, updated_at)
    VALUES ('project-a', 'Project A', '2026-08-19T00:00:00.000Z', '2026-08-19T00:00:00.000Z');
    INSERT INTO tasks (id, project_id, title, lifecycle, created_at, updated_at)
    VALUES
      ('task-a', 'project-a', 'Task A', 'in_progress',
       '2026-08-19T00:00:00.000Z', '2026-08-19T00:00:00.000Z'),
      ('task-b', 'project-a', 'Task B', 'in_progress',
       '2026-08-19T00:00:00.000Z', '2026-08-19T00:00:00.000Z');
  `)
  const store = createWorkStore({ db })
  store.startExecution({
    id: 'execution-1',
    source: 'codex',
    source_session_key: 'session-1',
    root_session_key: 'session-1',
    project_id: 'project-a',
    source_turn_key: 'turn-1',
    kind: 'main',
    started_at: '2026-08-19T01:00:00.000Z',
  })
  const focused = store.focus({
    execution_id: 'execution-1',
    task_id: 'task-a',
    provenance: 'agent_explicit',
    rationale_code: 'selected_task',
    observed_at: '2026-08-19T01:00:00.000Z',
  })
  return { db, store, segmentId: focused.segment.id }
}

test('user correction supersedes attribution with an auditable accepted row', () => {
  const { db, store, segmentId } = fixture()
  try {
    const corrected = store.correctAttribution({
      segment_id: segmentId,
      task_id: 'task-b',
      provenance: 'user',
      rationale_code: 'dashboard_correction',
      observed_at: '2026-08-19T02:00:00.000Z',
    })
    assert.equal(corrected.changed, true)
    assert.equal(corrected.attribution.task_id, 'task-b')
    assert.equal(corrected.attribution.provenance, 'user')
    assert.deepEqual(store.listAttributions({ segment_id: segmentId }).map((item) => ({
      task_id: item.task_id,
      provenance: item.provenance,
      accepted_at: item.accepted_at,
      superseded_at: item.superseded_at,
    })), [
      {
        task_id: 'task-a',
        provenance: 'agent_explicit',
        accepted_at: '2026-08-19T01:00:00.000Z',
        superseded_at: '2026-08-19T02:00:00.000Z',
      },
      {
        task_id: 'task-b',
        provenance: 'user',
        accepted_at: '2026-08-19T02:00:00.000Z',
        superseded_at: null,
      },
    ])
  } finally {
    db.close()
  }
})

test('current-focus heartbeat cannot overwrite a user correction', () => {
  const { db, store, segmentId } = fixture()
  try {
    store.correctAttribution({
      segment_id: segmentId,
      task_id: 'task-b',
      provenance: 'user',
      rationale_code: 'dashboard_correction',
      observed_at: '2026-08-19T02:00:00.000Z',
    })
    const heartbeat = store.focus({
      execution_id: 'execution-1',
      task_id: 'task-a',
      provenance: 'current_focus',
      rationale_code: 'heartbeat',
      observed_at: '2026-08-19T03:00:00.000Z',
    })
    assert.equal(heartbeat.changed, false)
    assert.equal(heartbeat.reason, 'user_attribution_protected')
    assert.equal(store.listSegments({ execution_id: 'execution-1' })[0].task_id, 'task-b')
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM work_segments').get().count, 1)
  } finally {
    db.close()
  }
})

test('suggestion provenance cannot create an accepted attribution', () => {
  const { db, store, segmentId } = fixture()
  try {
    assert.throws(
      () => store.correctAttribution({
        segment_id: segmentId,
        task_id: 'task-b',
        provenance: 'suggestion',
        rationale_code: 'title_similarity',
        observed_at: '2026-08-19T02:00:00.000Z',
      }),
      (error) => error.code === 'ATTRIBUTION_PROVENANCE_UNACCEPTED',
    )
  } finally {
    db.close()
  }
})
