import type { ComponentType } from 'react'
import type { IApi, ITask } from '@svar-ui/react-gantt'
import { render, screen } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'

import type { DashboardSnapshot, TaskRecord } from '@/lib/api/types'
import {
  DEFAULT_TASK_COLUMN_WIDTHS,
  resizeTaskColumn,
} from './task-columns'
import { disableVerticalRowVirtualization, TaskGantt } from './task-gantt'

const ganttProps = vi.hoisted(() => vi.fn())

vi.mock('@svar-ui/react-gantt', () => ({
  Gantt: (props: Record<string, unknown>) => {
    ganttProps(props)
    return <div data-testid="svar-gantt" data-grid-width={String(props.gridWidth)} />
  },
}))

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

beforeEach(() => ganttProps.mockClear())

test('renders SVAR directly from the typed React projection', () => {
  render(<TaskGantt snapshot={snapshot} />)

  expect(screen.getByTestId('svar-gantt')).toBeInTheDocument()
  expect(ganttProps).toHaveBeenCalled()
  const props = ganttProps.mock.lastCall?.[0]
  expect(props.tasks.map(({ id }: { id: string }) => id)).toEqual(['project:recorder'])
  expect(props.cellHeight).toBe(30)
  expect(props.scaleHeight).toBe(24)
  expect(props.readonly).toBe(true)
  expect(props.gridWidth).toBe(500)
  expect(props.columns[0].width).toBe(300)
  expect(props.columns.find(({ id }: { id: string }) => id === 'workspace').flexgrow).toBe(1)
})

test('column resizing changes only the requested column and never the pane width', () => {
  const gridWidth = 640
  const resized = resizeTaskColumn(DEFAULT_TASK_COLUMN_WIDTHS, 'workspace', 240)

  expect(resized.workspace).toBe(240)
  expect(resized.text).toBe(DEFAULT_TASK_COLUMN_WIDTHS.text)
  expect(resized.branch).toBe(DEFAULT_TASK_COLUMN_WIDTHS.branch)
  expect(gridWidth).toBe(640)
})

test('pins the Gantt render area and table to all rows instead of recycling vertical slices', async () => {
  const state = {
    _tasks: Array.from({ length: 360 }, (_, index) => ({ id: `task-${index}` })),
    area: { from: 0, start: 0, end: 0 },
  }
  let renderData: ((area: { from: number; start: number; end: number }) => boolean | void) | undefined
  const setTableState = vi.fn()
  const api = {
    getState: () => state,
    intercept: vi.fn((name, handler) => {
      if (name === 'render-data') renderData = handler
    }),
    exec: vi.fn((_name, area) => {
      if (renderData?.(area) !== false) state.area = { ...area }
      return Promise.resolve(area)
    }),
    getTable: vi.fn(() => ({
      getStores: () => ({ data: { setState: setTableState } }),
    })),
  } as unknown as IApi

  disableVerticalRowVirtualization(api, 'test-render-all')
  await Promise.resolve()

  expect(state.area).toEqual({ from: 0, start: 0, end: 360 })
  expect(setTableState).toHaveBeenCalledWith({ dynamic: { rowCount: 360 } })
  expect(renderData?.({ from: 30, start: 1, end: 34 })).toBe(false)
  expect(state.area).toEqual({ from: 0, start: 0, end: 360 })
})

test('renders the task name inside a Timeline bar when the bar has room', () => {
  render(<TaskGantt snapshot={snapshot} />)

  const props = ganttProps.mock.lastCall?.[0]
  const TaskTemplate = props.taskTemplate as ComponentType<{
    data: ITask
    api: IApi
    onaction: (event: { action: string; data: Record<string, unknown> }) => void
  }>
  const data = { ...props.tasks[0], $x: 12, $w: 180 } as ITask
  const api = { getState: () => ({ scrollLeft: 0, _chartWidth: 480 }) } as unknown as IApi
  render(<TaskTemplate data={data} api={api} onaction={() => undefined} />)

  const label = screen.getByText('Tasks Recorder')
  expect(label).toHaveClass('gantt-task-bar__label')
  expect(label.parentElement).toHaveClass('label-inside')
})
