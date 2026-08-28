import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { resolveAppConfig } from '../mcp/src/config.mjs'

test('standalone config keeps user state under ~/.config/tasks-recorder', async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), 'tasks-recorder-home-'))
  const projectRoot = join(homeDirectory, 'projects', 'tasks-recorder')
  const dataDirectory = join(homeDirectory, '.config', 'tasks-recorder')
  try {
    await mkdir(dataDirectory, { recursive: true })
    await writeFile(join(dataDirectory, 'config.json'), JSON.stringify({ output_dir: './removed-projections' }))
    const config = await resolveAppConfig({ projectRoot, homeDirectory, env: {} })
    assert.equal(config.projectRoot, projectRoot)
    assert.equal(config.dataDirectory, dataDirectory)
    assert.equal(config.configPath, join(dataDirectory, 'config.json'))
    assert.equal(config.outputDir, join(dataDirectory, 'removed-projections'))
    assert.equal(config.databasePath, join(dataDirectory, 'tasks.sqlite'))
    assert.equal(config.spoolDirectory, join(dataDirectory, 'spool'))
    assert.equal(config.spoolMaxBytes, 4 * 1024 * 1024)
    assert.equal(config.spoolMaxFiles, 512)
    assert.equal(config.spoolMaxAgeMs, 7 * 24 * 60 * 60 * 1000)
    assert.equal(config.logsDirectory, join(dataDirectory, 'logs'))
    assert.equal(config.logMaxFileBytes, 1024 * 1024)
    assert.equal(config.logMaxFiles, 5)
    assert.equal(config.logMaxAgeMs, 14 * 24 * 60 * 60 * 1000)
    assert.equal(config.schedulerDatabasePath, join(dataDirectory, 'scheduler.sqlite'))
    assert.equal(config.scheduleDefinitionsDirectory, join(dataDirectory, 'schedules'))
    assert.equal(config.schedulerLogsDirectory, join(dataDirectory, 'schedules', 'logs'))
    assert.equal(config.schedulerLogMaxFileBytes, 1024 * 1024)
    assert.equal(config.schedulerLogMaxFiles, 8)
    assert.equal(config.schedulerLogMaxAgeMs, 7 * 24 * 60 * 60 * 1000)
    assert.equal(config.codexPath, null)
    assert.equal(config.serverHost, '127.0.0.1')
    assert.equal(config.serverPort, 43127)
    assert.equal(config.serverBaseUrl, 'http://127.0.0.1:43127')
    assert.deepEqual(Object.keys(config).sort(), [
      'codexPath', 'configPath', 'dataDirectory', 'databasePath', 'logMaxAgeMs',
      'logMaxFileBytes', 'logMaxFiles', 'logsDirectory', 'outputDir', 'projectRoot',
      'scheduleDefinitionsDirectory', 'schedulerDatabasePath', 'schedulerLogMaxAgeMs',
      'schedulerLogMaxFileBytes', 'schedulerLogMaxFiles', 'schedulerLogsDirectory',
      'serverBaseUrl', 'serverHost',
      'serverPort', 'spoolDirectory', 'spoolMaxAgeMs', 'spoolMaxBytes', 'spoolMaxFiles',
    ])
  } finally {
    await rm(homeDirectory, { recursive: true, force: true })
  }
})

