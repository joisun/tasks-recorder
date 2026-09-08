import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

import { openRunFile } from '../server/src/runs/run-file-opener.mjs'

async function fixture(t, filePath = '产出 #1;$(id).md') {
  const root = await mkdtemp(join(tmpdir(), 'tasks-run-file-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const workspace = join(root, 'workspace')
  await mkdir(workspace)
  await writeFile(join(workspace, filePath), 'test')
  const run = { snapshot: { workspace }, file_changes: [{ path: filePath, kind: 'add' }] }
  const calls = []
  const options = { platform: 'darwin', execFileImpl: async (...args) => { calls.push(args) } }
  return { root, workspace, run, calls, options, filePath }
}

test('opens a recorded relative filename via macOS open without shell interpretation', async t => {
  const f = await fixture(t)
  const result = await openRunFile(f.run, f.filePath, f.options)
  assert.deepEqual(result, { opened: true, path: f.filePath })
  assert.deepEqual(f.calls, [[
    '/usr/bin/open', [pathToFileURL(await realpath(join(f.workspace, f.filePath))).href],
    { timeout: 5000, shell: false },
  ]])
})

test('accepts recorded absolute files inside the captured workspace', async t => {
  const f = await fixture(t)
  const absolute = join(f.workspace, f.filePath)
  f.run.file_changes = [{ path: absolute, kind: 'update' }]
  await openRunFile(f.run, absolute, f.options)
  assert.equal(f.calls.length, 1)
})

test('rejects unrecorded, deleted and malformed targets without opening anything', async t => {
  const f = await fixture(t)
  await assert.rejects(openRunFile(f.run, 'not-recorded.md', f.options), { code: 'RUN_FILE_NOT_RECORDED' })
  f.run.file_changes[0].kind = 'delete'
  await assert.rejects(openRunFile(f.run, f.filePath, f.options), { code: 'RUN_FILE_DELETED' })
  for (const path of [null, '', 'bad\0path', 123]) {
    await assert.rejects(openRunFile(f.run, path, f.options), { code: 'RUN_FILE_PATH_INVALID' })
  }
  assert.equal(f.calls.length, 0)
})

test('rejects workspace traversal and symlink escapes even if recorded', async t => {
  const f = await fixture(t)
  await writeFile(join(f.root, 'outside.md'), 'outside')
  await symlink(join(f.root, 'outside.md'), join(f.workspace, 'link.md'))
  for (const path of ['../outside.md', join(f.root, 'outside.md'), 'link.md']) {
    f.run.file_changes = [{ path, kind: 'add' }]
    await assert.rejects(openRunFile(f.run, path, f.options), { code: 'RUN_FILE_OUTSIDE_WORKSPACE' })
  }
  assert.equal(f.calls.length, 0)
})

test('reports missing files and refuses directories', async t => {
  const f = await fixture(t)
  f.run.file_changes = [{ path: 'missing.md', kind: 'update' }, { path: '.', kind: 'add' }]
  await assert.rejects(openRunFile(f.run, 'missing.md', f.options), { code: 'RUN_FILE_NOT_FOUND' })
  await assert.rejects(openRunFile(f.run, '.', f.options), { code: 'RUN_FILE_NOT_REGULAR' })
  assert.equal(f.calls.length, 0)
})

test('reports unsupported platforms and launcher failure', async t => {
  const f = await fixture(t)
  await assert.rejects(openRunFile(f.run, f.filePath, { ...f.options, platform: 'linux' }), { code: 'RUN_FILE_OPEN_UNSUPPORTED' })
  await assert.rejects(openRunFile(f.run, f.filePath, {
    ...f.options, execFileImpl: async () => { throw new Error('private stderr') },
  }), { code: 'RUN_FILE_OPEN_FAILED', message: '无法打开文件，请检查系统默认应用关联' })
  assert.equal(f.calls.length, 0)
})
