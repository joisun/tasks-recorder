import React from 'react'
import { createRoot } from 'react-dom/client'
import { Gantt } from '@svar-ui/react-gantt'
import '@svar-ui/react-gantt/all.css'

import {
  currentTimeOverlayModel,
  separatorWidthFromKey,
  timelineLocateShouldDefer,
} from './current-time-overlay.mjs'
import { rendererErrorPresentation } from './renderer-error-state.mjs'
import { SVAR_ROW_HEIGHT, SVAR_SCALE_HEIGHT } from './svar-gantt-state.mjs'
import {
  ActivityCell,
  AgentsCell,
  BranchCell,
  ExecutionContextCell,
  ExecutionsCell,
  NoteCell,
  SessionCell,
  StatusCell,
  TaskBar,
  TaskCell,
  WorkfolderCell,
  WorktreeCell,
} from './svar-gantt-cells.mjs'

const CELL_COMPONENTS = {
  text: TaskCell,
  status: StatusCell,
  execution_context: ExecutionContextCell,
  session_id: SessionCell,
  workfolder: WorkfolderCell,
  worktree: WorktreeCell,
  branch: BranchCell,
  note: NoteCell,
  active_agent_count: AgentsCell,
  execution_count: ExecutionsCell,
  activity: ActivityCell,
}

const DEFAULT_VIEW = Object.freeze({
  displayMode: 'all',
  gridWidth: 792,
  labelsVisible: false,
})

class RendererErrorBoundary extends React.Component {
  state = { error: null }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error) {
    this.props.onError(error)
  }

  componentDidUpdate(previousProps) {
    if (previousProps.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null })
    }
  }

  render() {
    if (!this.state.error) return this.props.children
    const presentation = rendererErrorPresentation(this.state.error)
    return (
      <div className="renderer-error-state" role="alert">
        <strong>{presentation.title}</strong>
        <span>{presentation.message}</span>
      </div>
    )
  }
}

