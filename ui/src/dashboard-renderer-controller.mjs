import { timelineBounds } from './dashboard-state.mjs'
import {
  SVAR_GRID_COLUMNS,
  createSvarScales,
  createSvarTaskProjection,
  normalizeTimelineZoom,
} from './svar-gantt-state.mjs'

const FILTER_LABELS = Object.freeze({
  all: '全部', blocked: '已阻塞', active: '进行中', waiting: '等待中',
  planned: '待安排', history: '历史',
})

export function createDashboardRendererController({
  renderer,
  now = () => new Date(),
  initialView = {},
}) {
  let snapshot = { tasks: [], home_directory: '' }
  let filter = 'all'
  let rendered = false
  let view = {
    displayMode: 'all', gridWidth: 792, labelsVisible: false, timelineZoom: 'auto', ...initialView,
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
        ...view,
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
    const gridOnly = view.displayMode === 'grid' && !view.compact
    const gridOnlyColumns = {
      text: { width: 320, flexgrow: 1 },
      execution_context: { width: 320, flexgrow: 2 },
      session_id: { width: 260, flexgrow: 1.5 },
      activity: { width: 80 },
    }
    const columns = SVAR_GRID_COLUMNS.map((column, index) => {
      const resized = index === 0 && Number.isFinite(view.taskColumnWidth)
        ? { ...column, width: view.taskColumnWidth }
        : { ...column }
      return gridOnly ? { ...resized, ...(gridOnlyColumns[column.id] ?? {}) } : resized
    })
    return {
      ...scale,
      baselines: true,
      columns,
      tasks: projectedTasks,
      links: [],
      emptyState: projectedTasks.length === 0 ? {
        title: '没有匹配任务',
        description: `当前“${FILTER_LABELS[filter] ?? filter}”筛选下没有任务。`,
      } : null,
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

    setTimelineVisible(visible, { compact = Boolean(view.compact) } = {}) {
      const mode = visible ? (compact ? 'chart' : 'all') : 'grid'
      view = { ...captureView(), displayMode: mode }
      return renderCurrent(view)
    },

    setResponsiveLayout({ compact, timelineVisible, gridWidth = view.gridWidth }) {
      const nextView = {
        ...captureView(),
        compact: Boolean(compact),
        displayMode: timelineVisible ? (compact ? 'chart' : 'all') : 'grid',
        gridWidth,
        rowHeight: compact ? 44 : 30,
        scaleHeight: compact ? 28 : 24,
      }
      return renderCurrent(nextView)
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
