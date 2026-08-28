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

function estimatedTimelineLabelWidth(text: string) {
  const width = Array.from(text).reduce(
    (total, character) => total + (/[^\x00-\xff]/.test(character) ? 11 : 6.4),
    0,
  )
  return Math.min(220, Math.max(80, Math.ceil(width + 18)))
}

function timelineLabelPlacement(data: TaskGanttRow, api: IApi) {
  const state = api.getState()
  const barLeft = Number.isFinite(data.$x) ? data.$x : 0
  const barWidth = Number.isFinite(data.$w) ? data.$w : 0
  const scrollLeft = typeof state.scrollLeft === 'number' && Number.isFinite(state.scrollLeft)
    ? state.scrollLeft
    : 0
  const clientWidth = typeof state._chartWidth === 'number' && Number.isFinite(state._chartWidth)
    ? state._chartWidth
    : 0
  const labelWidth = estimatedTimelineLabelWidth(data.text)
  const visibleStart = Math.max(barLeft, scrollLeft)
  const visibleEnd = Math.min(barLeft + barWidth, scrollLeft + clientWidth)
  if (Math.max(0, visibleEnd - visibleStart) >= labelWidth) return 'inside'
  return barLeft + barWidth + labelWidth + 12 > scrollLeft + clientWidth ? 'left' : 'right'
}

function TaskBar({ data: sourceData, api, labelsVisible }: {
  data: ITask
  api: IApi
  onaction: (event: { action: string; data: Record<string, unknown> }) => void
  labelsVisible: boolean
}) {
  const data = sourceData as TaskGanttRow
  const placement = timelineLabelPlacement(data, api)
  return (
    <div
      className={`gantt-task-bar label-${placement}`}
      data-entity-type={data.entity_type}
      data-task-id={data.id}
      data-task-kind={data.type}
      data-status={data.status}
      data-planned-pattern={data.planned_pattern ?? undefined}
    >
      {labelsVisible ? <span className="gantt-task-bar__label">{data.text}</span> : null}
    </div>
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
  nowRequest = 0,
  labelsVisible = true,
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
  nowRequest?: number
  labelsVisible?: boolean
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const nowMarkerRef = useRef<HTMLDivElement>(null)
  const apiRef = useRef<IApi | null>(null)
  const eventTag = useRef(`tasks-recorder-react-${Math.random().toString(36).slice(2)}`)
  const [viewportWidth, setViewportWidth] = useState(900)
  const [now, setNow] = useState(() => new Date())
  const [internalOpenIds, setInternalOpenIds] = useState<Set<string> | null>(null)
  const openIds = controlledOpenIds === undefined ? internalOpenIds : controlledOpenIds
  const [columnWidths, setColumnWidths] = useState<TaskColumnWidths>(DEFAULT_TASK_COLUMN_WIDTHS)
  const model = useMemo(() => projectTaskSnapshot(snapshot, {
    viewportWidth,
    openIds,
    zoom,
    now,
  }), [now, openIds, snapshot, viewportWidth, zoom])
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

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60_000)
    return () => window.clearInterval(timer)
  }, [])

  const updateNowMarker = useCallback(() => {
    const host = hostRef.current
    const marker = nowMarkerRef.current
    const chart = host?.querySelector<HTMLElement>('.wx-chart')
    const scale = chart?.querySelector<HTMLElement>('.wx-scale')
    const state = apiRef.current?.getState()
    const timeline = state?._scales
    if (!host || !marker || !chart || !scale || !timeline) {
      if (marker) marker.hidden = true
      return
    }

    const start = timeline.start.getTime()
    const end = timeline.end.getTime()
    const ratio = (now.getTime() - start) / (end - start)
    const contentX = ratio * timeline.width
    const visibleX = contentX - chart.scrollLeft
    const hostRect = host.getBoundingClientRect()
    const chartRect = chart.getBoundingClientRect()
    const scaleRect = scale.getBoundingClientRect()
    const visible = Number.isFinite(visibleX)
      && ratio >= 0
      && ratio <= 1
      && visibleX >= 0
      && visibleX <= chart.clientWidth

    marker.hidden = !visible
    if (!visible) return
    marker.style.left = `${Math.round(chartRect.left - hostRect.left + visibleX)}px`
    marker.style.top = `${Math.round(scaleRect.bottom - hostRect.top)}px`
    marker.style.height = `${Math.max(0, Math.round(chartRect.bottom - scaleRect.bottom))}px`
  }, [now])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return undefined
    let frame = 0
    const scheduleUpdate = () => {
      if (frame) return
      frame = window.requestAnimationFrame(() => {
        frame = 0
        updateNowMarker()
      })
    }
    const observer = new ResizeObserver(scheduleUpdate)
    const mutations = new MutationObserver(scheduleUpdate)
    observer.observe(host)
    const chart = host.querySelector<HTMLElement>('.wx-chart')
    const area = chart?.querySelector<HTMLElement>('.wx-area')
    if (chart) observer.observe(chart)
    if (area) observer.observe(area)
    mutations.observe(host, { childList: true, subtree: true })
    host.addEventListener('scroll', scheduleUpdate, true)
    scheduleUpdate()
    return () => {
      if (frame) window.cancelAnimationFrame(frame)
      observer.disconnect()
      mutations.disconnect()
      host.removeEventListener('scroll', scheduleUpdate, true)
    }
  }, [model.scale, updateNowMarker])

  useEffect(() => () => apiRef.current?.detach(eventTag.current), [])

  useEffect(() => {
    if (!nowRequest || !apiRef.current) return
    const state = apiRef.current.getState()
    const timeline = state._scales
    if (!timeline) return
    const ratio = (now.getTime() - timeline.start.getTime())
      / (timeline.end.getTime() - timeline.start.getTime())
    const offset = ratio * timeline.width
    const chartWidth = state._chartWidth ?? Math.max(240, viewportWidth - gridWidth)
    void apiRef.current.exec('scroll-chart', { left: Math.max(0, offset - chartWidth / 2) })
      .then(() => window.requestAnimationFrame(updateNowMarker))
  }, [gridWidth, now, nowRequest, updateNowMarker, viewportWidth])

  const initialize = useCallback((api: IApi) => {
    apiRef.current?.detach(eventTag.current)
    apiRef.current = api
    window.requestAnimationFrame(updateNowMarker)
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
    const scheduleNowMarkerUpdate = () => window.requestAnimationFrame(updateNowMarker)
    api.on('scroll-chart', scheduleNowMarkerUpdate, { tag: eventTag.current })
    api.on('resize-chart', scheduleNowMarkerUpdate, { tag: eventTag.current })
    api.on('resize-grid', scheduleNowMarkerUpdate, { tag: eventTag.current })
  }, [controlledOpenIds, model.rows, onColumnResize, onOpenIdsChange, onTaskSelect, updateNowMarker])

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
          taskTemplate={(props) => <TaskBar {...props} labelsVisible={labelsVisible} />}
          readonly
          baselines
          splitTasks
          displayMode="all"
          gridWidth={gridWidth}
          init={initialize}
          selected={selectedTaskId ? [selectedTaskId] : []}
        />
      </div>
      <div className="tasks-gantt__now-marker" ref={nowMarkerRef} aria-hidden="true" hidden>
        <span>NOW</span>
      </div>
    </div>
  )
}
