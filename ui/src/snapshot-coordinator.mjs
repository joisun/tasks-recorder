export function createSnapshotCoordinator({
  load,
  render,
  onStatus = () => undefined,
}) {
  let pending = false
  let running = null
  let rendered = false
  let stopped = false

  async function drain() {
    while (pending && !stopped) {
      pending = false
      try {
        const snapshot = await load()
        if (stopped) return
        render(snapshot, { initial: !rendered })
        rendered = true
        onStatus({ state: 'fresh' })
      } catch (error) {
        if (!stopped) onStatus({ state: rendered ? 'stale' : 'unavailable', error })
      }
    }
  }

  function invalidate() {
    if (stopped) return Promise.resolve()
    pending = true
    if (!running) {
      running = drain().finally(() => { running = null })
    }
    return running
  }

  function stop() {
    stopped = true
    pending = false
  }

  return { invalidate, stop }
}
