import { expect, test } from 'vitest'

test('React UI test toolchain boots in jsdom', () => {
  const element = document.createElement('div')
  element.textContent = 'Tasks Recorder'
  document.body.append(element)
  expect(element).toHaveTextContent('Tasks Recorder')
})
