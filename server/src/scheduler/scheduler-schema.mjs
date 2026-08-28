import { SchedulerError } from './scheduler-errors.mjs'

export const SCHEDULER_SCHEMA_VERSION = 3
export const RUN_SCHEMA_VERSION = 4

export function createRunSchema(db) {
  if (!db || typeof db.exec !== 'function' || typeof db.prepare !== 'function') {
    throw new TypeError('db must be a node:sqlite DatabaseSync')
  }
  db.exec(`
    CREATE TABLE scheduled_runs (
      id TEXT PRIMARY KEY,
      schedule_id TEXT NOT NULL,
      definition_etag TEXT NOT NULL,
      runtime_id TEXT NOT NULL,
      origin TEXT NOT NULL CHECK(origin IN ('manual','scheduled','catchup')),
      occurrence_key TEXT,
      idempotency_key TEXT,
      scheduled_for TEXT,
      status TEXT NOT NULL CHECK(status IN (
        'queued','running','succeeded','failed','timed_out','canceled','interrupted'
      )),
      snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
      runtime_version TEXT,
      executable_digest TEXT,
      pid INTEGER,
      session_id TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      exit_code INTEGER,
      error_code TEXT,
      final_message TEXT,
      usage_json TEXT CHECK(usage_json IS NULL OR json_valid(usage_json)),
      file_changes_json TEXT CHECK(file_changes_json IS NULL OR json_valid(file_changes_json)),
      stdout_log_path TEXT,
      stderr_log_path TEXT,
      reviewed_at TEXT,
      updated_at TEXT NOT NULL,
      CHECK(
        (status IN ('queued', 'running') AND finished_at IS NULL)
        OR (status NOT IN ('queued', 'running') AND finished_at IS NOT NULL)
      )
    ) STRICT;

    CREATE UNIQUE INDEX scheduled_runs_occurrence
      ON scheduled_runs(schedule_id, occurrence_key)
      WHERE occurrence_key IS NOT NULL;
    CREATE UNIQUE INDEX scheduled_runs_idempotency
      ON scheduled_runs(idempotency_key)
      WHERE idempotency_key IS NOT NULL;
    CREATE UNIQUE INDEX scheduled_runs_one_active
      ON scheduled_runs(schedule_id)
      WHERE status IN ('queued', 'running');
    CREATE INDEX scheduled_runs_history
      ON scheduled_runs(schedule_id, created_at DESC, id DESC);
    CREATE INDEX scheduled_runs_review_queue
      ON scheduled_runs(reviewed_at, finished_at DESC, id DESC)
      WHERE status NOT IN ('queued', 'running');

    PRAGMA user_version = ${RUN_SCHEMA_VERSION};
  `)
}

