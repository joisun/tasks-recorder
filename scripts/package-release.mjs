#!/usr/bin/env node

import { execFile } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { buildAdapters } from './build-adapters.mjs'
import { buildServerVendor } from './build-server-vendor.mjs'

const execFileAsync = promisify(execFile)

async function copyEntries(projectRoot, targetRoot, entries) {
  for (const entry of entries) {
    const target = join(targetRoot, entry)
    await mkdir(dirname(target), { recursive: true })
    await cp(join(projectRoot, entry), target, { recursive: true })
  }
}

async function archive(sourceDirectory, rootName, outputPath) {
  await execFileAsync('tar', ['-czf', outputPath, '-C', sourceDirectory, rootName])
  return outputPath
}

export async function packageRelease({
  projectRoot = fileURLToPath(new URL('..', import.meta.url)),
  outputDirectory = join(projectRoot, 'release'),
} = {}) {
  const manifest = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8'))
  const version = manifest.version
  const stageDirectory = await mkdtemp(join(tmpdir(), 'tasks-recorder-package-'))
  await mkdir(outputDirectory, { recursive: true })

  try {
    await Promise.all([
      execFileAsync(process.execPath, [join(projectRoot, 'ui', 'build.mjs')], { cwd: projectRoot }),
      buildAdapters({ projectRoot }),
      buildServerVendor({ projectRoot }),
    ])

    const runtimeName = `tasks-recorder-${version}`
    const runtimeRoot = join(stageDirectory, runtimeName)
    await mkdir(runtimeRoot, { recursive: true })
    await copyEntries(projectRoot, runtimeRoot, [
      'package.json',
      'package-lock.json',
      'LICENSE',
      'server',
      'mcp/src/config.mjs',
      'mcp/src/dashboard-data.mjs',
      'mcp/src/errors.mjs',
      'mcp/src/git-context.mjs',
      'mcp/src/event-envelope.mjs',
      'mcp/src/journal-diagnostics.mjs',
      'mcp/src/journal-service.mjs',
      'mcp/src/journal-store.mjs',
      'mcp/src/project-store.mjs',
      'mcp/src/renderer.mjs',
      'mcp/src/schema-migration.mjs',
      'mcp/src/schema-v3.mjs',
      'mcp/src/task-execution-store.mjs',
      'mcp/src/task-client.mjs',
      'mcp/src/task-service.mjs',
      'mcp/src/task-schema.mjs',
      'mcp/src/task-store.mjs',
      'mcp/src/task-tree.mjs',
      'mcp/src/v3-compatibility-service.mjs',
      'mcp/src/v3-task-store.mjs',
      'mcp/src/work-store.mjs',
      'hooks/src/event-spool.mjs',
      'ui/dist',
      'ui/THIRD_PARTY_NOTICES.md',
    ])

    const artifacts = [await archive(
      stageDirectory,
      runtimeName,
      join(outputDirectory, 'tasks-recorder-macos.tar.gz'),
    )]

    for (const host of ['codex', 'claude']) {
      const adapterStage = join(stageDirectory, `${host}-adapter`)
      const adapterRoot = join(adapterStage, 'tasks-recorder')
      await mkdir(adapterRoot, { recursive: true })
      const sourceRoot = join(projectRoot, 'adapters', host, 'tasks-recorder')
      await copyEntries(sourceRoot, adapterRoot, [
        host === 'codex' ? '.codex-plugin' : '.claude-plugin',
        '.mcp.json',
        'hooks',
        'skills',
        'dist/mcp-server.mjs',
        'THIRD_PARTY_NOTICES.md',
      ])
      await cp(join(projectRoot, 'LICENSE'), join(adapterRoot, 'LICENSE'))
      artifacts.push(await archive(
        adapterStage,
        'tasks-recorder',
        join(outputDirectory, `tasks-recorder-${host}-adapter.tar.gz`),
      ))
    }

    return artifacts
  } finally {
    await rm(stageDirectory, { recursive: true, force: true })
  }
}

function parseOutputDirectory(argv) {
  const index = argv.indexOf('--output')
  if (index === -1) return undefined
  if (!argv[index + 1]) throw new Error('--output requires a directory')
  return resolve(argv[index + 1])
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  packageRelease({ outputDirectory: parseOutputDirectory(process.argv.slice(2)) }).then((artifacts) => {
    process.stdout.write(`${artifacts.map((path) => basename(path)).join('\n')}\n`)
  }).catch((error) => {
    process.stderr.write(`${error.stack ?? error}\n`)
    process.exitCode = 1
  })
}
