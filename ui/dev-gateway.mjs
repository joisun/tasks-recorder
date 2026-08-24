import { createServer, request as createUpstreamRequest } from 'node:http'

const LOOPBACK = '127.0.0.1'
const DEV_RELOAD_PATH = '/__tasks_recorder_dev/reload'
const HTML_CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self' data:; frame-ancestors 'none'"
const hopByHopHeaders = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

function portValue(value, field) {
  const port = Number(value)
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${field} must be an integer from 1 to 65535`)
  }
  return port
}

export function resolveDashboardDevConfig({ env = process.env } = {}) {
  const port = portValue(env.TASKS_RECORDER_DEV_PORT ?? 43128, 'TASKS_RECORDER_DEV_PORT')
  const upstream = new URL(env.TASKS_RECORDER_DEV_UPSTREAM ?? 'http://127.0.0.1:43127')
  if (upstream.protocol !== 'http:' || upstream.hostname !== LOOPBACK) {
    throw new Error('TASKS_RECORDER_DEV_UPSTREAM must be an HTTP loopback URL')
  }
  if (
    upstream.username
    || upstream.password
    || !['', '/'].includes(upstream.pathname)
    || upstream.search
    || upstream.hash
  ) {
    throw new Error(
      'TASKS_RECORDER_DEV_UPSTREAM must not contain credentials, path, query, or hash',
    )
  }
  const upstreamPort = portValue(upstream.port || 80, 'TASKS_RECORDER_DEV_UPSTREAM port')
  if (port === upstreamPort) throw new Error('dev port must differ from upstream port')
  return { host: LOOPBACK, port, upstream }
}

const reloadClient = `<script data-tasks-recorder-dev-reload>
(() => {
  const source = new EventSource('${DEV_RELOAD_PATH}')
  source.addEventListener('reload', () => globalThis.location.reload())
})()
</script>`

export function injectDashboardReloadClient(html) {
  if (html.includes('data-tasks-recorder-dev-reload')) return html
  if (!html.includes('</body>')) throw new Error('Dashboard HTML is missing </body>')
  return html.replace('</body>', `${reloadClient}\n</body>`)
}

function sendJson(response, statusCode, body) {
  if (response.headersSent || response.destroyed) return
  const source = JSON.stringify(body)
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(source),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  response.end(source)
}

function sendBoundaryError(response, code, message) {
  sendJson(response, 403, { ok: false, error: { code, message } })
}

function connectionHeaderNames(headers) {
  return new Set(String(headers.connection ?? '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean))
}

function proxyHeaders(headers, upstream) {
  const connectionHeaders = connectionHeaderNames(headers)
  const result = {}
  for (const [name, value] of Object.entries(headers)) {
    const normalized = name.toLowerCase()
    if (hopByHopHeaders.has(normalized) || connectionHeaders.has(normalized)) continue
    result[normalized] = value
  }
  result.host = upstream.host
  if (headers.origin !== undefined) result.origin = upstream.origin
  return result
}

function responseHeaders(headers) {
  const connectionHeaders = connectionHeaderNames(headers)
  return Object.fromEntries(Object.entries(headers).filter(([name, value]) => (
    value !== undefined
    && !hopByHopHeaders.has(name.toLowerCase())
    && !connectionHeaders.has(name.toLowerCase())
  )))
}

export function createDashboardDevGateway({ host, port, upstream, getHtml } = {}) {
  if (host !== LOOPBACK) throw new Error('Dashboard dev gateway host must be 127.0.0.1')
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
    throw new Error('Dashboard dev gateway port must be an integer from 0 to 65535')
  }
  if (!(upstream instanceof URL) || upstream.protocol !== 'http:' || upstream.hostname !== LOOPBACK) {
    throw new Error('Dashboard dev gateway upstream must be an HTTP loopback URL')
  }
  if (typeof getHtml !== 'function') throw new TypeError('getHtml must be a function')

  let expectedHost = `${host}:${port}`
  let devOrigin = `http://${expectedHost}`
  let listening = false
  let closing = false
  const reloadResponses = new Set()
  const upstreamRequests = new Set()
  const sockets = new Set()

  function attachReloadClient(request, response) {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Content-Type-Options': 'nosniff',
    })
    response.write('retry: 1000\nevent: ready\ndata: {}\n\n')
    reloadResponses.add(response)
    const remove = () => reloadResponses.delete(response)
    request.once('close', remove)
    response.once('close', remove)
  }

  function proxy(request, response) {
    const upstreamRequest = createUpstreamRequest({
      protocol: upstream.protocol,
      hostname: upstream.hostname,
      port: upstream.port || 80,
      method: request.method,
      path: request.url,
      headers: proxyHeaders(request.headers, upstream),
    }, (upstreamResponse) => {
      if (response.destroyed) {
        upstreamResponse.destroy()
        return
      }
      response.writeHead(
        upstreamResponse.statusCode ?? 502,
        responseHeaders(upstreamResponse.headers),
      )
      upstreamResponse.pipe(response)
    })
    upstreamRequests.add(upstreamRequest)
    upstreamRequest.once('close', () => upstreamRequests.delete(upstreamRequest))
    upstreamRequest.once('error', () => {
      upstreamRequests.delete(upstreamRequest)
      if (response.headersSent) response.destroy()
      else {
        sendJson(response, 502, {
          ok: false,
          error: {
            code: 'DEV_UPSTREAM_UNAVAILABLE',
            message: 'Tasks Recorder upstream is unavailable',
          },
        })
      }
    })
    request.once('aborted', () => upstreamRequest.destroy())
    request.pipe(upstreamRequest)
  }

  const server = createServer((request, response) => {
    if (request.headers.host !== expectedHost) {
      sendBoundaryError(response, 'HOST_REJECTED', 'request host is not allowed')
      return
    }
    if (request.headers.origin && request.headers.origin !== devOrigin) {
      sendBoundaryError(response, 'ORIGIN_REJECTED', 'request origin is not allowed')
      return
    }

    const url = new URL(request.url, devOrigin)
    if (request.method === 'GET' && ['/', '/index.html'].includes(url.pathname)) {
      try {
        const html = injectDashboardReloadClient(getHtml())
        response.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Length': Buffer.byteLength(html),
          'Cache-Control': 'no-cache',
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': HTML_CSP,
        })
        response.end(html)
      } catch {
        sendJson(response, 500, {
          ok: false,
          error: {
            code: 'DEV_DASHBOARD_UNAVAILABLE',
            message: 'Dashboard source build is unavailable',
          },
        })
      }
      return
    }
    if (request.method === 'GET' && url.pathname === '/favicon.ico') {
      response.writeHead(204, { 'Cache-Control': 'no-store' })
      response.end()
      return
    }
    if (request.method === 'GET' && url.pathname === DEV_RELOAD_PATH) {
      attachReloadClient(request, response)
      return
    }
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/health/')) {
      proxy(request, response)
      return
    }
    sendJson(response, 404, {
      ok: false,
      error: { code: 'NOT_FOUND', message: 'route not found' },
    })
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })

  return {
    async listen() {
      if (listening) throw new Error('Dashboard dev gateway is already listening')
      await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, host, resolve)
      })
      listening = true
      const address = server.address()
      expectedHost = `${host}:${address.port}`
      devOrigin = `http://${expectedHost}`
      return { host, port: address.port, url: devOrigin }
    },
    broadcastReload() {
      for (const response of reloadResponses) {
        if (!response.destroyed) response.write('event: reload\ndata: {}\n\n')
      }
    },
    async close() {
      if (closing) return
      closing = true
      for (const response of reloadResponses) response.end()
      reloadResponses.clear()
      for (const request of upstreamRequests) request.destroy()
      upstreamRequests.clear()
      for (const socket of sockets) socket.destroy()
      sockets.clear()
      if (!listening) return
      await new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve())
      })
      listening = false
    },
  }
}