export function createSvarGanttRenderer({
  element,
  onReady = () => {},
  onGridResize = () => {},
  onTaskOpenChange = () => {},
  onTaskSelected = () => {},
  onScroll = () => {},
  onError = (error) => {
    const { logMessage } = rendererErrorPresentation(error)
    console.error('[tasks-recorder] SVAR renderer failed:', logMessage)
  },
}) {
  if (!(element instanceof Element)) {
    throw new TypeError('SVAR Gantt requires a DOM mount element')
  }

  const root = createRoot(element)
  let api = null
  let destroyed = false
  let model = { tasks: [], columns: [], scales: [] }
  let view = { ...DEFAULT_VIEW }
  let restoreFrame = 0
  let overlayFrame = 0
  let pendingLocateDate = null
  let renderRevision = 0
  const eventTag = `tasks-recorder-${Math.random().toString(36).slice(2)}`

  function scheduleOverlayUpdate() {
    if (overlayFrame || destroyed) return
    overlayFrame = requestAnimationFrame(() => {
      overlayFrame = 0
      updateOverlays()
    })
  }

  function updateOverlays() {
    const shell = element.querySelector('.svar-gantt-shell')
    const separator = element.querySelector('[data-dashboard-separator]')
    const marker = element.querySelector('[data-current-time-marker]')
    const chart = element.querySelector('.wx-chart')
    if (!shell || !separator || !marker) return

    const state = api?.getState?.() ?? {}
    const gridWidth = Number.isFinite(state.gridWidth) ? state.gridWidth : view.gridWidth
    const displayMode = state.displayMode ?? view.displayMode
    separator.style.left = `${Math.max(0, Math.round(gridWidth) - 2)}px`
    separator.setAttribute('aria-valuenow', String(Math.round(gridWidth)))
    separator.setAttribute('aria-valuemax', String(Math.max(240, element.clientWidth - 329)))
    separator.hidden = displayMode !== 'all'

    if (!chart || displayMode !== 'all') {
      marker.hidden = true
      return
    }

    const shellRect = shell.getBoundingClientRect()
    const chartRect = chart.getBoundingClientRect()
    const area = chart.querySelector('.wx-area')
    const contentWidth = state._scales?.width ?? area?.scrollWidth ?? chart.scrollWidth
    const markerModel = currentTimeOverlayModel({
      now: new Date(),
      timelineStart: model.start,
      timelineEnd: model.end,
      contentWidth,
      scrollLeft: Number.isFinite(state.scrollLeft) ? state.scrollLeft : chart.scrollLeft,
      viewportWidth: chart.clientWidth,
      chartLeft: chartRect.left - shellRect.left,
    })
    marker.hidden = !markerModel.visible
    if (markerModel.visible) marker.style.left = `${markerModel.left}px`
  }

  function restoreView() {
    if (!api || destroyed) return
    api.exec('set-display-mode', { mode: view.displayMode })
    api.exec('resize-grid', { width: view.gridWidth })
    for (const task of model.tasks) {
      if (task.type === 'summary') api.exec('open-task', { id: task.id, mode: Boolean(task.open) })
    }
    api.exec('scroll-chart', { left: view.timelineX ?? 0, top: view.verticalY ?? 0 })
    const gridScroller = element.querySelector('.wx-table-container')
    if (gridScroller) gridScroller.scrollLeft = view.gridX ?? 0
    if (view.selectedTaskId) api.exec('select-task', { id: view.selectedTaskId })
    if (pendingLocateDate) {
      api.exec('scroll-chart', { date: pendingLocateDate })
      pendingLocateDate = null
    }
    scheduleOverlayUpdate()
  }

  function scheduleRestore() {
    if (restoreFrame) cancelAnimationFrame(restoreFrame)
    restoreFrame = requestAnimationFrame(() => {
      restoreFrame = requestAnimationFrame(() => {
        restoreFrame = 0
        restoreView()
      })
    })
  }

  function initializeApi(nextApi) {
    if (api && api !== nextApi) api.detach(eventTag)
    api = nextApi
    api.on('resize-grid', ({ width }) => {
      view = { ...view, gridWidth: width }
      onGridResize(width)
      scheduleOverlayUpdate()
    }, { tag: eventTag })
    api.on('set-display-mode', ({ mode }) => {
      view = { ...view, displayMode: mode }
      scheduleOverlayUpdate()
    }, { tag: eventTag })
    api.on('open-task', ({ id, mode }) => {
      onTaskOpenChange(String(id), Boolean(mode))
    }, { tag: eventTag })
    api.on('select-task', ({ id }) => {
      view = { ...view, selectedTaskId: String(id) }
      onTaskSelected(String(id))
    }, { tag: eventTag })
    api.on('scroll-chart', ({ left, top }) => {
      if (Number.isFinite(left)) view = { ...view, timelineX: left }
      if (Number.isFinite(top)) view = { ...view, verticalY: top }
      onScroll({ left, top })
      scheduleOverlayUpdate()
    }, { tag: eventTag })
    onReady(nextApi)
    scheduleRestore()
  }

  function handleKeyboard(event) {
    const separator = event.target.closest?.('[data-dashboard-separator]')
    if (separator) {
      const width = separatorWidthFromKey({
        key: event.key,
        width: api?.getState?.().gridWidth ?? view.gridWidth,
        containerWidth: element.clientWidth,
      })
      if (width === null) return
      event.preventDefault()
      event.stopPropagation()
      view = { ...view, gridWidth: width }
      api?.exec('resize-grid', { width })
      scheduleOverlayUpdate()
      return
    }

    const trigger = event.target.closest?.('[data-task-toggle-id]')
    if (!trigger || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return
    const task = api?.getTask(trigger.dataset.taskToggleId)
    if (!task) return
    const open = event.key === 'ArrowRight'
    if (Boolean(task.open) === open) return
    event.preventDefault()
    event.stopPropagation()
    api.exec('open-task', { id: task.id, mode: open })
  }

  function handleGridScroll(event) {
    if (!event.target.matches?.('.wx-table-container')) return
    view = { ...view, gridX: event.target.scrollLeft }
  }

  element.addEventListener('keydown', handleKeyboard)
  element.addEventListener('scroll', handleGridScroll, true)
  const resizeObserver = new ResizeObserver(scheduleOverlayUpdate)
  resizeObserver.observe(element)
  const markerTimer = window.setInterval(scheduleOverlayUpdate, 30_000)

  function mount() {
    if (destroyed) throw new Error('SVAR Gantt renderer has been destroyed')
    const columns = model.columns.map((column) => ({
      ...column,
      cell: CELL_COMPONENTS[column.id] ?? column.cell,
    }))
    renderRevision += 1
    root.render(
      <RendererErrorBoundary resetKey={renderRevision} onError={onError}>
        <div className="svar-gantt-shell">
          <div className="wx-willow-dark-theme svar-theme-root">
            <Gantt
              tasks={model.tasks}
              links={model.links ?? []}
              columns={columns}
              scales={model.scales}
              start={model.start}
              end={model.end}
              lengthUnit={model.lengthUnit}
              cellWidth={model.cellWidth}
              readonly
              displayMode={view.displayMode}
              gridWidth={view.gridWidth}
              cellHeight={view.rowHeight ?? SVAR_ROW_HEIGHT}
              scaleHeight={view.scaleHeight ?? SVAR_SCALE_HEIGHT}
              taskTemplate={(props) => <TaskBar {...props} labelsVisible={view.labelsVisible} />}
              init={initializeApi}
            />
          </div>
          <div
            className="svar-timeline-separator"
            data-dashboard-separator
            role="separator"
            aria-label="调整 Grid 与 Timeline 宽度"
            aria-orientation="vertical"
            aria-valuemin="240"
            aria-valuemax={Math.max(240, element.clientWidth - 329)}
            aria-valuenow={Math.round(view.gridWidth)}
            tabIndex={0}
          />
          <div className="current-time-marker" data-current-time-marker aria-hidden="true" hidden>
            <span>NOW</span>
          </div>
        </div>
      </RendererErrorBoundary>,
    )
  }

  return {
    render(nextModel, nextView = view) {
      model = nextModel
      view = { ...DEFAULT_VIEW, ...nextView }
      mount()
      scheduleRestore()
    },

    refreshTask(taskId, nextTask) {
      if (nextTask) {
        model = {
          ...model,
          tasks: model.tasks.map((task) => task.id === taskId ? { ...task, ...nextTask } : task),
        }
      }
      mount()
    },

    setDisplayMode(mode) {
      view = { ...view, displayMode: mode }
      api?.exec('set-display-mode', { mode })
      scheduleOverlayUpdate()
    },

    setGridWidth(width) {
      if (!Number.isFinite(width)) return
      view = { ...view, gridWidth: Math.round(width) }
      api?.exec('resize-grid', { width: view.gridWidth })
      scheduleOverlayUpdate()
    },

    setLabelsVisible(visible) {
      view = { ...view, labelsVisible: Boolean(visible) }
      mount()
    },

    locateNow(date = new Date()) {
      pendingLocateDate = date
      if (!timelineLocateShouldDefer({ apiReady: Boolean(api), restoreScheduled: Boolean(restoreFrame) })) {
        api.exec('scroll-chart', { date })
        pendingLocateDate = null
      }
      scheduleOverlayUpdate()
    },

    captureState() {
      const state = api?.getState?.() ?? {}
      const openIds = new Set(
        Array.isArray(state._tasks)
          ? state._tasks.filter((task) => task.open).map((task) => String(task.id))
          : [],
      )
      const selectedTaskId = Array.isArray(state._selected) && state._selected.length > 0
        ? String(state._selected.at(-1).id)
        : view.selectedTaskId ?? null
      const gridScroller = element.querySelector('.wx-table-container')
      return {
        ...view,
        displayMode: state.displayMode ?? view.displayMode,
        gridWidth: state.gridWidth ?? view.gridWidth,
        openIds,
        gridX: gridScroller?.scrollLeft ?? view.gridX ?? 0,
        timelineX: state.scrollLeft ?? 0,
        verticalY: state.scrollTop ?? 0,
        selectedTaskId,
        taskColumnWidth: state.columns?.[0]?.width ?? view.taskColumnWidth ?? 240,
      }
    },

    destroy() {
      if (destroyed) return
      destroyed = true
      if (restoreFrame) cancelAnimationFrame(restoreFrame)
      if (overlayFrame) cancelAnimationFrame(overlayFrame)
      window.clearInterval(markerTimer)
      resizeObserver.disconnect()
      api?.detach(eventTag)
      element.removeEventListener('keydown', handleKeyboard)
      element.removeEventListener('scroll', handleGridScroll, true)
      root.unmount()
      api = null
    },
  }
}
