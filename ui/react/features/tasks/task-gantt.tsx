import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react'

import type { DashboardSnapshot, TaskStatus } from '@/lib/api/types'
import {
  createTaskColumns, DEFAULT_TASK_COLUMN_WIDTHS, resizeTaskColumn, TaskColumnInteractionsContext,
  type TaskColumn, type TaskColumnId, type TaskColumnWidths,
} from './task-columns'
import { projectTaskSnapshot } from './task-projection'
import { TaskStatusMenuProvider } from './task-status-control'
import { buildTimelineLayout } from './task-timeline-layout'
import type { TaskGanttRow, TimelineZoom } from './task-types'

const NOOP = () => undefined
const EMPTY_TASK_IDS: ReadonlySet<string> = new Set()

type TimelineLayout = ReturnType<typeof buildTimelineLayout>
type VisibleRow = { row: TaskGanttRow; depth: number; expandable: boolean }

function visibleRows(rows: TaskGanttRow[]): VisibleRow[] {
  const parents = new Set(rows.map(row => row.parent))
  const state = new Map<string, { depth: number; visible: boolean; open: boolean }>()
  return rows.flatMap(row => {
    const parent = state.get(String(row.parent))
    const depth = parent ? parent.depth + 1 : 0
    const visible = !parent || (parent.visible && parent.open)
    state.set(row.id, { depth, visible, open: row.open })
    return visible ? [{ row, depth, expandable: parents.has(row.id) }] : []
  })
}

function rangeStyle(layout: TimelineLayout, start: Date, end: Date): CSSProperties {
  const left = layout.position(start)
  return { left, width: Math.max(3, layout.position(end) - left) }
}

const NativeTaskRow = memo(function NativeTaskRow({
  item, columns, layout, labelsVisible, selected, first, toggle, select,
}: {
  item: VisibleRow
  columns: TaskColumn[]
  layout: TimelineLayout
  labelsVisible: boolean
  selected: boolean
  first: boolean
  toggle: (id: string) => void
  select: (id: string) => void
}) {
  const { row, depth, expandable } = item
  const segments = row.segments ?? [{ start: row.start, end: row.end }]
  const barWidth = Math.max(3, layout.position(row.end) - layout.position(row.start))
  const labelWidth = Math.min(220, Math.max(80, row.text.length * 9 + 14))
  const startX = layout.position(row.start)
  const endX = layout.position(row.end)
  const labelInside = barWidth >= labelWidth
  const labelX = labelInside ? startX + 7
    : endX + 8 + labelWidth <= layout.width ? endX + 8 : Math.max(0, startX - labelWidth - 8)
  return (
    <div className="task-native-row" role="row" data-row-id={row.id}
      aria-level={depth + 1} aria-expanded={expandable ? row.open : undefined}
      aria-selected={selected} tabIndex={first ? 0 : -1}>
      <div className="task-grid-pane" role="presentation">
        <div className="task-grid-columns" role="presentation">
          {columns.map(({ id, cell: Cell, align }) => (
            <div className="task-native-cell" role="gridcell" key={id} data-column-id={id} style={{ textAlign: align }}>
              {id === 'text' ? (
                <span className="task-tree-indent" style={{ paddingLeft: depth * 16 }}>
                  {expandable ? <button type="button" className="task-tree-toggle"
                    aria-label={`${row.open ? '折叠' : '展开'} ${row.text}`}
                    aria-expanded={row.open}
                    onClick={() => toggle(row.id)}>
                    <svg aria-hidden="true" width="14" height="14" viewBox="0 0 16 16">
                      <path d="m6 4 4 4-4 4" />
                    </svg>
                  </button>
                    : <span className="task-tree-placeholder" />}
                </span>
              ) : null}
              <Cell row={row} />
            </div>
          ))}
        </div>
      </div>
      <div className="task-timeline-cell" role="gridcell" aria-label={`${row.text} 时间范围`}>
        {row.base_start && row.base_end ? <div className="task-timeline-baseline"
          style={rangeStyle(layout, row.base_start, row.base_end)} /> : null}
        {segments.map((segment, index) => (
          <div key={index} className="task-timeline-segment" data-kind={row.type}
            data-planned={row.planned_pattern ?? undefined}
            style={rangeStyle(layout, segment.start, segment.end)} onClick={() => select(row.id)}>
            {row.type !== 'summary' && !row.planned_pattern ? <span className="task-timeline-progress"
              style={{ width: `${row.progress}%` }} /> : null}
            <div className="gantt-task-bar label-inside" data-entity-type={row.entity_type}
              data-task-id={row.id} data-task-kind={row.type} data-status={row.status}
              data-planned-pattern={row.planned_pattern ?? undefined}>
            </div>
          </div>
        ))}
        {labelsVisible ? <span className="gantt-task-bar__label task-timeline-label"
          style={{ left: labelX, maxWidth: labelInside ? barWidth - 14 : labelWidth }}>{row.text}</span> : null}
      </div>
    </div>
  )
})

