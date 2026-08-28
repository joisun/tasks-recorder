import assert from 'node:assert/strict'
import { chmod, lstat, mkdir, mkdtemp, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  createRunLogStore,
  createScheduledRunLogs,
} from '../server/src/scheduler/scheduled-run-logs.mjs'

const JOB_ID = '11111111-1111-4111-8111-111111111111'
const RUN_ID = '22222222-2222-4222-8222-222222222222'

function storeFor(run) {
  return { runs: { get: (id) => {
    if (id !== RUN_ID) throw Object.assign(new Error('missing'), { code: 'SCHEDULE_RUN_NOT_FOUND' })
    return { ...run }
  } } }
}

async function fixture(overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'tasks-recorder-scheduled-logs-'))
  const root = join(directory, 'logs')
  const jobDirectory = join(root, JOB_ID)
  const stdout = join(jobDirectory, `${RUN_ID}.stdout.jsonl`)
  const stderr = join(jobDirectory, `${RUN_ID}.stderr.log`)
  await mkdir(jobDirectory, { recursive: true, mode: 0o700 })
  await chmod(root, 0o700)
  await chmod(jobDirectory, 0o700)
  await writeFile(stdout, '0123456789', { mode: 0o600 })
  await writeFile(stderr, 'error tail', { mode: 0o600 })
  await chmod(stdout, 0o600)
  await chmod(stderr, 0o600)
  const run = {
    id: RUN_ID,
    job_id: JOB_ID,
    stdout_log_path: join(JOB_ID, `${RUN_ID}.stdout.jsonl`),
    stderr_log_path: join(JOB_ID, `${RUN_ID}.stderr.log`),
    ...overrides,
  }
  return {
    directory, root, stdout, stderr, run,
    logs: createScheduledRunLogs({ store: storeFor(run), root }),
    cleanup: () => rm(directory, { recursive: true, force: true }),
  }
}

test('reads a bounded tail only from the Run-authoritative registered relative log path', async () => {
  const current = await fixture()
  try {
    const result = await current.logs.read({ runId: RUN_ID, stream: 'stdout', tail: 4 })
    assert.deepEqual(result, {
      run_id: RUN_ID,
      stream: 'stdout',
      content: '6789',
      truncated: true,
    })
    assert.equal(JSON.stringify(result).includes(current.root), false)
  } finally { await current.cleanup() }
})

test('rejects noncanonical registered paths and symlink/replacement log targets without disclosing paths', async () => {
  const traversal = await fixture({ stdout_log_path: '../secret.log' })
  try {
    await assert.rejects(
      traversal.logs.read({ runId: RUN_ID, stream: 'stdout', tail: 32 }),
      { code: 'SCHEDULE_LOG_UNSAFE' },
    )
  } finally { await traversal.cleanup() }

  const symlinked = await fixture()
  try {
    await unlink(symlinked.stdout)
    await symlink(symlinked.stderr, symlinked.stdout)
    await assert.rejects(
      symlinked.logs.read({ runId: RUN_ID, stream: 'stdout', tail: 32 }),
      { code: 'SCHEDULE_LOG_UNSAFE' },
    )
  } finally { await symlinked.cleanup() }
})

test('rejects unknown streams and tails outside the public bounded reader contract', async () => {
  const current = await fixture()
  try {
    await assert.rejects(current.logs.read({ runId: RUN_ID, stream: 'stdout', tail: 0 }), { code: 'SCHEDULE_LOG_QUERY_INVALID' })
    await assert.rejects(current.logs.read({ runId: RUN_ID, stream: 'raw', tail: 8 }), { code: 'SCHEDULE_LOG_QUERY_INVALID' })
    await assert.rejects(current.logs.read({ runId: 'not-a-run', stream: 'stdout', tail: 8 }), { code: 'SCHEDULE_LOG_QUERY_INVALID' })
  } finally { await current.cleanup() }
})

test('taskd-owned log store creates bounded private Run streams', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tasks-recorder-run-log-writer-'))
  const root = join(directory, 'logs')
  try {
    const writerStore = createRunLogStore({ root, maxFileBytes: 8 })
    const writer = await writerStore.open({ scheduleId: JOB_ID, runId: RUN_ID })
    await writer.writeStdout(Buffer.from('0123456789'))
    await writer.writeStderr(Buffer.from('failure-tail'))
    await writer.close()

    const run = {
      id: RUN_ID,
      schedule_id: JOB_ID,
      stdout_log_path: writer.stdout_log_path,
      stderr_log_path: writer.stderr_log_path,
    }
    const reader = createScheduledRunLogs({
      store: { get: () => run },
      root,
    })
    assert.deepEqual(await reader.read({ runId: RUN_ID, stream: 'stdout', tail: 32 }), {
      run_id: RUN_ID,
      stream: 'stdout',
      content: '01234567',
      truncated: false,
    })
    assert.equal((await lstat(writerStore.root)).mode & 0o777, 0o700)
    assert.equal((await lstat(join(root, JOB_ID))).mode & 0o777, 0o700)
    assert.equal((await lstat(join(root, writer.stdout_log_path))).mode & 0o777, 0o600)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
