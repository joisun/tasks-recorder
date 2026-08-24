import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { compileDashboard, writeDashboard } from '../ui/compiler.mjs'

test('compiler returns the tracked production dashboard without dev code', async () => {
  const [compiled, tracked] = await Promise.all([
    compileDashboard(),
    readFile(new URL('../ui/dist/index.html', import.meta.url), 'utf8'),
  ])

  assert.equal(compiled, tracked)
  assert.doesNotMatch(compiled, /__tasks_recorder_dev|43128|dev reload/i)
})

test('writer atomically publishes only a successful compilation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tasks-recorder-compiler-'))
  const outputPath = join(directory, 'index.html')
  try {
    const result = await writeDashboard({
      outputPath,
      compile: async () => '<!doctype html><title>compiled</title>',
    })
    assert.equal(await readFile(outputPath, 'utf8'), '<!doctype html><title>compiled</title>')
    assert.equal(result.outputPath, outputPath)
    assert.equal(result.bytes, Buffer.byteLength('<!doctype html><title>compiled</title>'))

    await assert.rejects(
      writeDashboard({ outputPath, compile: async () => { throw new Error('broken source') } }),
      /broken source/,
    )
    assert.equal(await readFile(outputPath, 'utf8'), '<!doctype html><title>compiled</title>')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
