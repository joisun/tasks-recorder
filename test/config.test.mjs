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
    assert.equal(config.serverHost, '127.0.0.1')
    assert.equal(config.serverPort, 43127)
    assert.equal(config.serverBaseUrl, 'http://127.0.0.1:43127')
    assert.deepEqual(Object.keys(config).sort(), [
      'configPath', 'dataDirectory', 'databasePath', 'outputDir', 'projectRoot',
      'serverBaseUrl', 'serverHost', 'serverPort',
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
