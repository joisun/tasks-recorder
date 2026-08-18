import { timelineBounds } from './dashboard-state.mjs'
import {
  SVAR_GRID_COLUMNS,
  createSvarScales,
  createSvarTaskProjection,
  normalizeTimelineZoom,
} from './svar-gantt-state.mjs'

export function createDashboardRendererController({
  renderer,
  now = () => new Date(),
  initialView = {},
}) {
  let snapshot = { tasks: [], home_directory: '' }
  let filter = 'all'
  let rendered = false
  let view = {
    displayMode: 'all', gridWidth: 792, labelsVisible: false, timelineZoom: 'week', ...initialView,
  }
  let lastModel = null

  function captureView() {
    if (rendered) {
      const captured = renderer.captureState()
      const visibleSummaryIds = new Set(
        lastModel?.tasks.filter(({ type }) => type === 'summary').map(({ id }) => String(id)) ?? [],
      )
      const openIds = new Set(view.openIds ?? [])
      for (const id of visibleSummaryIds) openIds.delete(id)
      for (const id of captured.openIds ?? []) {
        if (visibleSummaryIds.has(String(id))) openIds.add(String(id))
      }
      const selectedVisible = lastModel?.tasks.some(({ id }) => id === view.selectedTaskId)
      view = {
        ...captured,
        openIds,
        selectedTaskId: captured.selectedTaskId ?? (selectedVisible ? null : view.selectedTaskId ?? null),
      }
    }
    return view
  }

  function createModel() {
    const instant = now()
    const projectedTasks = createSvarTaskProjection(snapshot.tasks, {
      filter,
      openIds: view.openIds ?? null,
      now: instant,
      homeDirectory: snapshot.home_directory ?? '',
    })
    const bounds = timelineBounds(projectedTasks, instant)
    const scale = createSvarScales(bounds, view.timelineZoom)
    const columns = SVAR_GRID_COLUMNS.map((column, index) => (
      index === 0 && Number.isFinite(view.taskColumnWidth)
        ? { ...column, width: view.taskColumnWidth }
        : { ...column }
    ))
    return {
      ...scale,
      columns,
      tasks: projectedTasks,
      links: [],
    }
  }

  function renderCurrent(nextView = captureView()) {
    view = nextView
    lastModel = createModel()
    renderer.render(lastModel, view)
    rendered = true
    return lastModel
  }

  return {
    setSnapshot(nextSnapshot, { initial = false } = {}) {
      if (!nextSnapshot || !Array.isArray(nextSnapshot.tasks)) {
        throw new TypeError('Dashboard snapshot is invalid')
      }
      const nextView = initial || !rendered ? view : captureView()
      snapshot = nextSnapshot
      return renderCurrent(nextView)
    },

    setFilter(nextFilter) {
      filter = nextFilter
      return renderCurrent()
    },

    refreshTask(taskId, patch = {}) {
      const projected = lastModel?.tasks.find(({ id }) => id === taskId)
      if (!projected) return false
      renderer.refreshTask(taskId, { ...projected, ...patch })
      return true
    },

    setTimelineVisible(visible) {
      const mode = visible ? 'all' : 'grid'
      view = { ...view, displayMode: mode }
      renderer.setDisplayMode(mode)
    },

    setGridWidth(width) {
      view = { ...view, gridWidth: width }
      renderer.setGridWidth(width)
    },

    setLabelsVisible(visible) {
      view = { ...view, labelsVisible: Boolean(visible) }
      renderer.setLabelsVisible(Boolean(visible))
    },

    setTimelineZoom(nextZoom) {
      view = { ...captureView(), timelineZoom: normalizeTimelineZoom(nextZoom), timelineX: 0 }
      return renderCurrent(view)
    },

    locateNow() {
      renderer.locateNow(now())
    },

    captureState() {
      return captureView()
    },

    tasks() {
      return snapshot.tasks
    },

    destroy() {
      renderer.destroy()
      rendered = false
    },
  }
}
