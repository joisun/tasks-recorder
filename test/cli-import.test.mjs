import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import { createTaskStore } from '../mcp/src/task-store.mjs'
import { parseCliArguments, runCli, runCliMain } from '../server/cli.mjs'
import { taskInput } from './helpers.mjs'

test('CLI parses service defaults and the complete Codex import argument set', () => {
  assert.deepEqual(parseCliArguments([]), { type: 'control', command: 'status' })
  assert.deepEqual(parseCliArguments(['start']), { type: 'control', command: 'start' })
  assert.deepEqual(parseCliArguments(['scheduler', 'status']), { type: 'scheduler', command: 'status' })
  assert.deepEqual(parseCliArguments(['scheduler', 'reconcile']), { type: 'scheduler', command: 'reconcile' })
  assert.deepEqual(parseCliArguments([
    'import', 'codex', '--session', 'root-session', '--dry-run', '--codex-home', '/tmp/codex',
  ]), {
    type: 'import-codex',
    session_id: 'root-session',
    dry_run: true,
    codex_home: '/tmp/codex',
  })
  assert.deepEqual(parseCliArguments([
    'migrate', '--dry-run', '--database', '/tmp/tasks.sqlite',
  ]), {
    type: 'migrate',
    mode: 'dry-run',
    database_path: '/tmp/tasks.sqlite',
  })
  assert.deepEqual(parseCliArguments([
    'migrate', '--apply', '--backup', '/tmp/tasks.v2.backup.sqlite',
  ]), {
    type: 'migrate',
    mode: 'apply',
    backup_path: '/tmp/tasks.v2.backup.sqlite',
  })
  assert.throws(
    () => parseCliArguments(['import', 'codex', '--session']),
    /--session requires/,
  )
  assert.throws(
    () => parseCliArguments(['import', 'codex', '--session', 'root', '--unknown']),
    /unknown option/,
  )
  assert.throws(
    () => parseCliArguments(['migrate']),
    /exactly one of --dry-run or --apply/,
  )
  assert.throws(
    () => parseCliArguments(['migrate', '--dry-run', '--backup', '/tmp/backup.sqlite']),
    /--backup is only valid with --apply/,
  )
  assert.throws(
    () => parseCliArguments(['migrate', '--apply']),
    /--backup is required with --apply/,
  )
  assert.throws(() => parseCliArguments(['scheduler', 'status', '--prompt', 'secret']), /does not accept/)
  assert.throws(() => parseCliArguments(['scheduler', 'exec', 'anything']), /usage:/)
})

test('CLI scheduler commands delegate only to the typed taskd control-plane client', async () => {
  const calls = []
  const configResolver = async () => ({ serverBaseUrl: 'http://127.0.0.1:43127' })
  const clientFactory = ({ baseUrl }) => ({
    schedulerStatus: async () => {
      calls.push(['status', baseUrl])
      return { ready: true, scheduler: { supported: true } }
    },
    schedulerReconcile: async () => {
      calls.push(['reconcile', baseUrl])
      return { jobs: [{ id: '11111111-1111-4111-8111-111111111111', reconciled: true, error_code: null }] }
    },
  })

  assert.deepEqual(await runCli(['scheduler', 'status'], { configResolver, clientFactory }), {
    ready: true, scheduler: { supported: true },
  })
  assert.deepEqual(await runCli(['scheduler', 'reconcile'], { configResolver, clientFactory }), {
    jobs: [{ id: '11111111-1111-4111-8111-111111111111', reconciled: true, error_code: null }],
  })
  assert.deepEqual(calls, [
    ['status', 'http://127.0.0.1:43127'],
    ['reconcile', 'http://127.0.0.1:43127'],
  ])

  await assert.rejects(runCli(['scheduler', 'reconcile'], {
    configResolver,
    clientFactory: () => ({
      schedulerReconcile: async () => {
        const error = new Error('unavailable')
        error.code = 'SERVICE_UNAVAILABLE'
        throw error
      },
    }),
  }), (error) => error.code === 'SERVICE_UNAVAILABLE')
})

