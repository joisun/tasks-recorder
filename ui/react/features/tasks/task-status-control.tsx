import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { TaskStatus } from '@/lib/api/types'
import type { TaskGanttRow } from './task-types'

export const STATUS_LABELS: Record<TaskStatus, string> = {
  planned: '待安排',
  active: '进行中',
  waiting: '等待中',
  blocked: '已阻塞',
  done: '已完成',
  canceled: '已取消',
}

const STATUS_ORDER = Object.keys(STATUS_LABELS) as TaskStatus[]

function StatusIndicator({ row }: { row: TaskGanttRow }) {
  if (row.status_indicator === 'bar') {
    return (
      <span className="gantt-group-progress" aria-label={`${STATUS_LABELS[row.status]} ${row.progress_count ?? ''}`.trim()}>
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
      <span>{STATUS_LABELS[row.status]}</span>
    </span>
  )
}

export function TaskStatusControl({
  row,
  disabled = false,
  onStatusChange = () => undefined,
  onArchive = () => undefined,
}: {
  row: TaskGanttRow
  disabled?: boolean
  onStatusChange?: (taskId: string, status: TaskStatus) => void
  onArchive?: (taskId: string) => void
}) {
  if (row.type === 'summary' || row.entity_type === 'project') return <StatusIndicator row={row} />
  const canArchive = !row.source.archived_at && ['done', 'canceled'].includes(row.status)

  return (
    <span
      className="gantt-native-status"
      data-indicator={row.status_indicator}
      data-status={row.status}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      <span aria-hidden="true" />
      <Select
        aria-label={`修改“${row.text}”状态，当前${STATUS_LABELS[row.status]}`}
        isDisabled={disabled}
        selectedKey={row.status}
        onSelectionChange={(key) => {
          const value = String(key)
          if (value === 'archive') onArchive(row.id)
          else onStatusChange(row.id, value as TaskStatus)
        }}
      >
        <SelectTrigger className="gantt-native-status__trigger" size="xs" variant="quiet">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
        {STATUS_ORDER.map((status) => (
          <SelectItem id={status} key={status}>{STATUS_LABELS[status]}</SelectItem>
        ))}
        {canArchive ? <SelectItem id="archive">归档任务</SelectItem> : null}
        </SelectContent>
      </Select>
    </span>
  )
}
