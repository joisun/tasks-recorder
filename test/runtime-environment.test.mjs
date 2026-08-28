import assert from 'node:assert/strict'
import { delimiter } from 'node:path'
import test from 'node:test'

import { createRuntimeEnvironment } from '../server/src/runtime/runtime-environment.mjs'

const CODEX_DEFINITION = Object.freeze({
  id: 'codex',
  launch: Object.freeze({
    executableNames: Object.freeze(['codex']),
    packagedCandidates: Object.freeze([]),
  }),
})

test('runtime environment discovers installed Node toolchains outside process PATH', () => {
  const entries = new Map([
    ['/Users/tester/.nvm/versions/node', ['v20.19.4', 'v22.18.0']],
    ['/Users/tester/.local/share/fnm/node-versions', ['v20.18.3', 'v22.17.1']],
    ['/Users/tester/.local/share/mise/installs/node', ['20.19.3', '22.17.0']],
  ])
  const environment = createRuntimeEnvironment({
    env: { HOME: '/Users/tester', PATH: '/usr/bin:/bin' },
    platform: 'darwin',
    readDirectory: (directory) => entries.get(directory) ?? [],
  })

  const directories = environment.searchDirectories()

  assert.equal(directories.includes('/Users/tester/.nvm/versions/node/v22.18.0/bin'), true)
  assert.equal(
    directories.includes('/Users/tester/.local/share/fnm/node-versions/v22.17.1/installation/bin'),
    true,
  )
  assert.equal(
    directories.includes('/Users/tester/.local/share/mise/installs/node/22.17.0/bin'),
    true,
  )
  assert.equal(
    environment.executableCandidates(CODEX_DEFINITION)
      .includes('/Users/tester/.nvm/versions/node/v22.18.0/bin/codex'),
    true,
  )
})

test('runtime environment uses one enriched PATH for discovery and child processes', () => {
  const environment = createRuntimeEnvironment({
    env: { HOME: '/Users/tester', PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' },
    platform: 'darwin',
    readDirectory: () => [],
  })

  const candidates = environment.executableCandidates(CODEX_DEFINITION)
  const child = environment.childEnvironment({ TASKS_RECORDER_RUN: '1' })
  const childDirectories = child.PATH.split(delimiter)

  assert.equal(child.LANG, 'en_US.UTF-8')
  assert.equal(child.TASKS_RECORDER_RUN, '1')
  assert.equal(childDirectories.includes('/opt/homebrew/bin'), true)
  assert.equal(candidates.includes('/opt/homebrew/bin/codex'), true)
  assert.equal(
    childDirectories.every((directory) => candidates.includes(`${directory}/codex`)),
    true,
  )
})