test('CLI delegates control commands and sends a normalized dry-run batch to taskd', async () => {
  const calls = []
  const control = await runCli([], {
    controlRunner: async (command) => ({ command, ready: true }),
  })
  assert.deepEqual(control, { command: 'status', ready: true })

  const result = await runCli([
    'import', 'codex', '--session', 'root-session', '--dry-run', '--codex-home', '/tmp/codex',
  ], {
    parseImport: async (input) => {
      calls.push({ type: 'parse', input })
      return {
        source: 'codex', session_id: 'root-session', root_turns: 1,
        subagent_executions: 0, records: [{ external_key: 'record-1' }],
        warnings: [{ code: 'SYNTHETIC_WARNING' }],
      }
    },
    configResolver: async () => ({ serverBaseUrl: 'http://127.0.0.1:43127' }),
    clientFactory: ({ baseUrl }) => ({
      importExecutions: async (input) => {
        calls.push({ type: 'request', baseUrl, input })
        return { dry_run: true, would_create: 1, warnings: input.warnings }
      },
    }),
  })

  assert.deepEqual(result, {
    dry_run: true, would_create: 1, warnings: [{ code: 'SYNTHETIC_WARNING' }],
  })
  assert.deepEqual(calls, [
    {
      type: 'parse',
      input: { sessionId: 'root-session', codexHome: '/tmp/codex' },
    },
    {
      type: 'request',
      baseUrl: 'http://127.0.0.1:43127',
      input: {
        source: 'codex', session_id: 'root-session', root_turns: 1,
        subagent_executions: 0, records: [{ external_key: 'record-1' }],
        warnings: [{ code: 'SYNTHETIC_WARNING' }], dry_run: true,
      },
    },
  ])
})

test('CLI surfaces an unavailable taskd instead of writing substitute files', async () => {
  await assert.rejects(runCli([
    'import', 'codex', '--session', 'root-session', '--dry-run',
  ], {
    parseImport: async () => ({
      source: 'codex', session_id: 'root-session', root_turns: 0,
      subagent_executions: 0, records: [], warnings: [],
    }),
    configResolver: async () => ({ serverBaseUrl: 'http://127.0.0.1:43127' }),
    clientFactory: () => ({
      importExecutions: async () => {
        const error = new Error('tasks-recorder taskd is unavailable')
        error.code = 'SERVICE_UNAVAILABLE'
        throw error
      },
    }),
  }), (error) => error.code === 'SERVICE_UNAVAILABLE')
})

test('CLI delegates migration dry-run to the configured database without probing taskd', async () => {
  const calls = []
  const result = await runCli(['migrate', '--dry-run'], {
    configResolver: async () => ({
      databasePath: '/config/tasks.sqlite',
      serverBaseUrl: 'http://127.0.0.1:43127',
    }),
    serviceProbe: async () => {
      calls.push({ type: 'probe' })
      return true
    },
    migrationRunner: async (input) => {
      calls.push({ type: 'migrate', input })
      return { dry_run: true, source_schema_version: 2, target_schema_version: 3 }
    },
  })

  assert.deepEqual(result, {
    dry_run: true, source_schema_version: 2, target_schema_version: 3,
  })
  assert.deepEqual(calls, [{
    type: 'migrate',
    input: { mode: 'dry-run', databasePath: '/config/tasks.sqlite' },
  }])
})

