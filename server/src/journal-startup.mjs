import { TaskRecorderError } from '../../mcp/src/errors.mjs'

export async function prepareJournalStartup({
  service,
  spool,
  detectInactiveSessions = async () => [],
  observedAt = new Date().toISOString(),
  staleAfterMs = 30 * 60 * 1000,
} = {}) {
  if (!service || typeof service.recover !== 'function' || typeof service.ingestEvent !== 'function') {
    throw new TypeError('service must provide recover and ingestEvent')
  }
  if (!spool || typeof spool.replay !== 'function') {
    throw new TypeError('spool must provide replay')
  }
  if (typeof detectInactiveSessions !== 'function') {
    throw new TypeError('detectInactiveSessions must be a function')
  }

  let inactiveSessions = []
  let detectorError = null
  try {
    const detected = await detectInactiveSessions()
    if (!Array.isArray(detected)) throw new TypeError('detector result must be an array')
    inactiveSessions = detected
  } catch {
    detectorError = 'INACTIVE_SESSION_DETECTOR_FAILED'
  }

  const recovery = await service.recover({
    observed_at: observedAt,
    stale_after_ms: staleAfterMs,
    inactive_sessions: inactiveSessions,
  })
  const replay = await spool.replay(
    (envelope) => service.ingestEvent(envelope),
    { isPermanentError: (error) => error instanceof TaskRecorderError },
  )
  return {
    recovery,
    replay,
    detector_error: detectorError,
  }
}