test('config accepts isolated taskd URL and database overrides while rejecting remote hosts', async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), 'tasks-recorder-home-'))
  const projectRoot = join(homeDirectory, 'projects', 'tasks-recorder')
  const dataDirectory = join(homeDirectory, '.config', 'tasks-recorder')
  try {
    await mkdir(dataDirectory, { recursive: true })
    await writeFile(join(dataDirectory, 'config.json'), JSON.stringify({
      output_dir: './output', server_host: '127.0.0.1', server_port: 43127,
      spool_dir: './private/spool', spool_max_bytes: 8192, spool_max_files: 24,
      spool_max_age_ms: 60000,
      logs_dir: './private/logs', log_max_file_bytes: 4096, log_max_files: 3,
      log_max_age_ms: 120000,
      scheduler_database_path: './private/scheduler.sqlite',
      schedule_definitions_dir: join(homeDirectory, 'Documents', 'automations'),
      scheduler_logs_dir: './private/schedules/logs',
      scheduler_log_max_file_bytes: 8192, scheduler_log_max_files: 12,
      scheduler_log_max_age_ms: 180000,
      codex_path: '/opt/tasks-recorder/bin/codex',
      prompt: 'must-not-leak', scheduler_secret: 'must-not-leak',
    }))
    const config = await resolveAppConfig({
      projectRoot,
      homeDirectory,
      env: {
        AGENT_TASKS_SERVER_URL: 'http://127.0.0.1:49200',
        AGENT_TASKS_DATABASE_PATH: './private/tasks.sqlite',
      },
    })
    assert.equal(config.serverBaseUrl, 'http://127.0.0.1:49200')
    assert.equal(config.serverPort, 49200)
    assert.equal(config.databasePath, join(dataDirectory, 'private', 'tasks.sqlite'))
    assert.equal(config.spoolDirectory, join(dataDirectory, 'private', 'spool'))
    assert.equal(config.spoolMaxBytes, 8192)
    assert.equal(config.spoolMaxFiles, 24)
    assert.equal(config.spoolMaxAgeMs, 60000)
    assert.equal(config.logsDirectory, join(dataDirectory, 'private', 'logs'))
    assert.equal(config.logMaxFileBytes, 4096)
    assert.equal(config.logMaxFiles, 3)
    assert.equal(config.logMaxAgeMs, 120000)
    assert.equal(config.schedulerDatabasePath, join(dataDirectory, 'private', 'scheduler.sqlite'))
    assert.equal(config.scheduleDefinitionsDirectory, join(homeDirectory, 'Documents', 'automations'))
    assert.equal(config.schedulerLogsDirectory, join(dataDirectory, 'private', 'schedules', 'logs'))
    assert.equal(config.schedulerLogMaxFileBytes, 8192)
    assert.equal(config.schedulerLogMaxFiles, 12)
    assert.equal(config.schedulerLogMaxAgeMs, 180000)
    assert.equal(config.codexPath, '/opt/tasks-recorder/bin/codex')
    assert.equal(Object.hasOwn(config, 'prompt'), false)
    assert.equal(Object.hasOwn(config, 'scheduler_secret'), false)

    await assert.rejects(
      resolveAppConfig({
        projectRoot,
        homeDirectory,
        env: { AGENT_TASKS_SERVER_URL: 'http://192.168.1.20:49200' },
      }),
      (error) => error.code === 'CONFIG_INVALID',
    )
  } finally {
    await rm(homeDirectory, { recursive: true, force: true })
  }
})

test('rejects scheduler traversal, remote forms, unsafe caps, and non-absolute Codex paths', async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), 'tasks-recorder-home-'))
  const projectRoot = join(homeDirectory, 'projects', 'tasks-recorder')
  const dataDirectory = join(homeDirectory, '.config', 'tasks-recorder')
  const configPath = join(dataDirectory, 'config.json')
  const invalid = [
    { scheduler_database_path: '' },
    { schedule_definitions_dir: '' },
    { schedule_definitions_dir: '/' },
    { schedule_definitions_dir: 'smb://remote-host/schedules' },
    { scheduler_logs_dir: '//remote-host/private/logs' },
    { scheduler_log_max_files: null },
    { scheduler_log_max_file_bytes: Number.MAX_SAFE_INTEGER + 1 },
    { codex_path: './codex' },
    { codex_path: 'smb://remote-host/codex' },
  ]
  try {
    await mkdir(dataDirectory, { recursive: true })
    for (const schedulerConfig of invalid) {
      await writeFile(configPath, JSON.stringify({ output_dir: './output', ...schedulerConfig }))
      await assert.rejects(
        resolveAppConfig({ projectRoot, homeDirectory, env: {} }),
        (error) => error.code === 'CONFIG_INVALID',
      )
    }
  } finally {
    await rm(homeDirectory, { recursive: true, force: true })
  }
})
