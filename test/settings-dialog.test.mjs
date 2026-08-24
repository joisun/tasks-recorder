import assert from 'node:assert/strict'
import test from 'node:test'

import { settingsDialogMarkup } from '../ui/src/settings-dialog.mjs'

test('settings dialog presents an extensible General shell and terminal availability', () => {
  const html = settingsDialogMarkup({
    settings: { resume_terminal: 'otty' },
    terminalOptions: [
      { id: 'terminal', label: 'Terminal.app', description: 'System', available: true },
      { id: 'otty', label: 'Otty', description: 'Otty', available: true },
      { id: 'ghostty', label: 'Ghostty', description: 'Ghostty', available: false },
    ],
  })

  assert.match(html, /role="dialog"/)
  assert.match(html, /aria-labelledby="settings-title"/)
  assert.match(html, /Settings/)
  assert.match(html, /General/)
  assert.match(html, /Session resume/)
  assert.match(html, /value="otty" selected/)
  assert.match(html, /value="ghostty" disabled>Ghostty · 未安装/)
  assert.match(html, /codex resume · cwd: Workspace/)
  assert.match(html, /页面不会发送 shell command/)
})

test('settings dialog escapes adapter metadata and communicates loading state', () => {
  const html = settingsDialogMarkup({
    settings: { resume_terminal: 'terminal' },
    terminalOptions: [{
      id: 'terminal', label: '<Terminal>', description: 'unsafe', available: true,
    }],
  })
  assert.match(html, /&lt;Terminal&gt;/)
  assert.doesNotMatch(html, /<Terminal>/)
  assert.match(settingsDialogMarkup({ loading: true }), /读取中…/)
  assert.match(settingsDialogMarkup({ loading: true }), /data-settings-terminal disabled/)
})
