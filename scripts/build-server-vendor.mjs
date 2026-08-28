#!/usr/bin/env node

import { randomUUID } from 'node:crypto'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { build } from 'esbuild'

export async function buildServerVendor({
  projectRoot = fileURLToPath(new URL('..', import.meta.url)),
} = {}) {
  const outputPath = join(projectRoot, 'server', 'vendor', 'yaml.mjs')
  const temporaryPath = `${outputPath}.${process.pid}.${randomUUID()}.tmp`
  const result = await build({
    stdin: {
      contents: "export { parseDocument, stringify } from 'yaml'\n",
      resolveDir: projectRoot,
      sourcefile: 'yaml-vendor-entry.mjs',
      loader: 'js',
    },
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node24',
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
    legalComments: 'inline',
    minify: true,
    sourcemap: false,
    write: false,
  })
  const [output] = result.outputFiles
  if (!output?.contents?.length) throw new Error('yaml vendor build produced no output')
  await mkdir(dirname(outputPath), { recursive: true })
  try {
    await writeFile(temporaryPath, output.contents, { mode: 0o644 })
    await rename(temporaryPath, outputPath)
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined)
  }
  return outputPath
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildServerVendor().catch((error) => {
    process.stderr.write(`${error.stack ?? error}\n`)
    process.exitCode = 1
  })
}
