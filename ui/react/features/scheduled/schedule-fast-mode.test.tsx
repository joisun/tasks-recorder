import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { DashboardApi } from '@/lib/api/dashboard-api'
import type { ScheduleRecord } from '@/lib/api/types'
import { ScheduleEditorDialog } from './schedule-editor-dialog'
import { describe, expect, it, vi } from 'vitest'

import { defaultScheduleDraft, draftToScheduleInput, scheduleToDraft } from './schedule-draft'

describe('Schedule Fast mode', () => {
  it.each([['', null], ['on', true], ['off', false]] as const)('round-trips %s through the API payload and editor', (choice, value) => {
    const draft = { ...defaultScheduleDraft(), title: 'Review', prompt: 'Review files', workspace: '/tmp/project', fast_mode: choice }
    const input = draftToScheduleInput(draft)
    expect(input.fast_mode).toBe(value)
    expect(scheduleToDraft(input).fast_mode).toBe(choice)
  })

  it('inherits for existing definitions and clears the override for other runtimes', () => {
    expect(scheduleToDraft({}).fast_mode).toBe('')
    const draft = { ...defaultScheduleDraft(), title: 'Review', prompt: 'Review files', workspace: '/tmp/project', agent: 'other', fast_mode: 'on' as const }
    expect(draftToScheduleInput(draft).fast_mode).toBeNull()
  })
})

it('edits an enabled Fast mode to ordinary speed and saves false', async () => {
  const job = {
    id: 'schedule-a', etag: 'a'.repeat(64), title: 'Review', prompt: 'Review files',
    workspace: '/tmp/project', agent: 'codex', fast_mode: true,
    cadence: { kind: 'daily', hour: 9, minute: 0 }, sandbox_mode: 'read-only',
    model: null, reasoning_effort: null, timeout_seconds: 7200,
  } as ScheduleRecord
  const api = {
    runtimes: vi.fn(async () => ({ runtimes: [{ id: 'codex', display_name: 'Codex', state: 'available' }] })),
    schedule: vi.fn(async () => ({ job })),
    runtimeModels: vi.fn(async () => ({ models: [] })),
    updateSchedule: vi.fn(async () => ({ job })),
  }
  render(<ScheduleEditorDialog api={api as unknown as DashboardApi} open schedule={job} onOpenChange={() => {}} onSaved={async () => {}} />)
  const user = userEvent.setup()
  const control = await screen.findByRole('button', { name: /Fast mode/ })
  await waitFor(() => expect(control).toHaveTextContent('开启'))
  await user.click(control)
  await user.click(await screen.findByRole('option', { name: '关闭（普通速度）' }))
  await user.click(screen.getByRole('button', { name: '保存计划' }))
  await waitFor(() => expect(api.updateSchedule).toHaveBeenCalledWith(job.id, job.etag, expect.objectContaining({ fast_mode: false })))
})


it.each([['', null], ['on', true], ['off', false]] as const)('round-trips sandbox network policy %s independently from Fast mode', (choice, value) => {
  const input = draftToScheduleInput({ ...defaultScheduleDraft(), title: 'Network', prompt: 'Fetch sources', workspace: '/tmp/project', network_access: choice, fast_mode: 'off' })
  expect(input.network_access).toBe(value)
  expect(input.fast_mode).toBe(false)
  expect(scheduleToDraft(input).network_access).toBe(choice)
})
