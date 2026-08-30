import type { IColumnConfig } from '@svar-ui/react-gantt'
import { Terminal } from 'lucide-react'

import { Button } from '@/components/ui/button'
import type { TaskStatus } from '@/lib/api/types'
import { ContextCell } from './context-cell'
import { TaskStatusControl } from './task-status-control'
import type { TaskGanttRow } from './task-types'

interface CellProps { row: unknown }

function taskRow(row: unknown) {
  return row as TaskGanttRow
}

export type TaskColumnId = 'text' | 'activity' | 'status' | 'workspace' | 'branch' | 'session_id'
export type TaskColumnWidths = Record<TaskColumnId, number>

export const DEFAULT_TASK_COLUMN_WIDTHS: TaskColumnWidths = {
  text: 300,
  activity: 96,
  status: 104,
  workspace: 176,
  branch: 116,
  session_id: 156,
}

export function relativeActivity(value: string | null, now = Date.now()) {
  if (!value) return '—'
  const minutes = Math.max(0, Math.floor((now - Date.parse(value)) / 60_000))
  if (!Number.isFinite(minutes)) return '—'
  if (minutes < 60) return `${minutes}m ago`
  if (minutes < 1_440) return `${Math.floor(minutes / 60)}h ago`
  if (minutes < 7_200) return `${Math.floor(minutes / 1_440)}d ago`
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(value))
}

interface TaskColumnInteractions {
  pendingTaskIds?: ReadonlySet<string>
  onTaskSelect?: (taskId: string) => void
  onTaskResume?: (taskId: string) => void
  onStatusChange?: (taskId: string, status: TaskStatus) => void
  onArchive?: (taskId: string) => void
}

function TaskCell({ row: sourceRow, interactions }: CellProps & { interactions: TaskColumnInteractions }) {
  const row = taskRow(sourceRow)
  return (
    <span className="gantt-task-cell" data-entity-type={row.entity_type} data-task-id={row.id}>
      <Button
        className="gantt-task-cell__title"
        data-task-details-id={row.id}
        type="button"
        size="xs"
        variant="quiet"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
        onPress={() => interactions.onTaskSelect?.(row.id)}
      >{row.text}</Button>
      {row.source.resume_available && row.workspace && row.session_id ? (
        <Button
          aria-label={`在终端恢复“${row.text}”`}
          className="gantt-task-cell__resume"
          isDisabled={interactions.pendingTaskIds?.has(row.id)}
          isIconOnly
          size="xs"
          type="button"
          variant="quiet"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
          onPress={() => interactions.onTaskResume?.(row.id)}
        ><Terminal /></Button>
      ) : null}
    </span>
  )
}

function ActivityCell({ row: sourceRow }: CellProps) {
  const row = taskRow(sourceRow)
  return <span className="gantt-activity-cell">{relativeActivity(row.last_activity)}</span>
}

function StatusCell({ row: sourceRow, interactions }: CellProps & { interactions: TaskColumnInteractions }) {
  const row = taskRow(sourceRow)
  return (
    <TaskStatusControl
      row={row}
      disabled={interactions.pendingTaskIds?.has(row.id)}
      onArchive={interactions.onArchive}
      onStatusChange={interactions.onStatusChange}
    />
  )
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

export function createTaskColumns(
  widths: TaskColumnWidths,
  interactions: TaskColumnInteractions = {},
): IColumnConfig[] {
  return [
    { id: 'text', header: '任务', width: widths.text, resize: true, cell: (props: CellProps) => <TaskCell {...props} interactions={interactions} /> },
    { id: 'activity', header: '最近活跃', width: widths.activity, resize: true, align: 'right', cell: ActivityCell },
    { id: 'status', header: '进度', width: widths.status, resize: true, align: 'center', cell: (props: CellProps) => <StatusCell {...props} interactions={interactions} /> },
    { id: 'workspace', header: 'Workspace', width: widths.workspace, flexgrow: 1, resize: true, cell: WorkspaceCell },
    { id: 'branch', header: 'Branch', width: widths.branch, resize: true, cell: BranchCell },
    { id: 'session_id', header: 'Session ID', width: widths.session_id, resize: true, cell: SessionCell },
  ]
}
