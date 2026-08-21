function nowIso(clock) {
  const value = clock()
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.valueOf())) throw new TypeError('clock must return a valid date')
  return date.toISOString()
}

export function createJournalDiagnostics({
  store,
  spool,
  logger = null,
  clock = () => new Date(),
  staleAfterMs = 30 * 60 * 1000,
} = {}) {
  if (!store || typeof store.check !== 'function' || typeof store.snapshot !== 'function') {
    throw new TypeError('store must provide check and snapshot')
  }
  if (!spool || typeof spool.status !== 'function') {
    throw new TypeError('spool must provide status')
  }
  if (logger !== null && typeof logger.status !== 'function') {
    throw new TypeError('logger must provide status')
  }
  if (!Number.isFinite(staleAfterMs) || staleAfterMs < 0) {
    throw new TypeError('staleAfterMs must be a non-negative number')
  }

  const ingest = {
    accepted: 0,
    deduped: 0,
    rejected: 0,
    last_event_at: null,
    last_error_code: null,
  }
  const recovery = {
    recovered: 0,
    stale: 0,
    last_run_at: null,
    last_error_code: null,
  }

  function recordIngest(result) {
    const timestamp = nowIso(clock)
    ingest.last_event_at = timestamp
    if (result?.accepted === false) {
      ingest.rejected += 1
      ingest.last_error_code = result.error_code ?? 'EVENT_REJECTED'
      return
    }
    ingest.accepted += 1
    if (result?.deduped) ingest.deduped += 1
  }

  function recordRecovery(result) {
    recovery.last_run_at = nowIso(clock)
    recovery.recovered += result?.recovered_count ?? 0
    recovery.stale = result?.stale_count ?? 0
    if (result?.error_code) recovery.last_error_code = result.error_code
  }

  async function status() {
    let check
    try {
      check = store.check()
    } catch {
      check = {
        schemaVersion: null,
        integrityCheck: 'error',
        foreignKeyViolations: [],
        invariantViolations: [],
      }
    }
    const writable = typeof store.probeWritable === 'function' ? store.probeWritable() : false
    const spoolStatus = await spool.status()
    const loggerStatus = logger ? await logger.status() : null
    let snapshot = { executions: [] }
    try {
      snapshot = store.snapshot()
    } catch {
      snapshot = { executions: [] }
    }
    const now = Date.parse(nowIso(clock))
    const open = snapshot.executions.filter(({ ended_at }) => ended_at === null)
    const stale = open.filter(({ last_seen_at }) => (
      now - Date.parse(last_seen_at) >= staleAfterMs
    ))
    const ready = writable
      && check.integrityCheck === 'ok'
      && check.foreignKeyViolations.length === 0
      && (check.invariantViolations?.length ?? 0) === 0
    const degraded = !ready
      || spoolStatus.backlog_files > 0
      || spoolStatus.last_replay_error != null
      || stale.length > 0
      || recovery.last_error_code !== null
      || loggerStatus?.last_error_code != null
    return {
      ok: true,
      service: 'tasks-recorder',
      live: true,
      ready,
      degraded,
      schema_version: check.schemaVersion,
      database: {
        writable,
        integrity_check: check.integrityCheck,
        foreign_key_violations: check.foreignKeyViolations.length,
        invariant_violations: check.invariantViolations?.length ?? 0,
      },
      spool: spoolStatus,
      ingest: { ...ingest },
      recovery: { ...recovery },
      executions: { open: open.length, stale: stale.length },
      ...(loggerStatus ? { logs: loggerStatus } : {}),
    }
  }

  return { recordIngest, recordRecovery, status }
}
