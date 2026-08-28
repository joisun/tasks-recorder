import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('React UI toolchain is pinned and independently testable', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url)))
  const components = JSON.parse(await readFile(new URL('../ui/components.json', import.meta.url)))
  assert.equal(pkg.scripts['check:types'], 'tsc --noEmit')
  assert.equal(pkg.scripts['test:ui'], 'vitest run')
  assert.equal(pkg.devDependencies.typescript, '7.0.2')
  assert.equal(pkg.devDependencies.vitest, '4.1.11')
  assert.equal(pkg.devDependencies.tailwindcss, '4.3.3')
  assert.equal(pkg.devDependencies['@tailwindcss/postcss'], '4.3.3')
  assert.equal(pkg.devDependencies['@testing-library/jest-dom'], '7.0.1')
  assert.equal(pkg.dependencies['react-aria-components'], '1.20.0')
  assert.equal(pkg.dependencies['tailwind-variants'], '3.3.1')
  assert.match(components.registries['@dotui'], /^https:\/\/dotui\.org\/r\/\{name\}\?preset=/)
})
