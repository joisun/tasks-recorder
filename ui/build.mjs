import { build } from 'esbuild'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const uiRoot = dirname(fileURLToPath(import.meta.url))
const sourceRoot = join(uiRoot, 'src')
const outputPath = join(uiRoot, 'dist', 'index.html')

const bundled = await build({
  entryPoints: [join(sourceRoot, 'dashboard.mjs')],
  bundle: true,
  format: 'esm',
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
const html = template
  .replace('/*__SVAR_CSS__*/', () => localSvarCss)
  .replace('/*__DASHBOARD_CSS__*/', () => dashboardCss)
  .replace('/*__DASHBOARD_JS__*/', () => javascript)

await mkdir(dirname(outputPath), { recursive: true })
await writeFile(outputPath, html)
