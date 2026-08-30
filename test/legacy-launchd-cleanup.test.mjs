import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { cleanupLegacyScheduleLaunchAgents } from '../server/src/scheduler/legacy-launchd-cleanup.mjs'

const JOB_ID = '11111111-1111-4111-8111-111111111111'
const LABEL = `com.joi.tasks-recorder.schedule.${JOB_ID}`

function legacyPlist({ label = LABEL, jobId = JOB_ID } = {}) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>Label</key>
<string>${label}</string>
<key>ProgramArguments</key>
<array>
<string>/usr/local/bin/node</string>
<string>/opt/tasks-recorder/server/scheduled-runner.mjs</string>
<string>${jobId}</string>
</array>
</dict></plist>
`
}

test('cleanup removes only a private legacy Schedule LaunchAgent and is idempotent', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'tasks-recorder-launchd-cleanup-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const directory = join(home, 'Library', 'LaunchAgents')
  await mkdir(directory, { recursive: true })
  const owned = join(directory, `${LABEL}.plist`)
  const unrelated = join(directory, 'com.example.keep.plist')
  await writeFile(owned, legacyPlist(), { mode: 0o600 })
  await writeFile(unrelated, '<plist/>', { mode: 0o600 })
  const calls = []
  const commandRunner = async (command, args) => {
    calls.push([command, args])
    return { code: 0, stdout: '', stderr: '' }
  }

  assert.deepEqual(await cleanupLegacyScheduleLaunchAgents({
    homeDirectory: home,
    uid: process.getuid(),
    commandRunner,
  }), {
    removed: [{ job_id: JOB_ID, label: LABEL }],
    skipped: [],
  })
  assert.deepEqual(calls, [[
    'launchctl',
    ['bootout', `gui/${process.getuid()}`, owned],
  ]])
  assert.deepEqual(await cleanupLegacyScheduleLaunchAgents({
    homeDirectory: home,
    uid: process.getuid(),
    commandRunner,
  }), { removed: [], skipped: [] })
})

test('cleanup reports unsafe matching files without touching them', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'tasks-recorder-launchd-cleanup-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const directory = join(home, 'Library', 'LaunchAgents')
  await mkdir(directory, { recursive: true })
  const unsafe = join(directory, `${LABEL}.plist`)
  const target = join(home, 'target.plist')
  await writeFile(target, legacyPlist(), { mode: 0o600 })
  await symlink(target, unsafe)
  const malformed = 'com.joi.tasks-recorder.schedule.not-a-uuid.plist'
  await writeFile(join(directory, malformed), legacyPlist({
    label: malformed.slice(0, -6),
  }), { mode: 0o600 })

  const result = await cleanupLegacyScheduleLaunchAgents({
    homeDirectory: home,
    uid: process.getuid(),
    commandRunner: async () => assert.fail('unsafe files must not invoke launchctl'),
  })
  assert.deepEqual(result.removed, [])
  assert.deepEqual(result.skipped.map(({ error_code }) => error_code).sort(), [
    'LEGACY_LAUNCHD_ID_INVALID',
    'LEGACY_LAUNCHD_PLIST_UNSAFE',
  ])
  await chmod(target, 0o600)
})
