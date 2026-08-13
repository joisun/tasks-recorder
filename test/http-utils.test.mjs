import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import test from 'node:test'

import { readJson, sendJson } from '../server/src/http-utils.mjs'

test('readJson parses a bounded UTF-8 request body', async () => {
  const request = Readable.from([Buffer.from('{"task":'), Buffer.from('"ok"}')])

  assert.deepEqual(await readJson(request, { limit: 32 }), { task: 'ok' })
})

test('readJson rejects malformed and oversized payloads with stable HTTP errors', async () => {
  await assert.rejects(
    readJson(Readable.from(['{']), { limit: 32 }),
    (error) => error.code === 'JSON_INVALID' && error.statusCode === 400,
  )
  await assert.rejects(
    readJson(Readable.from(['{"value":"123456"}']), { limit: 8 }),
    (error) => error.code === 'REQUEST_BODY_TOO_LARGE' && error.statusCode === 413,
  )
})

test('sendJson writes a no-store JSON response', () => {
  const response = {
    body: '',
    writeHead(status, headers) { this.status = status; this.headers = headers },
    end(body) { this.body = body },
  }

  sendJson(response, 201, { ok: true })

  assert.equal(response.status, 201)
  assert.equal(response.headers['Content-Type'], 'application/json; charset=utf-8')
  assert.equal(response.headers['Cache-Control'], 'no-store')
  assert.equal(response.body, '{"ok":true}')
})
