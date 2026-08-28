import type { IColumnConfig } from '@svar-ui/react-gantt'

import type { TaskGanttRow } from './task-types'

interface CellProps { row: unknown }

function taskRow(row: unknown) {
  return row as TaskGanttRow
}

export type TaskColumnId = 'text' | 'activity' | 'status' | 'workspace' | 'branch' | 'session_id'
export type TaskColumnWidths = Record<TaskColumnId, number>

export const DEFAULT_TASK_COLUMN_WIDTHS: TaskColumnWidths = {
  text: 240,
  activity: 96,
  status: 104,
  workspace: 176,
  branch: 116,
  session_id: 156,
}

const STATUS_LABELS = {
  planned: '待安排', active: '进行中', waiting: '等待中', blocked: '已阻塞',
  done: '已完成', canceled: '已取消',
}

function relativeActivity(value: string | null) {
  if (!value) return '—'
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 60_000))
  if (!Number.isFinite(minutes)) return '—'
  if (minutes < 60) return `${minutes}m`
  if (minutes < 1_440) return `${Math.floor(minutes / 60)}h`
  if (minutes < 7_200) return `${Math.floor(minutes / 1_440)}d`
  return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' }).format(new Date(value))
}

function TaskCell({ row: sourceRow }: CellProps) {
  const row = taskRow(sourceRow)
  return (
    <span className="gantt-task-cell" data-entity-type={row.entity_type} data-task-id={row.id}>
      <span className="gantt-task-cell__title">{row.text}</span>
    </span>
  )
}

function ActivityCell({ row: sourceRow }: CellProps) {
  const row = taskRow(sourceRow)
  return <span className="gantt-activity-cell">{relativeActivity(row.last_activity)}</span>
}

function StatusCell({ row: sourceRow }: CellProps) {
  const row = taskRow(sourceRow)
  const label = STATUS_LABELS[row.status]
  if (row.status_indicator === 'bar') {
    return (
      <span className="gantt-group-progress" aria-label={`${label} ${row.progress_count ?? ''}`.trim()}>
        <span className="gantt-group-progress__track" aria-hidden="true">
          <span style={{ width: `${row.progress ?? 0}%` }} />
        </span>
        <span>{row.progress_count ?? '—'}</span>
      </span>
    )
  }
  return (
    <span className="gantt-leaf-status" data-indicator={row.status_indicator} data-status={row.status}>
      <span aria-hidden="true" />
      <span>{label}</span>
    </span>
  )
}

function ContextCell({ value, label }: { value: string | null; label: string }) {
  return value
    ? <span className="gantt-context-cell" aria-label={`${label}：${value}`}>{value}</span>
    : <span className="gantt-context-cell is-empty">—</span>
}

function WorkspaceCell({ row: sourceRow }: CellProps) {
  const row = taskRow(sourceRow)
  return <ContextCell value={row.workspace} label="Workspace" />
}

function BranchCell({ row: sourceRow }: CellProps) {
  const row = taskRow(sourceRow)
  return <ContextCell value={row.branch} label="Branch" />
}

function SessionCell({ row: sourceRow }: CellProps) {
  const row = taskRow(sourceRow)
  return <ContextCell value={row.session_id} label="Session ID" />
}

export function resizeTaskColumn(
  widths: TaskColumnWidths,
  id: TaskColumnId,
  requestedWidth: number,
): TaskColumnWidths {
  const minimum = id === 'text' ? 160 : id === 'workspace' ? 120 : 72
  const maximum = id === 'text' ? 520 : id === 'workspace' ? 420 : 320
  return {
    ...widths,
    [id]: Math.round(Math.min(maximum, Math.max(minimum, requestedWidth))),
  }
}

export function createTaskColumns(widths: TaskColumnWidths): IColumnConfig[] {
  return [
    { id: 'text', header: '任务', width: widths.text, resize: true, cell: TaskCell },
    { id: 'activity', header: '最近活跃', width: widths.activity, resize: true, align: 'right', cell: ActivityCell },
    { id: 'status', header: '进度', width: widths.status, resize: true, align: 'center', cell: StatusCell },
    { id: 'workspace', header: 'Workspace', width: widths.workspace, resize: true, cell: WorkspaceCell },
    { id: 'branch', header: 'Branch', width: widths.branch, resize: true, cell: BranchCell },
    { id: 'session_id', header: 'Session ID', width: widths.session_id, resize: true, cell: SessionCell },
  ]
}
