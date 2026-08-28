import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createDashboardSettings } from '../server/src/dashboard-settings.mjs'

test('dashboard settings preserve service config and atomically persist an available terminal', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tasks-recorder-settings-'))
  const configPath = join(directory, 'config.json')
  const definitions = join(directory, 'my-schedules')
  const relocations = []
  try {
    await mkdir(definitions)
    await writeFile(configPath, JSON.stringify({ output_dir: '.', server_port: 43127 }))
    const settings = createDashboardSettings({
      configPath,
      async relocateDefinitionsDirectory({ directory: target, persist }) {
        relocations.push(target)
        await persist()
        return { moved_count: 2, merged_count: 1, cleanup_warning: null }
      },
      terminalLauncher: {
        options: async () => [
          { id: 'terminal', label: 'Terminal.app', description: 'System', available: true },
          { id: 'otty', label: 'Otty', description: 'Otty', available: true },
          { id: 'ghostty', label: 'Ghostty', description: 'Ghostty', available: false },
        ],
      },
    })

    assert.deepEqual((await settings.get()).settings, {
      resume_terminal: 'terminal', schedule_definitions_dir: join(directory, 'schedules'),
    })
    const updated = await settings.update({ resume_terminal: 'otty' })
    assert.equal(updated.settings.resume_terminal, 'otty')
    assert.equal(updated.restart_required, false)
    const moved = await settings.update({ schedule_definitions_dir: definitions })
    const canonicalDefinitions = await realpath(definitions)
    assert.equal(moved.settings.schedule_definitions_dir, canonicalDefinitions)
    assert.equal(moved.restart_required, false)
    assert.deepEqual(moved.relocation, { moved_count: 2, merged_count: 1, cleanup_warning: null })
    assert.deepEqual(relocations, [canonicalDefinitions])
    assert.deepEqual(JSON.parse(await readFile(configPath, 'utf8')), {
      output_dir: '.', server_port: 43127, resume_terminal: 'otty', schedule_definitions_dir: canonicalDefinitions,
    })
    assert.equal((await stat(configPath)).mode & 0o777, 0o600)
    await assert.rejects(
      settings.update({ resume_terminal: 'ghostty' }),
      (error) => error.code === 'TERMINAL_UNAVAILABLE',
    )
    await assert.rejects(
      settings.update({ schedule_definitions_dir: join(directory, 'missing') }),
      (error) => error.code === 'SCHEDULE_DEFINITIONS_DIR_UNAVAILABLE',
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('settings never exposes a new config when permission hardening fails before commit', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'tasks-recorder-settings-atomic-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const configPath = join(directory, 'config.json')
  const original = { output_dir: '.', server_port: 43127 }
  await writeFile(configPath, `${JSON.stringify(original)}\n`)
  const settings = createDashboardSettings({
    configPath,
    terminalLauncher: {
      options: async () => [
        { id: 'terminal', label: 'Terminal.app', available: true },
        { id: 'otty', label: 'Otty', available: true },
      ],
    },
    chmodImpl: async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }) },
  })

  await assert.rejects(settings.update({ resume_terminal: 'otty' }), { code: 'SETTINGS_WRITE_FAILED' })
  assert.deepEqual(JSON.parse(await readFile(configPath, 'utf8')), original)
})
