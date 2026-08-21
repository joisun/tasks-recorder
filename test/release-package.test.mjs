import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'

import { packageRelease } from '../scripts/package-release.mjs'

const execFileAsync = promisify(execFile)
const projectRoot = resolve(new URL('..', import.meta.url).pathname)

async function archiveEntries(path) {
  const { stdout } = await execFileAsync('tar', ['-tzf', path])
  return stdout.trim().split('\n').filter(Boolean)
}

test('release packaging creates allowlisted service and independent adapter archives', async () => {
  const outputDirectory = await mkdtemp(join(tmpdir(), 'tasks-recorder-release-'))
  try {
    const artifacts = await packageRelease({ projectRoot, outputDirectory })
    assert.deepEqual(artifacts.map((path) => basename(path)).sort(), [
      'tasks-recorder-claude-adapter.tar.gz',
      'tasks-recorder-codex-adapter.tar.gz',
      'tasks-recorder-macos.tar.gz',
    ])

    const runtimeEntries = await archiveEntries(join(outputDirectory, 'tasks-recorder-macos.tar.gz'))
    for (const suffix of [
      '/package.json',
      '/package-lock.json',
      '/server/taskd.mjs',
      '/server/control.mjs',
      '/server/cli.mjs',
      '/server/src/codex/importer.mjs',
      '/server/src/codex/transcript-reader.mjs',
      '/mcp/src/task-client.mjs',
      '/mcp/src/task-execution-store.mjs',
      '/mcp/src/schema-migration.mjs',
      '/mcp/src/task-store.mjs',
      '/ui/dist/index.html',
      '/ui/THIRD_PARTY_NOTICES.md',
      '/LICENSE',
    ]) {
      assert.ok(runtimeEntries.some((entry) => entry.endsWith(suffix)), `missing ${suffix}`)
    }
    assert.ok(runtimeEntries.every((entry) => !entry.includes('/test/')))
    assert.ok(runtimeEntries.every((entry) => !entry.includes('/adapters/')))
    assert.ok(runtimeEntries.every((entry) => !entry.includes('/node_modules/')))
    assert.ok(runtimeEntries.every((entry) => !entry.includes('/.git/')))
    assert.ok(runtimeEntries.every((entry) => !entry.endsWith('/mcp/server.mjs')))
    assert.ok(runtimeEntries.every((entry) => !entry.endsWith('/mcp/src/tools.mjs')))

    for (const host of ['codex', 'claude']) {
      const entries = await archiveEntries(join(outputDirectory, `tasks-recorder-${host}-adapter.tar.gz`))
      assert.ok(entries.includes('tasks-recorder/dist/mcp-server.mjs'))
      assert.ok(entries.includes('tasks-recorder/.mcp.json'))
      assert.ok(entries.includes('tasks-recorder/hooks/hooks.json'))
      assert.ok(entries.includes('tasks-recorder/skills/task-manager/SKILL.md'))
      assert.ok(entries.includes('tasks-recorder/LICENSE'))
      assert.ok(entries.includes('tasks-recorder/THIRD_PARTY_NOTICES.md'))
      assert.ok(entries.every((entry) => !entry.includes('/mcp/server.mjs')))
      assert.ok(entries.every((entry) => !entry.includes('/node_modules/')))
      assert.ok(entries.some((entry) => entry.includes(host === 'codex' ? '/.codex-plugin/' : '/.claude-plugin/')))
    }
  } finally {
    await rm(outputDirectory, { recursive: true, force: true })
  }
})

test('runtime package keeps production dependencies and excludes build-only dependencies', async () => {
  const outputDirectory = await mkdtemp(join(tmpdir(), 'tasks-recorder-release-'))
  const extractDirectory = await mkdtemp(join(tmpdir(), 'tasks-recorder-extract-'))
  try {
    await packageRelease({ projectRoot, outputDirectory })
    await execFileAsync('tar', [
      '-xzf', join(outputDirectory, 'tasks-recorder-macos.tar.gz'),
      '-C', extractDirectory,
    ])
    const packageSource = await readFile(
      join(extractDirectory, 'tasks-recorder-0.6.0', 'package.json'),
      'utf8',
    )
    const manifest = JSON.parse(packageSource)
    assert.equal(manifest.dependencies['@svar-ui/react-gantt'], '2.7.1')
    assert.equal(manifest.dependencies.react, '19.2.8')
    assert.equal(manifest.dependencies['react-dom'], '19.2.8')
    assert.equal('dhtmlx-gantt' in manifest.dependencies, false)
    assert.equal(manifest.devDependencies.esbuild, '0.28.2')
  } finally {
    await rm(outputDirectory, { recursive: true, force: true })
    await rm(extractDirectory, { recursive: true, force: true })
  }
})

test('release packaging CLI writes all artifacts to an explicit output directory', async () => {
  const outputDirectory = await mkdtemp(join(tmpdir(), 'tasks-recorder-release-cli-'))
  try {
    const { stdout } = await execFileAsync(process.execPath, [
      join(projectRoot, 'scripts', 'package-release.mjs'),
      '--output', outputDirectory,
    ], { cwd: projectRoot })
    assert.deepEqual(stdout.trim().split('\n').sort(), [
      'tasks-recorder-claude-adapter.tar.gz',
      'tasks-recorder-codex-adapter.tar.gz',
      'tasks-recorder-macos.tar.gz',
    ])
  } finally {
    await rm(outputDirectory, { recursive: true, force: true })
  }
})
