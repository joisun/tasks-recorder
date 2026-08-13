import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  LAUNCH_AGENT_LABEL,
  createInstallBuildStep,
  createTaskdController,
  renderLaunchAgentPlist,
} from '../server/control.mjs'

test('LaunchAgent plist fixes Node/taskd paths, lifecycle policy, logs, and XML escaping', () => {
  const plist = renderLaunchAgentPlist({
    label: LAUNCH_AGENT_LABEL,
    nodePath: '/opt/Node & Tools/bin/node',
    taskdPath: '/Users/me/tasks recorder/server/taskd.mjs',
    workingDirectory: '/Users/me/tasks recorder',
    stdoutPath: '/Users/me/Library/Logs/tasks-recorder/out.log',
    stderrPath: '/Users/me/Library/Logs/tasks-recorder/error.log',
  })

  assert.match(plist, /<string>com\.joi\.tasks-recorder\.taskd<\/string>/)
  assert.match(plist, /<string>\/opt\/Node &amp; Tools\/bin\/node<\/string>/)
  assert.match(plist, /<string>\/Users\/me\/tasks recorder\/server\/taskd\.mjs<\/string>/)
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/)
  assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/)
  assert.match(plist, /StandardOutPath[\s\S]*out\.log/)
  assert.match(plist, /StandardErrorPath[\s\S]*error\.log/)
})

test('controller install is repeatable and uninstall removes only the plist', async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), 'tasks-recorder-control-'))
  const projectRoot = join(homeDirectory, 'projects', 'tasks-recorder')
  const calls = []
  let builds = 0
  const run = async (command, args, options = {}) => {
    calls.push({ command, args, allowFailure: options.allowFailure ?? false })
    return { code: command === 'launchctl' && args[0] === 'bootout' ? 3 : 0, stdout: '', stderr: '' }
  }
  try {
    const controller = createTaskdController({
      projectRoot,
      homeDirectory,
      nodePath: '/opt/homebrew/bin/node',
      nodeVersion: '24.13.1',
      uid: 502,
      config: { serverBaseUrl: 'http://127.0.0.1:43127' },
      run,
      build: async () => { builds += 1 },
      probeHealth: async () => null,
    })

    const installed = await controller.install()
    assert.equal(builds, 1)
    assert.equal(installed.label, LAUNCH_AGENT_LABEL)
    const plist = await readFile(installed.plistPath, 'utf8')
    assert.match(plist, /\/opt\/homebrew\/bin\/node/)
    assert.match(plist, /projects\/tasks-recorder\/server\/taskd\.mjs/)
    assert.match(plist, /<key>WorkingDirectory<\/key>\s*<string>[^<]*projects\/tasks-recorder<\/string>/)
    assert.deepEqual(calls.slice(-2).map(({ args }) => args[0]), ['bootout', 'bootstrap'])

    await writeFile(controller.paths.stdoutPath, 'keep-log')
    await controller.uninstall()
    await assert.rejects(access(controller.paths.plistPath))
    assert.equal(await readFile(controller.paths.stdoutPath, 'utf8'), 'keep-log')
  } finally {
    await rm(homeDirectory, { recursive: true, force: true })
  }
})

test('controller rejects old Node and a foreign service occupying the configured port', async () => {
  const common = {
    projectRoot: '/projects/tasks-recorder', homeDirectory: '/Users/me', nodePath: '/node', uid: 502,
    config: { serverBaseUrl: 'http://127.0.0.1:43127' },
    run: async () => ({ code: 0, stdout: '', stderr: '' }),
    build: async () => {},
  }
  await assert.rejects(
    createTaskdController({ ...common, nodeVersion: '22.0.0', probeHealth: async () => null }).install(),
    /Node\.js 24 or newer/,
  )
  await assert.rejects(
    createTaskdController({
      ...common,
      nodeVersion: '24.0.0',
      probeHealth: async () => ({ service: 'another-service', ready: true }),
    }).install(),
    /occupied by another service/,
  )
})

test('release install validates the prebuilt dashboard without invoking the source builder', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'tasks-recorder-prebuilt-'))
  const calls = []
  try {
    const run = async (...args) => { calls.push(args) }
    const build = createInstallBuildStep({
      projectRoot,
      nodePath: '/opt/homebrew/bin/node',
      env: { TASKS_RECORDER_PREBUILT: '1' },
      run,
    })
    await assert.rejects(build(), /prebuilt Dashboard is missing/)
    assert.deepEqual(calls, [])

    const dashboardDirectory = join(projectRoot, 'ui', 'dist')
    await mkdir(dashboardDirectory, { recursive: true })
    await writeFile(join(dashboardDirectory, 'index.html'), '<!doctype html>')
    await build()
    assert.deepEqual(calls, [])
  } finally {
    await rm(projectRoot, { recursive: true, force: true })
  }
})

test('source install invokes the Dashboard builder with the selected Node runtime', async () => {
  const calls = []
  const run = async (...args) => { calls.push(args) }
  const build = createInstallBuildStep({
    projectRoot: '/projects/tasks-recorder',
    nodePath: '/opt/homebrew/bin/node',
    env: {},
    run,
  })
  await build()
  assert.deepEqual(calls, [[
    '/opt/homebrew/bin/node',
    ['/projects/tasks-recorder/ui/build.mjs'],
  ]])
})