test('CLI refuses migration apply while taskd is reachable and applies only after it stops', async () => {
  const argv = ['migrate', '--apply', '--backup', '/tmp/tasks.v2.backup.sqlite']
  const dependencies = {
    configResolver: async () => ({
      databasePath: '/config/tasks.sqlite',
      serverBaseUrl: 'http://127.0.0.1:43127',
    }),
  }
  await assert.rejects(
    () => runCli(argv, { ...dependencies, serviceProbe: async () => true }),
    (error) => error.code === 'TASKD_MUST_BE_STOPPED',
  )

  const calls = []
  const result = await runCli(argv, {
    ...dependencies,
    serviceProbe: async (baseUrl) => {
      calls.push({ type: 'probe', baseUrl })
      return false
    },
    migrationRunner: async (input) => {
      calls.push({ type: 'migrate', input })
      return { dry_run: false, migrated: { task_count: 2 } }
    },
  })
  assert.deepEqual(result, { dry_run: false, migrated: { task_count: 2 } })
  assert.deepEqual(calls, [
    { type: 'probe', baseUrl: 'http://127.0.0.1:43127' },
    {
      type: 'migrate',
      input: {
        mode: 'apply',
        databasePath: '/config/tasks.sqlite',
        backupPath: '/tmp/tasks.v2.backup.sqlite',
      },
    },
  ])
})

test('CLI migration dry-run and apply rehearse a real v2 copy with a verified restorable backup', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tasks-recorder-cli-migrate-'))
  const databasePath = join(directory, 'tasks.sqlite')
  const backupPath = join(directory, 'tasks.v2.backup.sqlite')
  try {
    const store = createTaskStore({ databasePath })
    store.upsert(taskInput({
      id: 'private-task-id',
      title: 'Private migration fixture',
      project: 'Private fixture',
      session_id: 'private-session-id',
      workfolder: '/private/repository',
      git_root: '/private/repository',
    }))
    store.close()
    const configResolver = async () => ({
      databasePath,
      serverBaseUrl: 'http://127.0.0.1:43127',
    })

    const dryRun = await runCli([
      'migrate', '--dry-run', '--database', databasePath,
    ], { configResolver })
    assert.equal(dryRun.dry_run, true)
    assert.equal(dryRun.legacy.task_count, 1)
    assert.doesNotMatch(JSON.stringify(dryRun), /Private|private-|\/private\//)
    let db = new DatabaseSync(databasePath, { readOnly: true })
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 2)
    db.close()

    const applied = await runCli([
      'migrate', '--apply', '--database', databasePath, '--backup', backupPath,
    ], { configResolver, serviceProbe: async () => false })
    assert.equal(applied.dry_run, false)
    assert.equal(applied.migrated.task_count, 1)
    assert.match(applied.backup.sha256, /^[a-f0-9]{64}$/)
    assert.deepEqual(applied.invariants, {
      integrity_check: 'ok',
      foreign_key_violation_count: 0,
      invariant_violation_count: 0,
    })
    assert.doesNotMatch(JSON.stringify(applied), /Private|private-|\/private\//)

    db = new DatabaseSync(databasePath, { readOnly: true })
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 3)
    db.close()
    const backup = new DatabaseSync(backupPath, { readOnly: true })
    assert.equal(backup.prepare('PRAGMA user_version').get().user_version, 2)
    assert.equal(backup.prepare('SELECT COUNT(*) AS count FROM tasks').get().count, 1)
    backup.close()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('CLI main returns stable success and failure exit codes with JSON-only stdout', async () => {
  let stdout = ''
  let stderr = ''
  const success = await runCliMain([], {
    stdout: { write: (value) => { stdout += value } },
    stderr: { write: (value) => { stderr += value } },
    controlRunner: async () => ({ ready: true }),
  })
  assert.equal(success, 0)
  assert.deepEqual(JSON.parse(stdout), { ready: true })
  assert.equal(stderr, '')

  stdout = ''
  const failure = await runCliMain(['invalid'], {
    stdout: { write: (value) => { stdout += value } },
    stderr: { write: (value) => { stderr += value } },
  })
  assert.equal(failure, 1)
  assert.equal(stdout, '')
  assert.match(stderr, /usage:/)
})
