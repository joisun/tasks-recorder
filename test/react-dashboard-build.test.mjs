import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { compileDashboard, compileReactDashboard } from '../ui/compiler.mjs'

test('React preview compiles to an offline single-file document', async () => {
  const html = await compileReactDashboard()
  assert.match(html, /id="root"/)
  assert.match(html, /Tasks Recorder/)
  assert.equal((html.match(/<script type="module">/g) ?? []).length, 1)
  assert.equal((html.match(/<style>/g) ?? []).length, 1)
  assert.doesNotMatch(html, /<script[^>]+src=|<link[^>]+href=/)
  assert.doesNotMatch(html, /(?:src|href)=["']https?:\/\/|url\(\s*["']?https?:\/\//i)
})

test('adding the React compiler does not change legacy compilation', async () => {
  const html = await compileDashboard()
  assert.match(html, /wx-gantt/)
  assert.match(html, /\/api\/v1\/snapshot/)
})

test('build command writes both legacy and React artifacts', async () => {
  const html = await readFile(new URL('../ui/dist/react.html', import.meta.url), 'utf8')
  assert.match(html, /id="root"/)
})
