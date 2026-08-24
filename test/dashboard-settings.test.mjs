import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createDashboardSettings } from '../server/src/dashboard-settings.mjs'

test('dashboard settings preserve service config and atomically persist an available terminal', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tasks-recorder-settings-'))
  const configPath = join(directory, 'config.json')
  try {
    await writeFile(configPath, JSON.stringify({ output_dir: '.', server_port: 43127 }))
    const settings = createDashboardSettings({
      configPath,
      terminalLauncher: {
        options: async () => [
          { id: 'terminal', label: 'Terminal.app', description: 'System', available: true },
          { id: 'otty', label: 'Otty', description: 'Otty', available: true },
          { id: 'ghostty', label: 'Ghostty', description: 'Ghostty', available: false },
        ],
      },
    })

    assert.equal((await settings.get()).settings.resume_terminal, 'terminal')
    const updated = await settings.update({ resume_terminal: 'otty' })
    assert.equal(updated.settings.resume_terminal, 'otty')
    assert.deepEqual(JSON.parse(await readFile(configPath, 'utf8')), {
      output_dir: '.', server_port: 43127, resume_terminal: 'otty',
    })
    assert.equal((await stat(configPath)).mode & 0o777, 0o600)
    await assert.rejects(
      settings.update({ resume_terminal: 'ghostty' }),
      (error) => error.code === 'TERMINAL_UNAVAILABLE',
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
