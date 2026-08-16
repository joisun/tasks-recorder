import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('standalone dashboard bundle uses REST + SSE and contains no embedded MCP Apps transport', async () => {
  const html = await readFile(new URL('../ui/dist/index.html', import.meta.url), 'utf8')

  assert.doesNotMatch(html, /cdn\.dhtmlx\.com/)
  assert.doesNotMatch(html, /fonts\.gstatic\.com/)
  assert.match(html, /@font-face\{font-family:dhx-gantt-icons[^}]*data:font\/woff;base64,/)
  assert.doesNotMatch(html, /Auth Refactor|Investigate API timeout/)
  assert.doesNotMatch(html, /@modelcontextprotocol\/ext-apps|callServerTool|agent_tasks_dashboard|dashboard-v1\.html/)
  assert.equal((html.match(/<script/g) ?? []).length, 2)
  assert.equal((html.match(/<\/script>/g) ?? []).length, 2)
  assert.ok(Buffer.byteLength(html) < 2 * 1024 * 1024)
  assert.match(html, /\/api\/v1\/snapshot/)
  assert.match(html, /\/api\/v1\/events/)
  assert.match(html, /EventSource/)
  assert.match(html, /dashboard-grid-width/)
  assert.match(html, /timeline-splitter/)
  assert.match(html, /execution-inbox/)
  assert.match(html, /\/api\/v1\/executions\/tasks/)
  assert.doesNotMatch(html, /getLayoutView\?\.\(["']grid["']\)\?\.\$view/)
  assert.doesNotMatch(html, /DHTMLX Gantt Standard 9\.1 · GPL-2\.0 · SQLite 实时视图/)
  assert.doesNotMatch(html, /class="license-note"/)
})