function ResizeHandle({ label, value, minimum, maximum, change }: {
  label: string; value: number; minimum: number; maximum: number; change: (value: number) => void
}) {
  const drag = useRef<{ x: number; value: number } | null>(null)
  const bounded = (next: number) => change(Math.round(Math.max(minimum, Math.min(maximum, next))))
  const start = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    drag.current = { x: event.clientX, value }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  return <div className="task-resize-handle" role="separator" tabIndex={0}
    aria-label={label} aria-orientation="vertical" aria-valuenow={Math.round(value)}
    aria-valuemin={minimum} aria-valuemax={maximum}
    onPointerDown={start}
    onPointerMove={event => {
      if (drag.current) bounded(drag.current.value + event.clientX - drag.current.x)
    }}
    onPointerUp={event => { drag.current = null; event.currentTarget.releasePointerCapture(event.pointerId) }}
    onPointerCancel={() => { drag.current = null }}
    onLostPointerCapture={() => { drag.current = null }}
    onKeyDown={event => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
      event.preventDefault()
      bounded(value + (event.key === 'ArrowRight' ? 10 : -10))
    }} />
}

export function TaskGantt({
  snapshot, zoom = 'auto', onTaskSelect = NOOP, onTaskResume = NOOP, onStatusChange = NOOP,
  onArchive = NOOP, onColumnResize = NOOP, openIds: controlledOpenIds, onOpenIdsChange = NOOP,
  selectedTaskId = null, pendingTaskIds = EMPTY_TASK_IDS, nowRequest = 0, labelsVisible = true,
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
  const viewportRef = useRef<HTMLDivElement>(null)
  const gridScrollRef = useRef<HTMLDivElement>(null)
  const [viewportWidth, setViewportWidth] = useState(900)
  const [paneWidth, setPaneWidth] = useState<number | null>(null)
  const [now, setNow] = useState(() => new Date())
  const [internalOpenIds, setInternalOpenIds] = useState<Set<string> | null>(null)
  const [columnWidths, setColumnWidths] = useState<TaskColumnWidths>(DEFAULT_TASK_COLUMN_WIDTHS)
  const openIds = controlledOpenIds === undefined ? internalOpenIds : controlledOpenIds
  const tasks = snapshot.tasks
  const needsSnapshotTime = useMemo(() => tasks.some(task => task.last_activity == null && task.updated_at == null), [tasks])
  const generatedAt = needsSnapshotTime ? snapshot.generated_at : ''
  const gridWidth = Math.min(Math.max(160, viewportWidth - 160), paneWidth ?? Math.max(320, viewportWidth - 400))
  const model = useMemo(() => projectTaskSnapshot({ tasks, generated_at: generatedAt }, {
    viewportWidth, openIds, zoom, now,
  }), [viewportWidth, openIds, zoom, now, tasks, generatedAt])
  const rows = useMemo(() => visibleRows(model.rows), [model.rows])
  const layout = useMemo(() => buildTimelineLayout(model.scale, Math.max(160, viewportWidth - gridWidth)), [model.scale, viewportWidth, gridWidth])
  const columns = useMemo(() => createTaskColumns(columnWidths), [columnWidths])
  const columnsWidth = columns.reduce((sum, column) => sum + column.width, 0)
  const interactions = useMemo(() => ({ pendingTaskIds, onTaskSelect, onTaskResume, onStatusChange, onArchive }),
    [pendingTaskIds, onTaskSelect, onTaskResume, onStatusChange, onArchive])

  useLayoutEffect(() => {
    const host = hostRef.current
    if (!host) return
    const update = () => setViewportWidth(host.clientWidth || 900)
    update()
    const observer = new ResizeObserver(update)
    observer.observe(host)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60_000)
    return () => window.clearInterval(timer)
  }, [])

  const previousNowRequest = useRef(0)
  useEffect(() => {
    if (!nowRequest || previousNowRequest.current === nowRequest || !viewportRef.current) return
    previousNowRequest.current = nowRequest
    viewportRef.current.scrollLeft = Math.max(0, layout.position(new Date()) - (viewportWidth - gridWidth) / 2)
  }, [nowRequest, layout, viewportWidth, gridWidth])

  useLayoutEffect(() => {
    const scrollbar = gridScrollRef.current
    if (scrollbar) hostRef.current?.style.setProperty('--task-grid-offset', `${-scrollbar.scrollLeft}px`)
  }, [gridWidth, columnsWidth])

  const toggle = useCallback((id: string) => {
    const next = new Set(openIds ?? model.rows.filter(row => row.open).map(row => row.id))
    if (next.has(id)) next.delete(id)
    else next.add(id)
    if (controlledOpenIds === undefined) setInternalOpenIds(next)
    onOpenIdsChange(next)
  }, [openIds, model.rows, controlledOpenIds, onOpenIdsChange])

  const navigate = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement
    if (!target.matches('[data-row-id]')) return
    const index = rows.findIndex(item => item.row.id === target.dataset.rowId)
    const item = rows[index]
    if (!item) return
    let next = index
    if (event.key === 'ArrowDown') next++
    else if (event.key === 'ArrowUp') next--
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = rows.length - 1
    else if (event.key === 'Enter') onTaskSelect(item.row.id)
    else if (event.key === 'ArrowRight') {
      if (item.expandable && !item.row.open) toggle(item.row.id)
      else if (item.expandable) next++
    } else if (event.key === 'ArrowLeft') {
      if (item.expandable && item.row.open) toggle(item.row.id)
      else {
        const parentIndex = rows.findIndex(candidate => candidate.row.id === item.row.parent)
        if (parentIndex >= 0) next = parentIndex
      }
    } else return
    event.preventDefault()
    const elements = viewportRef.current?.querySelectorAll<HTMLElement>('[data-row-id]')
    const element = elements?.[Math.max(0, Math.min(rows.length - 1, next))]
    if (element) {
      target.tabIndex = -1
      element.tabIndex = 0
      element.focus({ preventScroll: true })
      const viewport = viewportRef.current!
      const y = element.offsetTop
      if (y < viewport.scrollTop + 48) viewport.scrollTop = y - 48
      else if (y + 30 > viewport.scrollTop + viewport.clientHeight) viewport.scrollTop = y + 30 - viewport.clientHeight
    }
  }

  const nowX = layout.position(now)
  const style = {
    '--task-grid-width': `${gridWidth}px`,
    '--task-columns-width': `${columnsWidth}px`,
    '--task-columns': columns.map(column => column.id === 'workspace'
      ? `minmax(${column.width}px, 1fr)` : `${column.width}px`).join(' '),
    '--task-timeline-width': `${layout.width}px`,
  } as CSSProperties

  return (
    <TaskStatusMenuProvider>
      <TaskColumnInteractionsContext.Provider value={interactions}>
        <div className="tasks-gantt" ref={hostRef} data-scale={model.scale.id} style={style}>
          {model.empty ? <div className="tasks-empty-state" role="status">
            <strong>暂无任务</strong><span>Agent 开始工作后，项目周期会出现在这里。</span>
          </div> : <>
            <div className="task-scroll-viewport" role="treegrid" aria-label="任务时间线"
              aria-colcount={7} ref={viewportRef} onKeyDown={navigate}
              onFocusCapture={event => {
                const target = event.target as HTMLElement
                if (target.matches('[data-row-id]')) {
                  viewportRef.current?.querySelectorAll<HTMLElement>('[data-row-id]').forEach(row => {
                    row.tabIndex = row === target ? 0 : -1
                  })
                }
                if (!target.closest('.task-grid-pane')) return
                const scrollbar = gridScrollRef.current
                const host = hostRef.current
                if (!scrollbar || !host) return
                const rect = target.getBoundingClientRect()
                const left = host.getBoundingClientRect().left
                if (rect.left < left) scrollbar.scrollLeft += rect.left - left - 4
                else if (rect.right > left + gridWidth) scrollbar.scrollLeft += rect.right - left - gridWidth + 4
                host.style.setProperty('--task-grid-offset', `${-scrollbar.scrollLeft}px`)
              }}>
              <div className="task-scroll-content">
                <div className="task-timeline-guides" aria-hidden="true">
                  {layout.ticks.at(-1)?.map(tick => <span key={tick.key} style={{ left: tick.left }} />)}
                </div>
                <div className="task-native-header" role="row">
                  <div className="task-grid-pane" role="presentation">
                    <div className="task-grid-columns" role="presentation">
                      {columns.map(column => <div className="task-native-heading" role="columnheader" key={column.id}>
                        {column.header}
                        <ResizeHandle label={`调整${column.header}列宽`} value={column.width}
                          minimum={column.id === 'text' ? 160 : column.id === 'workspace' ? 120 : 72}
                          maximum={column.id === 'text' ? 520 : column.id === 'workspace' ? 420 : 320}
                          change={value => {
                            const next = resizeTaskColumn(columnWidths, column.id, value)
                            setColumnWidths(next)
                            onColumnResize(column.id, next[column.id])
                          }} />
                      </div>)}
                    </div>
                  </div>
                  <div className="task-time-heading" role="columnheader" aria-label="时间线">
                    {layout.ticks.map((ticks, index) => <div className="task-time-scale" key={index} aria-hidden="true">
                      {ticks.map(tick => <span key={tick.key} style={{ left: tick.left, width: tick.width }}>{tick.label}</span>)}
                    </div>)}
                  </div>
                </div>
                {rows.map((item, index) => <NativeTaskRow key={item.row.id} item={item} columns={columns}
                  layout={layout} labelsVisible={labelsVisible} selected={item.row.id === selectedTaskId}
                  first={index === 0} toggle={toggle} select={onTaskSelect} />)}
                {now >= model.scale.start && now <= model.scale.end ? <div className="task-native-now" aria-hidden="true"
                  style={{ left: gridWidth + nowX }}><span>NOW</span></div> : null}
              </div>
            </div>
            <div className="task-pane-resizer" style={{ left: gridWidth - 3 }}>
              <ResizeHandle label="调整任务与时间线分栏" value={gridWidth} minimum={160}
                maximum={Math.max(160, viewportWidth - 160)} change={setPaneWidth} />
            </div>
            <div className="task-grid-scrollbar" ref={gridScrollRef} tabIndex={0} role="region" aria-label="任务列横向滚动"
              onScroll={event => hostRef.current?.style.setProperty('--task-grid-offset', `${-event.currentTarget.scrollLeft}px`)}>
              <div style={{ width: columnsWidth, height: 1 }} />
            </div>
          </>}
        </div>
      </TaskColumnInteractionsContext.Provider>
    </TaskStatusMenuProvider>
  )
}
