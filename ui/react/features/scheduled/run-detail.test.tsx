import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'

import { createDashboardApi } from '@/lib/api/dashboard-api'
import type { RunRecord } from '@/lib/api/types'
import { RunDetail } from './run-detail'

vi.mock('./live-session', () => ({ LiveSession: () => null, SessionConversation: () => null }))

const run: RunRecord = {
  id: 'run-a', job_id: 'schedule-a', definition_etag: 'a', runtime_id: 'codex',
  interactive: false, turn_revision: null, trigger: 'manual', status: 'succeeded',
  thread_id: null, scheduled_for: null, claimed_at: null, started_at: null, heartbeat_at: null,
  finished_at: null, exit_code: 0, error_code: null, final_message: null,
  file_changes: [{ path: 'reports/产出 #1.md', kind: 'add' }, { path: 'old.md', kind: 'delete' }],
  has_stdout_log: false, has_stderr_log: false, reviewed_at: null,
  created_at: '2026-09-08T08:00:00Z', updated_at: '2026-09-08T08:00:00Z',
}

function mount(openRunFile = vi.fn(async (_id: string, path: string) => ({ opened: true, path }))) {
  const api = { ...createDashboardApi(), openRunFile }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  render(<QueryClientProvider client={client}><RunDetail api={api} run={run} /></QueryClientProvider>)
  return { api }
}

test('output filename is keyboard accessible and opens the recorded path for this Run', async () => {
  const { api } = mount()
  const file = screen.getByRole('button', { name: '打开文件 reports/产出 #1.md' })
  file.focus()
  await userEvent.keyboard('{Enter}')
  await waitFor(() => expect(api.openRunFile).toHaveBeenCalledWith('run-a', 'reports/产出 #1.md'))
  expect(await screen.findByRole('status')).toHaveTextContent('已请求系统打开')
  expect(screen.getByRole('button', { name: '打开文件 old.md' })).toBeDisabled()
})

test('prevents repeated clicks while opening and displays actionable failures', async () => {
  let reject!: (error: Error) => void
  const open = vi.fn((_id: string, _path: string) => new Promise<{ opened: boolean; path: string }>((_resolve, fail) => { reject = fail }))
  mount(open)
  const file = screen.getByRole('button', { name: '打开文件 reports/产出 #1.md' })
  await userEvent.click(file)
  await waitFor(() => expect(file).toBeDisabled())
  await userEvent.click(file)
  expect(open).toHaveBeenCalledTimes(1)
  reject(new Error('文件已不存在'))
  expect(await screen.findByRole('alert')).toHaveTextContent('文件已不存在')
  await waitFor(() => expect(file).not.toBeDisabled())
})
