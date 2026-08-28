const EVENT_TYPES = new Set([
  'status',
  'thinking',
  'text_delta',
  'tool_start',
  'tool_result',
  'file_change',
  'usage',
  'session',
  'error',
  'done',
  'turn_started',
  'assistant_delta',
  'activity_started',
  'activity_completed',
  'usage_updated',
  'intervention_accepted',
])

const DEFAULT_MAXIMUM_PAYLOAD_BYTES = 64 * 1024

export function runtimeEvent({
  runId,
  sequence,
  observedAt,
  type,
  payload,
}, { maximumPayloadBytes = DEFAULT_MAXIMUM_PAYLOAD_BYTES } = {}) {
  if (typeof runId !== 'string' || runId.length === 0 || runId.length > 128) {
    throw new TypeError('runId is invalid')
  }
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new TypeError('sequence is invalid')
  }
  if (typeof observedAt !== 'string' || !Number.isFinite(Date.parse(observedAt))) {
    throw new TypeError('observedAt is invalid')
  }
  if (!EVENT_TYPES.has(type)) throw new TypeError(`Unknown runtime event type: ${type}`)
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new TypeError('payload must be an object')
  }

  const serialized = JSON.stringify(payload)
  if (Buffer.byteLength(serialized) > maximumPayloadBytes) {
    throw new TypeError('runtime event payload is too large')
  }

  return Object.freeze({
    runId,
    sequence,
    observedAt,
    type,
    payload: deepFreeze(JSON.parse(serialized)),
  })
}

function deepFreeze(value) {
  Object.freeze(value)
  for (const nested of Object.values(value)) {
    if (nested && typeof nested === 'object' && !Object.isFrozen(nested)) {
      deepFreeze(nested)
    }
  }
  return value
}
