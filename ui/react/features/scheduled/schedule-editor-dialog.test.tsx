import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'

import type { DashboardApi } from '@/lib/api/dashboard-api'
import { ScheduleEditorDialog } from './schedule-editor-dialog'

const api = {
  runtimes: vi.fn(async () => ({
    runtimes: [{
      id: 'codex', display_name: 'Codex', state: 'ready',
      capabilities: { contextIsolation: { skills: true, integrations: true } },
    }],
  })),
  runtimeModels: vi.fn(async () => ({ source: 'live', models: [] })),
} as unknown as DashboardApi

test('Schedule editor presents Skills and integrations as separate accessible context switches', async () => {
  const user = userEvent.setup()
  render(<ScheduleEditorDialog
    api={api}
    onOpenChange={() => {}}
    onSaved={async () => {}}
    open
    schedule={null}
  />)

  expect(await screen.findByText('Context')).toBeInTheDocument()
  const skills = await screen.findByRole('switch', { name: 'Load Skills' })
  const integrations = screen.getByRole('switch', { name: 'Load integrations' })
  expect(skills).not.toBeChecked()
  expect(integrations).not.toBeChecked()
  await user.click(skills)
  await user.click(integrations)
  expect(skills).toBeChecked()
  expect(integrations).toBeChecked()
  expect(screen.getByText(/Web Search 和 Codex 内置工具不受影响/)).toBeInTheDocument()
})
