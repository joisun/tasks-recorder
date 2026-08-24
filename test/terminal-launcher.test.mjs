import assert from 'node:assert/strict'
import test from 'node:test'

import { createTerminalLauncher, shellQuote } from '../server/src/terminal-launcher.mjs'

test('terminal launcher builds a private self-cleaning resume script without shell interpolation', async () => {
  const existing = new Set([
    '/System/Applications/Utilities/Terminal.app',
    '/usr/local/bin/codex',
    '/usr/local/bin/otty',
  ])
  const writes = []
  const executions = []
  const launcher = createTerminalLauncher({
    platform: 'darwin',
    env: { PATH: '/usr/local/bin:/usr/bin' },
    homeDirectory: '/Users/me',
    runtimeDirectory: '/Users/me/.config/tasks-recorder/runtime',
    accessImpl: async (path) => {
      if (!existing.has(path)) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
    },
    statImpl: async () => ({ isDirectory: () => true }),
    mkdirImpl: async () => {},
    writeFileImpl: async (...args) => { writes.push(args) },
    execFileImpl: async (...args) => { executions.push(args) },
    randomId: () => 'fixed-id',
  })

  assert.deepEqual((await launcher.options()).map(({ id, available }) => [id, available]), [
    ['terminal', true], ['otty', true], ['ghostty', false],
  ])
  const result = await launcher.launch({
    terminal: 'terminal',
    sessionId: '019fa297-4567-7bf0-a69a-84fd23b3aaab',
    workspace: "/Users/me/Work Folder/project's-copy",
  })

  assert.equal(result.terminal_label, 'Terminal.app')
  assert.equal(writes.length, 1)
  assert.equal(writes[0][0], '/Users/me/.config/tasks-recorder/runtime/resume-fixed-id.command')
  assert.equal(writes[0][2].mode, 0o700)
  assert.match(writes[0][1], /^#!\/bin\/zsh\nrm -f -- /)
  assert.match(writes[0][1], /cd -- '\/Users\/me\/Work Folder\/project'\\''s-copy'/)
  assert.match(writes[0][1], /exec '\/usr\/local\/bin\/codex' resume '019fa297-4567-7bf0-a69a-84fd23b3aaab'/)
  assert.deepEqual(executions, [[
    '/usr/bin/open',
    ['-na', '/System/Applications/Utilities/Terminal.app', '/Users/me/.config/tasks-recorder/runtime/resume-fixed-id.command'],
    { timeout: 5_000 },
  ]])
})

test('Otty adapter runs resume inside a persistent shell, then titles and focuses its window', async () => {
  const executions = []
  const writes = []
  let listCount = 0
  const launcher = createTerminalLauncher({
    platform: 'darwin',
    env: { PATH: '/opt/homebrew/bin' },
    homeDirectory: '/Users/me',
    runtimeDirectory: '/Users/me/.config/tasks-recorder/runtime',
    accessImpl: async (path) => {
      if (!['/opt/homebrew/bin/otty', '/opt/homebrew/bin/codex'].includes(path)) throw new Error('missing')
    },
    statImpl: async () => ({ isDirectory: () => true }),
    mkdirImpl: async () => {},
    writeFileImpl: async (...args) => { writes.push(args) },
    execFileImpl: async (...args) => {
      executions.push(args)
      if (args[1][0] === 'window' && args[1][1] === 'list') {
        listCount += 1
        return {
          stdout: JSON.stringify({
            ok: true,
            data: listCount === 1
              ? [{ id: 'w_existing', title: 'Existing', index: 0 }]
              : [
                  { id: 'w_existing', title: 'Existing', index: 0 },
                  { id: 'w_resumed', title: 'Otty', index: 1 },
                ],
          }),
        }
      }
      if (args[1][0] === 'pane' && args[1][1] === 'list') {
        return {
          stdout: JSON.stringify({
            ok: true,
            data: [{
              id: 'p_resumed',
              window_id: 'w_resumed',
              tab_id: 't_resumed',
              index: 0,
              active: true,
              cwd: '/Users/me/project',
              process: '',
              rows: 40,
              cols: 120,
              agent: '',
              agent_session_id: '',
              agent_state: '',
            }],
          }),
        }
      }
      return { stdout: JSON.stringify({ ok: true, data: null }) }
    },
    delayImpl: async () => {},
    randomId: () => 'otty-id',
  })

  const result = await launcher.launch({
    terminal: 'otty',
    sessionId: 'session-safe',
    workspace: '/Users/me/project',
    title: '修复 Dashboard focus',
  })
  assert.deepEqual(executions, [
    [
      '/opt/homebrew/bin/otty',
      ['window', 'list', '--json'],
      { timeout: 5_000 },
    ],
    [
      '/opt/homebrew/bin/otty',
      [
        'open', '/Users/me/project', '--title', '修复 Dashboard focus', '--json',
      ],
      { timeout: 5_000 },
    ],
    [
      '/opt/homebrew/bin/otty',
      ['window', 'list', '--json'],
      { timeout: 5_000 },
    ],
    [
      '/opt/homebrew/bin/otty',
      ['pane', 'list', '--window', 'w_resumed', '--json'],
      { timeout: 5_000 },
    ],
    [
      '/opt/homebrew/bin/otty',
      [
        'pane', 'send-keys', '--pane', 'p_resumed',
        `${shellQuote('/opt/homebrew/bin/codex')} resume ${shellQuote('session-safe')}`,
        'key:Enter', '--json',
      ],
      { timeout: 5_000 },
    ],
    [
      '/opt/homebrew/bin/otty',
      ['window', 'rename', '--window', 'w_resumed', '修复 Dashboard focus', '--json'],
      { timeout: 5_000 },
    ],
    [
      '/opt/homebrew/bin/otty',
      ['window', 'focus', 'w_resumed', '--json'],
      { timeout: 5_000 },
    ],
  ])
  assert.equal(result.focused, true)
  assert.equal(result.window_title, '修复 Dashboard focus')
  assert.equal(writes.length, 0)
})

test('terminal launcher rejects missing workspaces and unsafe session identities before launch', async () => {
  const launcher = createTerminalLauncher({
    platform: 'darwin',
    env: { PATH: '/usr/local/bin' },
    accessImpl: async () => {},
    statImpl: async () => { throw new Error('missing') },
  })
  await assert.rejects(
    launcher.launch({ terminal: 'terminal', sessionId: 'session-safe', workspace: '/missing' }),
    (error) => error.code === 'WORKSPACE_NOT_FOUND',
  )
  await assert.rejects(
    launcher.launch({ terminal: 'terminal', sessionId: 'bad session;open', workspace: '/workspace' }),
    (error) => error.code === 'SESSION_ID_INVALID',
  )
})
