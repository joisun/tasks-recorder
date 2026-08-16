function requestError(code, message, statusCode) {
  const error = new Error(message)
  error.code = code
  error.statusCode = statusCode
  return error
}

export async function readJson(request, { limit = 64 * 1024 } = {}) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.byteLength
    if (size > limit) {
      throw requestError('REQUEST_BODY_TOO_LARGE', `request body exceeds ${limit} bytes`, 413)
    }
    chunks.push(buffer)
  }

  try {
    const source = Buffer.concat(chunks).toString('utf8')
    return source === '' ? {} : JSON.parse(source)
  } catch {
    throw requestError('JSON_INVALID', 'request body must be valid JSON', 400)
  }
}

export function sendJson(response, statusCode, body) {
  const json = JSON.stringify(body)
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(json),
    'Cache-Control': 'no-store',
  })
  response.end(json)
}

export function sendError(response, error) {
  const statusCode = error.statusCode ?? 500
  const code = error.code ?? 'INTERNAL_ERROR'
  sendJson(response, statusCode, {
    ok: false,
    error: { code, message: statusCode >= 500 ? 'internal server error' : error.message },
  })
}
