import assert from 'node:assert/strict'
import test from 'node:test'

import { isRenderedFocusable, relocationMessage, settingsDialogMarkup } from '../ui/src/settings-dialog.mjs'

test('settings focus trap excludes controls hidden by responsive CSS', () => {
  assert.equal(isRenderedFocusable({ closest: () => null, getClientRects: () => [] }), false)
  assert.equal(isRenderedFocusable({ closest: () => null, getClientRects: () => [{ width: 44, height: 44 }] }), true)
  assert.equal(isRenderedFocusable({ closest: () => ({ hidden: true }), getClientRects: () => [{ width: 44, height: 44 }] }), false)
})

test('settings dialog presents an extensible General shell and terminal availability', () => {
  const html = settingsDialogMarkup({
    settings: { resume_terminal: 'otty', schedule_definitions_dir: '/tmp/schedules' },
    terminalOptions: [
      { id: 'terminal', label: 'Terminal.app', description: 'System', available: true },
      { id: 'otty', label: 'Otty', description: 'Otty', available: true },
      { id: 'ghostty', label: 'Ghostty', description: 'Ghostty', available: false },
    ],
  })

  assert.match(html, /role="dialog"/)
  assert.match(html, /aria-labelledby="settings-title settings-general-title"/)
  assert.match(html, /Settings/)
  assert.match(html, /General/)
  assert.match(html, /Session resume/)
  assert.match(html, /value="otty" selected/)
  assert.match(html, /value="ghostty" disabled>Ghostty · 未安装/)
  assert.match(html, /codex resume · cwd: Workspace/)
  assert.match(html, /Schedule definitions/)
  assert.match(html, /value="\/tmp\/schedules"/)
  assert.doesNotMatch(html, /Tasks Recorder|Preferences|Local control plane/)
})

test('settings dialog escapes adapter metadata and communicates loading state', () => {
  const html = settingsDialogMarkup({
    settings: { resume_terminal: 'terminal', schedule_definitions_dir: '/tmp/&lt;' },
    terminalOptions: [{
      id: 'terminal', label: '<Terminal>', description: 'unsafe', available: true,
    }],
  })
  assert.match(html, /&lt;Terminal&gt;/)
  assert.doesNotMatch(html, /<Terminal>/)
  assert.match(settingsDialogMarkup({ loading: true }), /读取中…/)
  assert.match(settingsDialogMarkup({ loading: true }), /data-settings-terminal disabled/)
  assert.match(settingsDialogMarkup({ loading: true }), /data-settings-definitions-dir[^>]* disabled/)
})

test('settings reports a live library move instead of asking for a taskd restart', () => {
  assert.equal(relocationMessage({
    relocation: { moved_count: 3, merged_count: 1, cleanup_warning: null },
  }), '目录已切换 · 迁移 3 · 合并 1')
  assert.equal(relocationMessage({
    relocation: { moved_count: 1, merged_count: 0, cleanup_warning: 'old file remained' },
  }), '目录已切换 · 迁移 1 · 旧目录保留了未清理文件')
  assert.doesNotMatch(relocationMessage({ restart_required: true }), /重启/)
})
