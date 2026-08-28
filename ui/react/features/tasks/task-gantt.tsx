import { Gantt, type IApi, type ITask } from '@svar-ui/react-gantt'
import '@svar-ui/react-gantt/all.css'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import type { DashboardSnapshot } from '@/lib/api/types'
import type { TaskStatus } from '@/lib/api/types'
import {
  createTaskColumns,
  DEFAULT_TASK_COLUMN_WIDTHS,
  resizeTaskColumn,
  type TaskColumnId,
  type TaskColumnWidths,
} from './task-columns'
import { projectTaskSnapshot } from './task-projection'
import type { TaskGanttRow, TimelineZoom } from './task-types'

const ROW_HEIGHT = 30
const SCALE_HEIGHT = 24

function TaskBar({ data: sourceData }: {
  data: ITask
  api: IApi
  onaction: (event: { action: string; data: Record<string, unknown> }) => void
}) {
  const data = sourceData as TaskGanttRow
  return (
    <div
      className="gantt-task-bar"
      data-entity-type={data.entity_type}
      data-task-id={data.id}
      data-task-kind={data.type}
      data-status={data.status}
      data-planned-pattern={data.planned_pattern ?? undefined}
    />
  )
}

export function TaskGantt({
  snapshot,
  zoom = 'auto',
  onTaskSelect = () => undefined,
  onTaskResume = () => undefined,
  onStatusChange = () => undefined,
  onArchive = () => undefined,
  onColumnResize = () => undefined,
  openIds: controlledOpenIds,
  onOpenIdsChange = () => undefined,
  selectedTaskId = null,
  pendingTaskIds = new Set<string>(),
  todayRequest = 0,
}: {
  snapshot: DashboardSnapshot
  zoom?: TimelineZoom
  onTaskSelect?: (taskId: string) => void
  onTaskResume?: (taskId: string) => void
  onStatusChange?: (taskId: string, status: TaskStatus) => void
  onArchive?: (taskId: string) => void
  onColumnResize?: (id: TaskColumnId, width: number) => void
  openIds?: ReadonlySet<string> | null
  onOpenIdsChange?: (ids: Set<string>) => void
  selectedTaskId?: string | null
  pendingTaskIds?: ReadonlySet<string>
  todayRequest?: number
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const apiRef = useRef<IApi | null>(null)
  const eventTag = useRef(`tasks-recorder-react-${Math.random().toString(36).slice(2)}`)
  const [viewportWidth, setViewportWidth] = useState(900)
  const [internalOpenIds, setInternalOpenIds] = useState<Set<string> | null>(null)
  const openIds = controlledOpenIds === undefined ? internalOpenIds : controlledOpenIds
  const [columnWidths, setColumnWidths] = useState<TaskColumnWidths>(DEFAULT_TASK_COLUMN_WIDTHS)
  const model = useMemo(() => projectTaskSnapshot(snapshot, {
    viewportWidth,
    openIds,
    zoom,
  }), [openIds, snapshot, viewportWidth, zoom])
  const columns = useMemo(() => createTaskColumns(columnWidths, {
    pendingTaskIds,
    onTaskSelect,
    onTaskResume,
    onStatusChange,
    onArchive,
  }), [columnWidths, onArchive, onStatusChange, onTaskResume, onTaskSelect, pendingTaskIds])
  const gridWidth = Math.round(Math.min(720, Math.max(480, viewportWidth * 0.48)))

  useLayoutEffect(() => {
    const host = hostRef.current
    if (!host) return undefined
    const update = () => setViewportWidth(Math.max(320, host.clientWidth || 900))
    update()
    const observer = new ResizeObserver(update)
    observer.observe(host)
    return () => observer.disconnect()
  }, [])

  useEffect(() => () => apiRef.current?.detach(eventTag.current), [])

  useEffect(() => {
    if (!todayRequest || !apiRef.current) return
    const unitMs = model.scale.lengthUnit === 'hour' ? 60 * 60_000 : 24 * 60 * 60_000
    const offset = ((Date.now() - model.scale.start.getTime()) / unitMs) * model.scale.cellWidth
    const chartWidth = Math.max(240, viewportWidth - gridWidth)
    void apiRef.current.exec('scroll-chart', { left: Math.max(0, offset - chartWidth / 2) })
  }, [gridWidth, model.scale, todayRequest, viewportWidth])

  const initialize = useCallback((api: IApi) => {
    apiRef.current?.detach(eventTag.current)
    apiRef.current = api
    api.on('select-task', ({ id }: { id: string | number }) => onTaskSelect(String(id)), {
      tag: eventTag.current,
    })
    api.on('open-task', ({ id, mode }: { id: string | number; mode: boolean }) => {
      const update = (current: ReadonlySet<string> | null) => {
        const next = new Set(current ?? model.rows.filter(({ type }) => type === 'summary').map(({ id }) => id))
        if (mode) next.add(String(id))
        else next.delete(String(id))
        onOpenIdsChange(next)
        return next
      }
      if (controlledOpenIds === undefined) setInternalOpenIds(update)
      else update(controlledOpenIds)
    }, { tag: eventTag.current })
    api.on('resize-column', ({ id, width }: { id: TaskColumnId; width: number }) => {
      setColumnWidths((current) => resizeTaskColumn(current, id, width))
      onColumnResize(id, width)
    }, { tag: eventTag.current })
  }, [controlledOpenIds, model.rows, onColumnResize, onOpenIdsChange, onTaskSelect])

  if (model.empty) {
    return (
      <div className="tasks-empty-state" role="status">
        <strong>暂无任务</strong>
        <span>Agent 开始工作后，项目周期会出现在这里。</span>
      </div>
    )
  }

  return (
    <div className="tasks-gantt" ref={hostRef} data-scale={model.scale.id}>
      <div className="wx-willow-dark-theme tasks-gantt__theme">
        <Gantt
          tasks={model.rows}
          links={model.links}
          columns={columns}
          scales={model.scale.scales}
          start={model.scale.start}
          end={model.scale.end}
          lengthUnit={model.scale.lengthUnit}
          cellWidth={model.scale.cellWidth}
          cellHeight={ROW_HEIGHT}
          scaleHeight={SCALE_HEIGHT}
          taskTemplate={TaskBar}
          readonly
          baselines
          splitTasks
          displayMode="all"
          gridWidth={gridWidth}
          init={initialize}
          selected={selectedTaskId ? [selectedTaskId] : []}
        />
      </div>
    </div>
  )
}
