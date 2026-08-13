export function createEventStream({
  url,
  createSource = (sourceUrl) => new EventSource(sourceUrl),
  invalidate,
  onConnectionState = () => undefined,
  schedule = setTimeout,
  cancelSchedule = clearTimeout,
  retryMinMs = 1_000,
  retryMaxMs = 30_000,
}) {
  let source = null
  let timer = null
  let retryDelay = retryMinMs
  let started = false
  let stopped = false

  function connect() {
    if (stopped) return
    const current = createSource(url)
    source = current
    current.addEventListener('ready', () => {
      if (source !== current || stopped) return
      retryDelay = retryMinMs
      onConnectionState('connected')
      invalidate()
    })
    current.addEventListener('changed', () => {
      if (source === current && !stopped) invalidate()
    })
    current.onerror = () => {
      if (source !== current || stopped) return
      current.close()
      source = null
      onConnectionState('disconnected')
      const delay = retryDelay
      retryDelay = Math.min(retryMaxMs, retryDelay * 2)
      timer = schedule(() => {
        timer = null
        connect()
      }, delay)
    }
  }

  function start() {
    if (started || stopped) return
    started = true
    connect()
  }

  function stop() {
    if (stopped) return
    stopped = true
    if (timer !== null) cancelSchedule(timer)
    timer = null
    source?.close()
    source = null
  }

  return { start, stop }
}
