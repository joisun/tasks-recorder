import { build } from 'esbuild'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const uiRoot = dirname(fileURLToPath(import.meta.url))
const projectRoot = dirname(uiRoot)
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
})
const [template, dashboardCss, dhtmlxCss, dhtmlxJs] = await Promise.all([
  readFile(join(sourceRoot, 'index.html'), 'utf8'),
  readFile(join(sourceRoot, 'dashboard.css'), 'utf8'),
  readFile(join(projectRoot, 'node_modules/dhtmlx-gantt/codebase/dhtmlxgantt.css'), 'utf8'),
  readFile(join(projectRoot, 'node_modules/dhtmlx-gantt/codebase/dhtmlxgantt.js'), 'utf8'),
])
const localDhtmlxCss = dhtmlxCss.replace(/@font-face\{[^}]*\}/g, '')
const html = template
  .replace('/*__DHTMLX_CSS__*/', () => localDhtmlxCss)
  .replace('/*__DASHBOARD_CSS__*/', () => dashboardCss)
  .replace('/*__DHTMLX_JS__*/', () => dhtmlxJs)
  .replace('/*__DASHBOARD_JS__*/', () => bundled.outputFiles[0].text)

await mkdir(dirname(outputPath), { recursive: true })
await writeFile(outputPath, html)
