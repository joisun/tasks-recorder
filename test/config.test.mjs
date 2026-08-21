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
    assert.equal(config.serverHost, '127.0.0.1')
    assert.equal(config.serverPort, 43127)
    assert.equal(config.serverBaseUrl, 'http://127.0.0.1:43127')
    assert.deepEqual(Object.keys(config).sort(), [
      'configPath', 'dataDirectory', 'databasePath', 'logMaxAgeMs', 'logMaxFileBytes',
      'logMaxFiles', 'logsDirectory', 'outputDir', 'projectRoot',
      'serverBaseUrl', 'serverHost', 'serverPort', 'spoolDirectory', 'spoolMaxAgeMs',
      'spoolMaxBytes', 'spoolMaxFiles',
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