export function createSchedulerSchema(db) {
  if (!db || typeof db.exec !== 'function' || typeof db.prepare !== 'function') {
    throw new TypeError('db must be a node:sqlite DatabaseSync')
  }
  const { user_version: version } = db.prepare('PRAGMA user_version').get()
  if (version !== 0) {
    throw new SchedulerError(
      'SCHEDULE_SCHEMA_VERSION_UNSUPPORTED',
      `schema v${SCHEDULER_SCHEMA_VERSION} requires an empty version-0 database; received version ${version}`,
      { expected: SCHEDULER_SCHEMA_VERSION, actual: version },
    )
  }
  db.exec(`
    CREATE TABLE scheduled_sync_state (
      schedule_id TEXT PRIMARY KEY,
      definition_etag TEXT NOT NULL CHECK(length(definition_etag) = 64),
      generation INTEGER NOT NULL CHECK(generation >= 1),
      sync_state TEXT NOT NULL CHECK(sync_state IN ('pending', 'synced', 'error', 'unsupported')),
      sync_error_code TEXT,
      updated_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE scheduled_dispatches (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      trigger TEXT NOT NULL CHECK(trigger = 'manual'),
      state TEXT NOT NULL CHECK(state IN ('pending', 'consumed', 'canceled')),
      requested_at TEXT NOT NULL,
      consumed_at TEXT,
      run_id TEXT,
      canceled_at TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
      last_attempted_at TEXT,
      last_error_code TEXT,
      created_at TEXT NOT NULL,
      CHECK(
        (state = 'pending' AND consumed_at IS NULL AND run_id IS NULL AND canceled_at IS NULL)
        OR (state = 'consumed' AND consumed_at IS NOT NULL AND run_id IS NOT NULL AND canceled_at IS NULL)
        OR (state = 'canceled' AND consumed_at IS NULL AND run_id IS NULL AND canceled_at IS NOT NULL)
      ),
      CHECK(
        (attempt_count = 0 AND last_attempted_at IS NULL AND last_error_code IS NULL)
        OR (attempt_count > 0 AND last_attempted_at IS NOT NULL)
      )
    ) STRICT;

    CREATE TABLE scheduled_runs (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      dispatch_id TEXT UNIQUE,
      definition_etag TEXT NOT NULL CHECK(length(definition_etag) = 64),
      spec_json TEXT NOT NULL CHECK(json_valid(spec_json)),
      trigger TEXT NOT NULL CHECK(trigger IN ('scheduled', 'manual', 'catchup')),
      scheduled_for TEXT,
      status TEXT NOT NULL CHECK(status IN ('claimed', 'running', 'succeeded', 'failed', 'timed_out', 'canceled', 'skipped_overlap', 'lost')),
      run_nonce_hash TEXT CHECK(run_nonce_hash IS NULL OR length(run_nonce_hash) = 64),
      claimed_at TEXT,
      thread_id TEXT,
      started_at TEXT,
      heartbeat_at TEXT,
      finished_at TEXT,
      exit_code INTEGER,
      error_code TEXT,
      final_message TEXT,
      stdout_log_path TEXT,
      stderr_log_path TEXT,
      file_changes_json TEXT CHECK(file_changes_json IS NULL OR json_valid(file_changes_json)),
      completion_json TEXT CHECK(completion_json IS NULL OR json_valid(completion_json)),
      reviewed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK(
        (status IN ('claimed', 'running') AND finished_at IS NULL)
        OR (status IN ('succeeded', 'failed', 'timed_out', 'canceled', 'skipped_overlap', 'lost') AND finished_at IS NOT NULL)
      ),
      CHECK(
        (status = 'skipped_overlap' AND run_nonce_hash IS NULL)
        OR (status != 'skipped_overlap' AND run_nonce_hash IS NOT NULL)
      ),
      CHECK(
        (status = 'skipped_overlap' AND claimed_at IS NULL)
        OR (status != 'skipped_overlap' AND claimed_at IS NOT NULL)
      ),
      CHECK((trigger = 'manual') = (dispatch_id IS NOT NULL))
    ) STRICT;

    CREATE UNIQUE INDEX scheduled_runs_one_active_per_job
      ON scheduled_runs(job_id)
      WHERE status IN ('claimed', 'running');
    CREATE INDEX scheduled_runs_job_history
      ON scheduled_runs(job_id, created_at DESC, id DESC);
    CREATE INDEX scheduled_runs_review_queue
      ON scheduled_runs(reviewed_at, finished_at DESC, id DESC)
      WHERE status IN ('succeeded', 'failed', 'timed_out', 'canceled', 'skipped_overlap', 'lost');
    CREATE INDEX scheduled_dispatches_pending_oldest
      ON scheduled_dispatches(job_id, requested_at, id)
      WHERE state = 'pending';
    CREATE INDEX scheduled_dispatches_terminal_cleanup
      ON scheduled_dispatches(state, consumed_at, canceled_at, id)
      WHERE state IN ('consumed', 'canceled');

    PRAGMA user_version = ${SCHEDULER_SCHEMA_VERSION};
  `)
}

export function checkSchedulerSchemaInvariants(db) {
  return {
    integrityCheck: db.prepare('PRAGMA integrity_check').get().integrity_check,
    foreignKeyViolations: db.prepare('PRAGMA foreign_key_check').all(),
    invariantViolations: [
      ...db.prepare(`
        SELECT 'SCHEDULE_RUN_MANUAL_DISPATCH_INVALID' AS code, run.id AS entity_id
        FROM scheduled_runs run
        LEFT JOIN scheduled_dispatches dispatch ON dispatch.id = run.dispatch_id
        WHERE (run.trigger = 'manual' AND (dispatch.id IS NULL OR dispatch.state != 'consumed' OR dispatch.run_id != run.id))
           OR (run.trigger != 'manual' AND run.dispatch_id IS NOT NULL)
      `).all(),
      ...db.prepare(`
        SELECT 'SCHEDULE_DISPATCH_CONSUMED_RUN_INVALID' AS code, dispatch.id AS entity_id
        FROM scheduled_dispatches dispatch
        LEFT JOIN scheduled_runs run ON run.id = dispatch.run_id
        WHERE dispatch.state = 'consumed'
          AND (run.id IS NULL OR run.dispatch_id != dispatch.id OR run.trigger != 'manual')
      `).all(),
    ],
  }
}
