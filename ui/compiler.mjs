import { build } from 'esbuild'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import postcss from 'postcss'
import tailwindcss from '@tailwindcss/postcss'

const uiRoot = dirname(fileURLToPath(import.meta.url))
const defaultSourceRoot = join(uiRoot, 'src')
const defaultOutputPath = join(uiRoot, 'dist', 'index.html')
const defaultReactSourceRoot = join(uiRoot, 'react')
const defaultReactOutputPath = join(uiRoot, 'dist', 'react.html')

export async function compileDashboard({ sourceRoot = defaultSourceRoot, buildImpl = build } = {}) {
  const bundled = await buildImpl({
    absWorkingDir: sourceRoot,
    entryPoints: ['dashboard.mjs'],
    bundle: true,
    format: 'esm',
    jsx: 'transform',
    tsconfigRaw: { compilerOptions: {} },
    minify: true,
    write: false,
    legalComments: 'inline',
    target: ['es2022'],
    outdir: 'out',
    loader: {
      '.woff': 'dataurl',
      '.woff2': 'dataurl',
      '.ttf': 'dataurl',
    },
  })
  const [template, dashboardCss] = await Promise.all([
    readFile(join(sourceRoot, 'index.html'), 'utf8'),
    readFile(join(sourceRoot, 'dashboard.css'), 'utf8'),
  ])
  const javascript = bundled.outputFiles.find(({ path }) => extname(path) === '.js')?.text
  const svarCss = bundled.outputFiles.find(({ path }) => extname(path) === '.css')?.text
  if (!javascript || !svarCss) throw new Error('SVAR Dashboard bundle is incomplete')
  const localSvarCss = svarCss.replace(/@font-face\s*\{[^{}]*\}/g, '')
  if (/https?:\/\/[^)'\"]+\.(?:woff2?|ttf)/i.test(localSvarCss)) {
    throw new Error('SVAR Dashboard CSS contains a remote font')
  }
  return template
    .replace('/*__SVAR_CSS__*/', () => localSvarCss)
    .replace('/*__DASHBOARD_CSS__*/', () => dashboardCss)
    .replace('/*__DASHBOARD_JS__*/', () => javascript)
}

export async function writeDashboard({ outputPath = defaultOutputPath, compile = compileDashboard } = {}) {
  const html = await compile()
  await writeAtomically(outputPath, html)
  return { outputPath, bytes: Buffer.byteLength(html) }
}

export async function compileReactDashboard({
  sourceRoot = defaultReactSourceRoot,
  buildImpl = build,
  processCss = async (source, from) => (
    await postcss([tailwindcss()]).process(source, { from })
  ).css,
} = {}) {
  const bundled = await buildImpl({
    absWorkingDir: sourceRoot,
    entryPoints: ['entry.tsx'],
    bundle: true,
    format: 'esm',
    jsx: 'automatic',
    minify: true,
    write: false,
    legalComments: 'inline',
    target: ['es2022'],
    outdir: 'out',
    loader: {
      '.woff': 'dataurl',
      '.woff2': 'dataurl',
      '.ttf': 'dataurl',
    },
  })
  const [template, appCss] = await Promise.all([
    readFile(join(sourceRoot, 'index.html'), 'utf8'),
    readFile(join(sourceRoot, 'styles', 'app.css'), 'utf8'),
  ])
  const javascript = bundled.outputFiles.find(({ path }) => extname(path) === '.js')?.text
  if (!javascript) throw new Error('React Dashboard bundle is incomplete')
  const generatedCss = bundled.outputFiles.find(({ path }) => extname(path) === '.css')?.text ?? ''
  const localGeneratedCss = generatedCss.replace(/@font-face\s*\{[^{}]*\}/g, '')
  const dashboardCss = [
    await processCss(appCss, join(sourceRoot, 'styles', 'app.css')),
    localGeneratedCss,
  ]
    .filter(Boolean)
    .join('\n')
  if (/url\(\s*['\"]?https?:\/\//i.test(dashboardCss)) {
    throw new Error('React Dashboard CSS contains a remote resource')
  }
  return template
    .replace('/*__REACT_CSS__*/', () => dashboardCss)
    .replace('/*__REACT_JS__*/', () => javascript)
    .replace(/[ \t]+$/gm, '')
}

export async function writeReactDashboard({
  outputPath = defaultReactOutputPath,
  compile = compileReactDashboard,
} = {}) {
  const html = await compile()
  await writeAtomically(outputPath, html)
  return { outputPath, bytes: Buffer.byteLength(html) }
}

async function writeAtomically(outputPath, source) {
  await mkdir(dirname(outputPath), { recursive: true })
  const temporaryPath = `${outputPath}.${process.pid}.tmp`
  try {
    await writeFile(temporaryPath, source)
    await rename(temporaryPath, outputPath)
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => {})
    throw error
  }
}
