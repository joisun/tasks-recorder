#!/usr/bin/env node

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { build } from 'esbuild'

export async function buildAdapters({
  projectRoot = fileURLToPath(new URL('..', import.meta.url)),
} = {}) {
  const outputs = []
  for (const host of ['codex', 'claude']) {
    const pluginRoot = resolve(projectRoot, 'adapters', host, 'tasks-recorder')
    const outfile = resolve(pluginRoot, 'dist', 'mcp-server.mjs')
    await mkdir(resolve(pluginRoot, 'dist'), { recursive: true })
    await build({
      entryPoints: [resolve(pluginRoot, 'mcp', 'server.mjs')],
      outfile,
      bundle: true,
      platform: 'node',
      target: 'node24',
      format: 'esm',
      legalComments: 'inline',
      sourcemap: false,
    })
    const bundle = await readFile(outfile, 'utf8')
    await writeFile(outfile, bundle.replace(/[ \t]+$/gm, ''))
    outputs.push(outfile)
  }
  return outputs
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildAdapters().then((outputs) => {
    process.stdout.write(`${outputs.join('\n')}\n`)
  }).catch((error) => {
    process.stderr.write(`${error.stack ?? error}\n`)
    process.exitCode = 1
  })
}
