import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'

import { createRevisionHub } from '../server/src/revision-hub.mjs'

function subscriber() {
  const request = new EventEmitter()
  const response = {
    chunks: [],
    ended: false,
    headers: null,
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
    },
    write(chunk) {
      this.chunks.push(String(chunk))
      return true
    },
    end() {
      this.ended = true
    },
  }
  return { request, response }
}

test('SSE subscribers receive ready then committed revisions and detach on close', () => {
  const hub = createRevisionHub({ instanceId: 'instance-a', keepaliveMs: 60_000 })
  const first = subscriber()
  const second = subscriber()

  hub.subscribe(first.request, first.response)
  hub.subscribe(second.request, second.response)

  assert.equal(first.response.status, 200)
  assert.equal(first.response.headers['Content-Type'], 'text/event-stream; charset=utf-8')
  assert.match(first.response.chunks.join(''), /event: ready\ndata: {"server_instance_id":"instance-a","revision":0}/)

  assert.deepEqual(hub.publish(), { server_instance_id: 'instance-a', revision: 1 })
  assert.match(first.response.chunks.join(''), /event: changed\ndata: {"server_instance_id":"instance-a","revision":1}/)
  assert.match(second.response.chunks.join(''), /event: changed\ndata: {"server_instance_id":"instance-a","revision":1}/)

  const detachedLength = first.response.chunks.length
  first.request.emit('close')
  hub.publish()
  assert.equal(first.response.chunks.length, detachedLength)
  assert.match(second.response.chunks.join(''), /"revision":2/)

  hub.close()
  assert.equal(second.response.ended, true)
})

test('SSE keepalive is a comment and does not change the business revision', async () => {
  const hub = createRevisionHub({ instanceId: 'instance-b', keepaliveMs: 5 })
  const client = subscriber()
  hub.subscribe(client.request, client.response)

  await new Promise((resolve) => setTimeout(resolve, 12))

  assert.match(client.response.chunks.join(''), /: keepalive/)
  assert.deepEqual(hub.current(), { server_instance_id: 'instance-b', revision: 0 })
  hub.close()
})
