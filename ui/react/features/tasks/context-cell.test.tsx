import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'

import { ContextCell } from './context-cell'

test('copies the exact context value and exposes one custom tooltip without a native title', async () => {
  const writeText = vi.fn(async () => undefined)
  const user = userEvent.setup()

  render(<ContextCell label="Workspace" value={'/Users/me/project\nfeature/react-dashboard'} writeText={writeText} />)

  expect(screen.queryByTitle(/Workspace/)).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: '复制 Workspace' }))

  expect(writeText).toHaveBeenCalledWith('/Users/me/project\nfeature/react-dashboard')
  expect(await screen.findByText('已复制 Workspace')).toBeInTheDocument()
})

test('renders an inert placeholder when context is unavailable', () => {
  render(<ContextCell label="Branch" value={null} />)

  expect(screen.getByText('—')).toBeInTheDocument()
  expect(screen.queryByRole('button')).not.toBeInTheDocument()
})
