import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { expect, test } from 'vitest'

test('React UI test toolchain boots in jsdom', () => {
  const element = document.createElement('div')
  element.textContent = 'Tasks Recorder'
  document.body.append(element)
  expect(element).toHaveTextContent('Tasks Recorder')
})

test('pins the dotUI Vercel registry for reproducible source components', async () => {
  const components = JSON.parse(await readFile(resolve('ui/components.json'), 'utf8')) as {
    registries: Record<string, string>
  }
  expect(components.registries['@dotui']).toMatch(/^https:\/\/dotui\.org\/r\/\{name\}\?preset=/)
})
