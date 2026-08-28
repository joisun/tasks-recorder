const DEFAULT_MAXIMUM_EVENTS = 256

export function createRunEventHub({
  maximumEventsPerRun = DEFAULT_MAXIMUM_EVENTS,
  retentionMs = 30_000,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  if (!Number.isSafeInteger(maximumEventsPerRun)
    || maximumEventsPerRun < 1
    || maximumEventsPerRun > 4_096) {
    throw new TypeError('maximumEventsPerRun is invalid')
  }
  if (!Number.isSafeInteger(retentionMs) || retentionMs < 1
    || typeof setTimer !== 'function' || typeof clearTimer !== 'function') {
    throw new TypeError('event retention options are invalid')
  }

  const buffers = new Map()
  const subscribers = new Map()
  let closed = false

  function publish(event) {
    assertOpen()
    validateEvent(event)
    let record = buffers.get(event.runId)
    if (!record) {
      record = { events: [], terminal: false, evictionTimer: null }
      buffers.set(event.runId, record)
    }
    const previous = record.events.at(-1)
    if (previous && event.sequence <= previous.sequence) {
      throw new TypeError('Run event sequence must be strictly increasing')
    }
    record.events.push(event)
    if (record.events.length > maximumEventsPerRun) record.events.shift()
    if (isTerminal(event)) record.terminal = true

    for (const listener of subscribers.get(event.runId) ?? []) listener(event)
    scheduleEviction(event.runId, record)
  }

  function subscribe(runId, listener, { afterSequence = 0 } = {}) {
    assertOpen()
    if (typeof runId !== 'string' || runId.length === 0) {
      throw new TypeError('runId is required')
    }
    if (typeof listener !== 'function') throw new TypeError('listener is required')
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
      throw new TypeError('afterSequence is invalid')
    }

    const record = buffers.get(runId)
    if (record?.evictionTimer) {
      clearTimer(record.evictionTimer)
      record.evictionTimer = null
    }

    let listeners = subscribers.get(runId)
    if (!listeners) {
      listeners = new Set()
      subscribers.set(runId, listeners)
    }
    listeners.add(listener)
    for (const event of record?.events ?? []) {
      if (event.sequence > afterSequence) listener(event)
    }

    let subscribed = true
    return () => {
      if (!subscribed) return
      subscribed = false
      listeners.delete(listener)
      if (listeners.size === 0) subscribers.delete(runId)
      const current = buffers.get(runId)
      if (current) scheduleEviction(runId, current)
    }
  }

  function replayState(runId, afterSequence = 0) {
    assertOpen()
    if (typeof runId !== 'string' || runId.length === 0
      || !Number.isSafeInteger(afterSequence) || afterSequence < 0) {
      throw new TypeError('replay state input is invalid')
    }
    const firstSequence = buffers.get(runId)?.events?.[0]?.sequence ?? null
    return Object.freeze({
      reset_required: afterSequence > 0
        && (firstSequence === null || firstSequence > afterSequence + 1),
    })
  }

  function close() {
    if (closed) return
    closed = true
    for (const record of buffers.values()) clearTimer(record.evictionTimer)
    buffers.clear()
    subscribers.clear()
  }

  function assertOpen() {
    if (closed) throw new Error('Run event hub is closed')
  }

  function scheduleEviction(runId, record) {
    if (!record.terminal || record.evictionTimer
      || (subscribers.get(runId)?.size ?? 0) > 0) return
    record.evictionTimer = setTimer(() => {
      record.evictionTimer = null
      if ((subscribers.get(runId)?.size ?? 0) === 0 && record.terminal) {
        buffers.delete(runId)
      }
    }, retentionMs)
    record.evictionTimer?.unref?.()
  }

  return Object.freeze({ publish, subscribe, replayState, close })
}

function isTerminal(event) {
  if (event.type === 'done') return true
  return event.type === 'status'
    && ['succeeded', 'failed', 'timed_out', 'canceled', 'interrupted']
      .includes(event.payload?.state)
}

function validateEvent(event) {
  if (!event || typeof event !== 'object'
    || typeof event.runId !== 'string' || event.runId.length === 0
    || !Number.isSafeInteger(event.sequence) || event.sequence < 1) {
    throw new TypeError('event is invalid')
  }
}
