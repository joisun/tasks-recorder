import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createStructuredLogger } from '../server/src/structured-logger.mjs'

test('writes allowlisted NDJSON with 0700/0600 permissions and no payload surface', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tasks-recorder-logs-'))
  const directory = join(root, 'logs')
  const logger = createStructuredLogger({
    directory,
    clock: () => new Date('2026-08-20T08:00:00.000Z'),
  })
  try {
    const result = await logger.write('event.accepted', {
      source: 'codex',
      event_type: 'execution.started',
      deduped: false,
      persisted: true,
      observation_id: 'observation-1',
      execution_id: 'execution-1',
      project_resolution: 'resolved',
    })
    assert.equal(result.written, true)
    assert.equal((await stat(directory)).mode & 0o777, 0o700)
    assert.equal((await stat(result.path)).mode & 0o777, 0o600)
    const record = JSON.parse((await readFile(result.path, 'utf8')).trim())
    assert.deepEqual(record, {
      timestamp: '2026-08-20T08:00:00.000Z',
      level: 'info',
      event: 'event.accepted',
      source: 'codex',
      event_type: 'execution.started',
      deduped: false,
      persisted: true,
      observation_id: 'observation-1',
      execution_id: 'execution-1',
      project_resolution: 'resolved',
    })
    assert.equal('payload' in record, false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('rejects unknown event names, privacy fields and non-primitive values before writing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tasks-recorder-logs-'))
  const directory = join(root, 'logs')
  const logger = createStructuredLogger({ directory })
  try {
    await assert.rejects(
      logger.write('event.accepted', { source: 'codex', prompt: 'private' }),
      (error) => error.code === 'LOG_FIELDS_INVALID' && error.fields.includes('prompt'),
    )
    await assert.rejects(
      logger.write('unknown.event', {}),
      (error) => error.code === 'LOG_EVENT_UNSUPPORTED',
    )
    await assert.rejects(
      logger.write('event.rejected', { error_code: { nested: true } }),
      (error) => error.code === 'LOG_FIELDS_INVALID',
    )
    assert.equal(await readdir(root).then((entries) => entries.includes('logs')), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('rotates by size and prunes old files to the retention cap', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tasks-recorder-logs-'))
  const directory = join(root, 'logs')
  let now = Date.parse('2026-08-20T08:00:00.000Z')
  let uuid = 0
  const logger = createStructuredLogger({
    directory,
    maxFileBytes: 260,
    maxFiles: 2,
    maxAgeMs: 60_000,
    clock: () => new Date(now += 1_000),
    uuid: () => `rotation-${uuid += 1}`,
  })
  try {
    for (let index = 0; index < 8; index += 1) {
      await logger.write('event.rejected', {
        source: 'codex',
        event_type: 'execution.started',
        error_code: `EVENT_REJECTED_${index}`,
      })
    }
    const files = (await readdir(directory)).filter((name) => name.endsWith('.ndjson'))
    assert.equal(files.length, 2)
    const status = await logger.status()
    assert.equal(status.files, 2)
    assert.ok(status.bytes > 0)
    assert.equal(status.last_error_code, null)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
