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

test('vendors only the minimal AI Elements presentation contract', async () => {
  const packageJson = JSON.parse(await readFile(resolve('package.json'), 'utf8')) as {
    dependencies: Record<string, string>
  }
  const conversation = await readFile(
    resolve('ui/react/components/ai-elements/conversation.tsx'),
    'utf8',
  )
  const message = await readFile(resolve('ui/react/components/ai-elements/message.tsx'), 'utf8')

  expect(packageJson.dependencies).toMatchObject({
    '@streamdown/cjk': '1.0.2',
    '@streamdown/code': '1.1.0',
    streamdown: '2.4.0',
    'use-stick-to-bottom': '1.1.3',
  })
  expect(packageJson.dependencies).not.toHaveProperty('@ai-sdk/react')
  expect(conversation).toContain('use-stick-to-bottom')
  expect(message).toContain('streamdown')
  expect(message).toContain('@streamdown/code')
  expect(`${conversation}\n${message}`).not.toMatch(/shadcn|@ai-sdk\/react|from ['"]ai['"]/)
})
