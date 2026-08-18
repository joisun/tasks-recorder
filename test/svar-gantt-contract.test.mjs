import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('pins the MIT SVAR React Gantt runtime for the migration', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(pkg.dependencies['@svar-ui/react-gantt'], '2.7.1')
  assert.equal(pkg.dependencies.react, '19.2.8')
  assert.equal(pkg.dependencies['react-dom'], '19.2.8')
  assert.equal('dhtmlx-gantt' in pkg.dependencies, false)
})

test('installed SVAR renderer is the expected MIT release', async () => {
  const metadata = JSON.parse(await readFile(
    new URL('../node_modules/@svar-ui/react-gantt/package.json', import.meta.url),
    'utf8',
  ))
  assert.equal(metadata.version, '2.7.1')
  assert.equal(metadata.license, 'MIT')
})
