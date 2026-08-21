import { parseEventEnvelope } from '../../mcp/src/event-envelope.mjs'
import { createEventSpool } from './event-spool.mjs'

function loopbackOrigin(value) {
  const url = new URL(value)
  if (
    url.protocol !== 'http:'
    || url.hostname !== '127.0.0.1'
    || url.username !== ''
    || url.password !== ''
    || !['', '/'].includes(url.pathname)
    || url.search !== ''
    || url.hash !== ''
  ) {
    throw new TypeError('tasks-recorder service URL must be an http://127.0.0.1 origin')
  }
  return url.origin
}

export function createJournalEventClient({
  baseUrl,
  spoolDirectory,
  spoolOptions = {},
  fetchImpl = fetch,
  timeoutMs = 1_500,
  createSpool = createEventSpool,
  validateEvent = parseEventEnvelope,
} = {}) {
  const origin = loopbackOrigin(baseUrl)
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function')
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 1_500) {
    throw new TypeError('timeoutMs must be between 1 and 1500')
  }
  const spool = createSpool({
    directory: spoolDirectory,
    validateEvent,
    ...spoolOptions,
  })

  async function queueAfterFailure(envelope, errorCode) {
    try {
      const queued = await spool.queue(envelope)
      return {
        ok: true,
        delivered: false,
        spooled: queued.queued,
        dropped: queued.dropped,
        error_code: queued.queued ? errorCode : 'SPOOL_CAPACITY_EXHAUSTED',
      }
    } catch {
      return {
        ok: true,
        delivered: false,
        spooled: false,
        dropped: true,
        error_code: 'SPOOL_WRITE_FAILED',
      }
    }
  }

  async function deliver(input) {
    let envelope
    try {
      envelope = validateEvent(input)
    } catch (error) {
      return {
        ok: true,
        delivered: false,
        spooled: false,
        dropped: true,
        error_code: error.code ?? 'EVENT_ENVELOPE_INVALID',
      }
    }
    let response
    try {
      response = await fetchImpl(`${origin}/api/v1/events`, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(envelope),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch {
      return queueAfterFailure(envelope, 'TASKD_UNAVAILABLE')
    }
    if (!response.ok) {
      if (response.status >= 500 || response.status === 408 || response.status === 429) {
        return queueAfterFailure(envelope, 'TASKD_UNAVAILABLE')
      }
      return {
        ok: true,
        delivered: false,
        spooled: false,
        dropped: true,
        error_code: 'TASKD_EVENT_REJECTED',
        http_status: response.status,
      }
    }
    const result = await response.json().catch(() => null)
    if (!result || result.ok !== true) {
      return queueAfterFailure(envelope, 'TASKD_PROTOCOL_ERROR')
    }
    return {
      ok: true,
      delivered: true,
      spooled: false,
      dropped: false,
      result,
    }
  }

  return { deliver, spool }
}
