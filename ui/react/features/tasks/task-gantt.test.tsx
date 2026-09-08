import { Profiler } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'
import type { DashboardSnapshot, TaskRecord } from '@/lib/api/types'
import { TaskGantt } from './task-gantt'

const row = {
  id: 'project:recorder', parent_id: null, project_id: 'recorder', entity_type: 'project',
  title: 'Tasks Recorder', description: null, lifecycle: 'in_progress', status: 'active',
  rollup_state: 'in_progress', sort_order: 0, revision: 1, archived_at: null,
  progress: { remaining: 1, total: 1, completed: 0, ratio: 0 }, agent: 'Codex',
  next_action: null, planned: { start: '2026-08-01T00:00:00.000Z', end: '2026-09-01T00:00:00.000Z' },
  actual: null, actual_segments: [], actual_segment_count: 0, start: null, end: null,
  last_activity: '2026-08-28T12:00:00.000Z', updated_at: '2026-08-28T12:00:00.000Z',
  session_id: null, session_source: null, resume_available: false, workspace: '/project',
  workfolder: '/project', worktree: '/project', branch: 'main', execution_count: 1,
  active_execution_count: 1, running_execution_count: 1, idle_execution_count: 0,
  stale_execution_count: 0, active_agent_count: 1, live_state: 'running', blocked_count: 0,
} satisfies TaskRecord

const snapshot = {
  server_instance_id: 'server-a', revision: 1, schema_version: 3,
  generated_at: '2026-08-28T12:00:00.000Z', home_directory: '/Users/me', tasks: [row],
  projects: [], warnings: [], project_inbox: [], project_inbox_count: 0,
  attribution_inbox_count: 0, unassigned_execution_count: 0,
} satisfies DashboardSnapshot


test('native scroll keeps whole rows without React commits', () => {
  const commit = vi.fn()
  const { container } = render(<Profiler id="tasks" onRender={commit}><TaskGantt snapshot={snapshot} /></Profiler>)
  const viewport = screen.getByRole('treegrid', { name: '任务时间线' })
  const title = screen.getByRole('button', { name: 'Tasks Recorder' })
  const calls = commit.mock.calls.length
  fireEvent.scroll(viewport, { target: { scrollTop: 1400, scrollLeft: 300 } })
  expect(commit).toHaveBeenCalledTimes(calls)
  expect(title.isConnected).toBe(true)
  expect(container.querySelector('[data-row-id]')?.querySelector('.task-timeline-cell')).toBeInTheDocument()
})

test('metadata and data updates preserve cell identity and latest interactions', async () => {
  const task: TaskRecord = { ...row, id: 'main', entity_type: 'main_task', resume_available: true, session_id: 'session-a' }
  const data = { ...snapshot, tasks: [task] }
  const oldSelect = vi.fn(), select = vi.fn(), resume = vi.fn()
  const { rerender } = render(<TaskGantt snapshot={data} onTaskSelect={oldSelect} />)
  const title = screen.getByRole('button', { name: 'Tasks Recorder' })
  const status = screen.getByRole('button', { name: /修改.*状态/ })
  rerender(<TaskGantt snapshot={{ ...data, revision: 2 }} onTaskSelect={select} pendingTaskIds={new Set(['main'])} />)
  expect(screen.getByRole('button', { name: 'Tasks Recorder' })).toBe(title)
  expect(status).toBeDisabled()
  expect(screen.getByRole('button', { name: /在终端恢复/ })).toBeDisabled()
  await userEvent.click(title)
  expect(select).toHaveBeenCalledWith('main')
  expect(oldSelect).not.toHaveBeenCalled()
  rerender(<TaskGantt snapshot={data} onTaskResume={resume} />)
  await userEvent.click(screen.getByRole('button', { name: /在终端恢复/ }))
  expect(resume).toHaveBeenCalledWith('main')
  status.focus()
  rerender(<TaskGantt snapshot={{ ...data, tasks: [{ ...task, title: 'Updated task', status: 'blocked' }] }} />)
  expect(screen.getByRole('button', { name: 'Updated task' })).toBe(title)
  expect(status).toHaveFocus()
})

