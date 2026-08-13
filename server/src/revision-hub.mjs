import { randomUUID } from 'node:crypto'

function sseEvent(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

export function createRevisionHub({
  instanceId = randomUUID(),
  keepaliveMs = 15_000,
} = {}) {
  let revision = 0
  let closed = false
  const clients = new Set()

  function current() {
    return { server_instance_id: instanceId, revision }
  }

  function broadcast(event, data) {
    const message = sseEvent(event, data)
    for (const response of clients) response.write(message)
  }

  function subscribe(request, response) {
    if (closed) throw new Error('revision hub is closed')
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    clients.add(response)
    response.write('retry: 1000\n\n')
    response.write(sseEvent('ready', current()))
    request.once('close', () => clients.delete(response))
  }

  function publish() {
    revision += 1
    const state = current()
    broadcast('changed', state)
    return state
  }

  const keepalive = setInterval(() => {
    for (const response of clients) response.write(': keepalive\n\n')
  }, keepaliveMs)
  keepalive.unref?.()

  function close() {
    if (closed) return
    closed = true
    clearInterval(keepalive)
    for (const response of clients) response.end()
    clients.clear()
  }

  return { current, subscribe, publish, close }
}
