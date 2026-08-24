#!/usr/bin/env node

import { execFile } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const roots = [
  'mcp',
  'server',
  'hooks',
  'adapters/codex/tasks-recorder/hooks',
  'adapters/codex/tasks-recorder/mcp',
  'adapters/claude/tasks-recorder/hooks',
  'adapters/claude/tasks-recorder/mcp',
  'ui',
]

async function sourceFiles(path) {
  const entries = await readdir(path, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    if (entry.name === 'dist' || entry.name === 'node_modules') continue
    const target = resolve(path, entry.name)
    if (entry.isDirectory()) files.push(...await sourceFiles(target))
    else if (entry.isFile() && entry.name.endsWith('.mjs')) files.push(target)
  }
  return files
}

const files = []
for (const entry of roots) {
  const path = resolve(projectRoot, entry)
  if (entry.endsWith('.mjs')) files.push(path)
  else files.push(...await sourceFiles(path))
}

for (const file of [...new Set(files)].sort()) {
  await execFileAsync(process.execPath, ['--check', file])
}
process.stdout.write(`syntax checked ${files.length} source files\n`)