test('controlled expansion hides the complete child row', async () => {
  const child = { ...row, id: 'child', parent_id: row.id, entity_type: 'main_task', title: 'Child' } satisfies TaskRecord
  const data = { ...snapshot, tasks: [row, child] }
  const change = vi.fn()
  const { rerender } = render(<TaskGantt snapshot={data} openIds={new Set([row.id])} onOpenIdsChange={change} />)
  expect(screen.getByRole('button', { name: 'Child' })).toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: '折叠 Tasks Recorder' }))
  expect(change).toHaveBeenCalledWith(new Set())
  rerender(<TaskGantt snapshot={data} openIds={new Set()} />)
  expect(screen.queryByRole('button', { name: 'Child' })).not.toBeInTheDocument()
  expect(document.querySelector('[data-row-id="child"]')).toBeNull()
})

test('keyboard navigation focuses next row and Enter opens details', () => {
  const child = { ...row, id: 'child', parent_id: row.id, entity_type: 'main_task', title: 'Child' } satisfies TaskRecord
  const select = vi.fn()
  const { container } = render(<TaskGantt snapshot={{ ...snapshot, tasks: [row, child] }} onTaskSelect={select} />)
  const parent = container.querySelector<HTMLElement>('[data-row-id]')!
  parent.focus()
  fireEvent.keyDown(parent, { key: 'ArrowDown' })
  const next = container.querySelector<HTMLElement>('[data-row-id="child"]')!
  expect(next).toHaveFocus()
  fireEvent.keyDown(next, { key: 'Enter' })
  expect(select).toHaveBeenCalledWith('child')
})

test('planned baseline and separate actual segments retain label toggle', () => {
  const task = { ...row, id: 'main', entity_type: 'main_task', actual: row.planned,
    actual_segments: [
      { id: 's1', kind: 'segment', start: '2026-08-02T00:00:00Z', end: '2026-08-03T00:00:00Z' },
      { id: 's2', kind: 'segment', start: '2026-08-05T00:00:00Z', end: '2026-08-06T00:00:00Z' },
    ], actual_segment_count: 2 } satisfies TaskRecord
  const data = { ...snapshot, tasks: [task] }
  const { container, rerender } = render(<TaskGantt snapshot={data} />)
  expect(container.querySelectorAll('.task-timeline-segment')).toHaveLength(2)
  expect(container.querySelector('.task-timeline-baseline')).toBeInTheDocument()
  expect(container.querySelector('.gantt-task-bar__label')).toBeInTheDocument()
  rerender(<TaskGantt snapshot={data} labelsVisible={false} />)
  expect(container.querySelector('.gantt-task-bar__label')).not.toBeInTheDocument()
})

test('column keyboard resize reports width', () => {
  const resize = vi.fn()
  render(<TaskGantt snapshot={snapshot} onColumnResize={resize} />)
  fireEvent.keyDown(screen.getByRole('separator', { name: '调整任务列宽' }), { key: 'ArrowRight' })
  expect(resize).toHaveBeenCalledWith('text', 310)
})

test('empty snapshot can become populated', () => {
  const { rerender } = render(<TaskGantt snapshot={{ ...snapshot, tasks: [] }} />)
  expect(screen.getByText('暂无任务')).toBeInTheDocument()
  rerender(<TaskGantt snapshot={snapshot} />)
  expect(screen.getByRole('treegrid')).toBeInTheDocument()
})

test('ArrowLeft on a later root keeps focus on that root', () => {
  const other = { ...row, id: 'z', title: 'Second root' }
  const { container } = render(<TaskGantt snapshot={{ ...snapshot, tasks: [row, other] }} />)
  const target = container.querySelector<HTMLElement>('[data-row-id="z"]')!
  target.focus()
  fireEvent.keyDown(target, { key: 'ArrowLeft' })
  expect(target).toHaveFocus()
})

test('narrow timeline bars still have labels in month zoom', () => {
  const task = { ...row, entity_type: 'main_task', planned: {
    start: '2026-08-02T00:00:00Z', end: '2026-08-02T01:00:00Z',
  } } satisfies TaskRecord
  const { container } = render(<TaskGantt snapshot={{ ...snapshot, tasks: [task] }} zoom="month" />)
  expect(container.querySelector('.gantt-task-bar__label')).toHaveTextContent('Tasks Recorder')
})

test('pane can shrink below its default minimum without resizing columns', () => {
  render(<TaskGantt snapshot={snapshot} />)
  const pane = screen.getByRole('separator', { name: '调整任务与时间线分栏' })
  for (let index = 0; index < 35; index++) fireEvent.keyDown(pane, { key: 'ArrowLeft' })
  expect(pane).toHaveAttribute('aria-valuenow', '160')
  expect(screen.getByRole('separator', { name: '调整任务列宽' })).toHaveAttribute('aria-valuenow', '300')
})
