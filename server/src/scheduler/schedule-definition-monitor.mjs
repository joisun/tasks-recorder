import { watch } from 'node:fs'

function invalidKey(values) {
  return JSON.stringify(values.map(({ source_path: path, error_code: code, message }) => [path, code, message]))
}

export function createScheduleDefinitionMonitor({
  repository,
  onDiff = () => undefined,
  watchFactory = watch,
  schedule = setTimeout,
  clearSchedule = clearTimeout,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
  debounceMs = 300,
  rescanMs = 30_000,
} = {}) {
  if (!repository?.scan || typeof repository.rootDirectory !== 'string') throw new TypeError('repository is required')
  if (typeof onDiff !== 'function') throw new TypeError('onDiff must be a function')
  let previous = new Map()
  let previousInvalid = '[]'
  let watcher = null
  let interval = null
  let timer = null
  let closed = false
  let chain = Promise.resolve()

  function refresh({ emit = true } = {}) {
    const operation = chain.then(async () => {
      if (closed) return null
      const scanned = await repository.scan()
      const current = new Map(scanned.jobs.map((job) => [job.id, job]))
      const added = []
      const changed = []
      const removed = []
      for (const [id, job] of current) {
        const prior = previous.get(id)
        if (!prior) added.push(job)
        else if (prior.etag !== job.etag || prior.source_path !== job.source_path) changed.push(job)
      }
      for (const [id, job] of previous) if (!current.has(id)) removed.push(job)
      const currentInvalid = invalidKey(scanned.invalid)
      const invalidChanged = currentInvalid !== previousInvalid
      previous = current
      previousInvalid = currentInvalid
      if (!emit || closed) return null
      if (added.length === 0 && changed.length === 0 && removed.length === 0 && !invalidChanged) return null
      const diff = { added, changed, removed, invalid: scanned.invalid }
      await onDiff(diff)
      return diff
    })
    chain = operation.catch(() => {})
    return operation
  }

  function enqueue() {
    if (closed) return
    if (timer !== null) clearSchedule(timer)
    timer = schedule(() => {
      timer = null
      void refresh()
    }, debounceMs)
  }

  async function start({ emitInitial = true } = {}) {
    if (closed) throw new Error('Schedule definition monitor is closed')
    await refresh({ emit: emitInitial })
    watcher = watchFactory(repository.rootDirectory, { recursive: true }, enqueue)
    watcher.on?.('error', enqueue)
    interval = setIntervalImpl(() => refresh(), rescanMs)
  }

  async function close() {
    if (closed) return
    closed = true
    if (timer !== null) clearSchedule(timer)
    if (interval !== null) clearIntervalImpl(interval)
    await watcher?.close?.()
    await chain
  }

  return { start, refresh, settled: () => chain, close }
}
