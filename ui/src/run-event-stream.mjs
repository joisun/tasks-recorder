export function createRunEventStream({
  runId,
  baseUrl = '',
  createSource = (url) => new EventSource(url),
  onEvent,
  onReset,
  onState = () => undefined,
  schedule = setTimeout,
  cancelSchedule = clearTimeout,
  retryMs = 1_000,
} = {}) {
  if (typeof runId !== 'string' || runId.length === 0
    || typeof createSource !== 'function' || typeof onEvent !== 'function'
    || typeof onReset !== 'function' || typeof onState !== 'function'
    || typeof schedule !== 'function' || typeof cancelSchedule !== 'function') {
    throw new TypeError('Run event stream options are invalid')
  }

  let source = null
  let retryTimer = null
  let latestSequence = 0
  let stopped = false

  function connect() {
    if (stopped || source) return
    onState('connecting')
    const query = latestSequence > 0 ? `?after=${latestSequence}` : ''
    const current = createSource(
      `${baseUrl}/api/v1/runs/${encodeURIComponent(runId)}/events${query}`,
    )
    source = current
    current.onopen = () => {
      if (source === current && !stopped) onState('connected')
    }
    current.addEventListener('run', (message) => {
      if (source !== current || stopped) return
      let event
      try { event = JSON.parse(message.data) } catch { return }
      const sequence = Number(message.lastEventId || event?.sequence)
      if (event?.runId !== runId || !Number.isSafeInteger(sequence)
        || sequence <= latestSequence || event.sequence !== sequence) return
      latestSequence = sequence
      onEvent(event)
    })
    current.addEventListener('reset', (message) => {
      if (source !== current || stopped) return
      try {
        const payload = JSON.parse(message.data)
        if (payload?.run_id !== runId) return
      } catch { return }
      onReset()
    })
    current.onerror = () => {
      if (source !== current || stopped) return
      current.close()
      source = null
      onState('disconnected')
      retryTimer = schedule(() => {
        retryTimer = null
        connect()
      }, retryMs)
    }
  }

  function close() {
    if (stopped) return
    stopped = true
    if (retryTimer !== null) cancelSchedule(retryTimer)
    retryTimer = null
    source?.close()
    source = null
  }

  return Object.freeze({
    connect,
    close,
    sequence: () => latestSequence,
  })
}
