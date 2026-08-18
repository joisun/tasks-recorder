import {
  copyTextToClipboard,
  contextPopoverPosition,
  createTaskIndex,
  effectiveGridPanelWidth,
  readBooleanPreference,
  readChoicePreference,
  readNumberPreference,
  resolvePreferenceStorage,
  statusMutationMessage,
  tabCount,
  writeBooleanPreference,
  writeChoicePreference,
  writeNumberPreference,
} from './dashboard-state.mjs'
import { createDashboardRendererController } from './dashboard-renderer-controller.mjs'
import { createSvarGanttRenderer } from './svar-gantt-renderer.jsx'
import { SVAR_TIMELINE_ZOOMS } from './svar-gantt-state.mjs'
import { createSnapshotCoordinator } from './snapshot-coordinator.mjs'
import { createEventStream } from './event-stream.mjs'
import { createDashboardApi } from './dashboard-api.mjs'
import { createTaskDetailsSheet } from './task-details-sheet.mjs'
import { createExecutionInbox, inboxButtonLabel } from './execution-inbox.mjs'

const TIMELINE_LABEL_KEY = 'dashboard-show-timeline-labels'
const TIMELINE_PANEL_KEY = 'dashboard-show-timeline'
const TIMELINE_ZOOM_KEY = 'dashboard-timeline-zoom'
const GRID_WIDTH_KEY = 'dashboard-grid-width'
const STATUS_LABELS = {
  active: '进行中', waiting: '等待中', blocked: '已阻塞', planned: '待安排',
  done: '已完成', canceled: '已取消',
}
const STATUS_ORDER = ['planned', 'active', 'waiting', 'blocked', 'done', 'canceled']
const TAB_DEFS = [
  ['all', '全部'], ['blocked', '已阻塞'], ['active', '进行中'], ['waiting', '等待中'],
  ['planned', '待安排'], ['history', '历史'],
]
const TIMELINE_ZOOM_DEFS = [
  ['day', '日', '按日查看，适合两周内执行'],
  ['week', '周', '按周查看，适合项目周期'],
  ['month', '月', '按月查看，适合季度回顾'],
]

const dashboardApi = createDashboardApi()
const preferenceStorage = resolvePreferenceStorage()
const ganttElement = document.getElementById('gantt_here')

let raw = []
let index = createTaskIndex(raw)
let activeFilter = 'all'
let showTimelineLabels = readBooleanPreference(preferenceStorage, TIMELINE_LABEL_KEY)
let showTimeline = readBooleanPreference(preferenceStorage, TIMELINE_PANEL_KEY, true)
let timelineZoom = readChoicePreference(
  preferenceStorage, TIMELINE_ZOOM_KEY, SVAR_TIMELINE_ZOOMS, 'week',
)
let preferredGridWidth = readNumberPreference(preferenceStorage, GRID_WIDTH_KEY)
let effectiveGridWidth = null
let openStatusTaskId = null
let openStatusTrigger = null
let coordinator = null
let detailsSheet = null
let executionInbox = null
let unassignedExecutionCount = 0
let layoutResizeFrame = 0
const pendingStatus = new Set()
const refreshMessages = { connection: '', freshness: '', mutation: '' }

function ganttContainerWidth() {
  return ganttElement.clientWidth
}

function resolveEffectiveGridWidth() {
  return effectiveGridPanelWidth({
    containerWidth: ganttContainerWidth(),
    preferredWidth: preferredGridWidth,
  })
}

effectiveGridWidth = resolveEffectiveGridWidth()

const renderer = createSvarGanttRenderer({
  element: ganttElement,
  onGridResize(width) {
    if (!Number.isFinite(width) || width <= 0) return
    effectiveGridWidth = Math.round(width)
    if (showTimeline) {
      preferredGridWidth = effectiveGridWidth
      writeNumberPreference(preferenceStorage, GRID_WIDTH_KEY, preferredGridWidth)
    }
  },
})
const rendererController = createDashboardRendererController({
  renderer,
  initialView: {
    displayMode: showTimeline ? 'all' : 'grid',
    gridWidth: effectiveGridWidth,
    labelsVisible: showTimelineLabels,
    timelineZoom,
  },
})

function installTaskDetailsInteractions() {
  detailsSheet = createTaskDetailsSheet({
    element: document.getElementById('task-details-sheet'),
    backdrop: document.getElementById('task-details-backdrop'),
    api: dashboardApi,
    getTasks: () => raw,
    onChanged: () => coordinator?.invalidate(),
  })
  ganttElement.addEventListener('click', (event) => {
    const trigger = event.target.closest?.('[data-task-details-id]')
    if (!trigger) return
    event.preventDefault()
    event.stopPropagation()
    executionInbox?.close()
    detailsSheet.open(trigger.dataset.taskDetailsId, { trigger })
  }, true)
}

function installExecutionInboxInteractions() {
  executionInbox = createExecutionInbox({
    element: document.getElementById('execution-inbox'),
    backdrop: document.getElementById('execution-inbox-backdrop'),
    api: dashboardApi,
    getTasks: () => raw,
    onChanged: () => coordinator?.invalidate(),
  })
}

function contextPopover() {
  let popover = document.getElementById('context-popover')
  if (popover) return popover
  popover = document.createElement('div')
  popover.id = 'context-popover'
  popover.className = 'context-popover'
  popover.setAttribute('role', 'tooltip')
  popover.hidden = true
  document.querySelector('.app').appendChild(popover)
  return popover
}

function showContextPopover(anchor) {
  const fullPath = anchor?.dataset?.fullPath
  if (!fullPath) return
  const popover = contextPopover()
  popover.textContent = fullPath
  popover.hidden = false
  const position = contextPopoverPosition({
    anchor: anchor.getBoundingClientRect(),
    popover: popover.getBoundingClientRect(),
    viewport: { width: window.innerWidth, height: window.innerHeight },
  })
  popover.style.left = `${position.left}px`
  popover.style.top = `${position.top}px`
  anchor.setAttribute('aria-describedby', popover.id)
}

function hideContextPopover(anchor) {
  const popover = document.getElementById('context-popover')
  if (popover) popover.hidden = true
  anchor?.removeAttribute('aria-describedby')
}

function installContextInteractions() {
  ganttElement.addEventListener('pointerover', (event) => {
    const anchor = event.target.closest?.('.context-path[data-full-path]')
    if (anchor) showContextPopover(anchor)
  })
  ganttElement.addEventListener('pointerout', (event) => {
    const anchor = event.target.closest?.('.context-path[data-full-path]')
    if (anchor && !anchor.contains(event.relatedTarget)) hideContextPopover(anchor)
  })
  ganttElement.addEventListener('focusin', (event) => {
    const anchor = event.target.closest?.('.context-path[data-full-path]')
    if (anchor) showContextPopover(anchor)
  })
  ganttElement.addEventListener('focusout', (event) => {
    const anchor = event.target.closest?.('.context-path[data-full-path]')
    if (anchor) hideContextPopover(anchor)
  })
  window.addEventListener('resize', () => {
    hideContextPopover(document.querySelector('.context-path[aria-describedby]'))
  })
}

function installSessionCopyInteractions() {
  ganttElement.addEventListener('click', async (event) => {
    const button = event.target.closest?.('[data-copy-session-id]')
    if (!button) return
    event.preventDefault()
    event.stopPropagation()
    const sessionId = button.dataset.copySessionId
    if (!await copyTextToClipboard(sessionId)) {
      setRefreshMessage('mutation', 'Session ID 复制失败，请手动选择文本复制')
      return
    }
    button.classList.add('is-copied')
    button.setAttribute('aria-label', `已复制 Session ID ${sessionId}`)
    button.title = '已复制'
    setTimeout(() => {
      if (!button.isConnected) return
      button.classList.remove('is-copied')
      button.setAttribute('aria-label', `复制 Session ID ${sessionId}`)
      button.title = '复制 Session ID'
    }, 1_600)
  }, true)
}

function renderTabs() {
  const tabs = document.getElementById('tabs')
  const filters = TAB_DEFS.map(([key, label]) => (
    `<button class="tab ${activeFilter === key ? 'is-active' : ''}" type="button" role="tab" aria-selected="${activeFilter === key}" data-key="${key}">${label}<span class="tab-count">${tabCount(key, raw, index)}</span></button>`
  )).join('')
  const zooms = TIMELINE_ZOOM_DEFS.map(([key, label, title]) => (
    `<button class="timeline-zoom-option${timelineZoom === key ? ' is-active' : ''}" type="button" data-timeline-zoom="${key}" aria-pressed="${timelineZoom === key}" title="${title}" ${showTimeline ? '' : 'disabled'}>${label}</button>`
  )).join('')
  tabs.innerHTML = `
    <div class="status-filter-tabs" role="tablist" aria-label="任务状态">${filters}</div>
    <div class="toolbar-actions">
      <button class="inbox-toggle${unassignedExecutionCount > 0 ? ' has-items' : ''}" type="button" data-execution-inbox-toggle aria-label="打开未绑定 Execution Inbox，${unassignedExecutionCount} 个待处理"><span>${inboxButtonLabel(unassignedExecutionCount)}</span></button>
      <div class="timeline-zoom" role="group" aria-label="Timeline 时间尺度">${zooms}</div>
      <div class="view-tools" role="group" aria-label="Timeline 视图">
        <button class="timeline-tool timeline-panel-toggle${showTimeline ? ' is-active' : ''}" type="button" aria-pressed="${showTimeline}" title="${showTimeline ? '隐藏 Timeline' : '显示 Timeline'}">Timeline</button>
        <button class="timeline-tool timeline-label-toggle${showTimelineLabels ? ' is-active' : ''}" type="button" aria-pressed="${showTimelineLabels}" title="${showTimelineLabels ? '隐藏任务名称' : '显示任务名称'}" ${showTimeline ? '' : 'disabled'}>标签</button>
        <button class="timeline-tool locate-now" type="button" title="定位到今天">今天</button>
      </div>
    </div>`

  tabs.querySelectorAll('.tab').forEach((button) => button.addEventListener('click', () => {
    activeFilter = button.dataset.key
    renderTabs()
    rendererController.setFilter(activeFilter)
  }))
  tabs.querySelector('.inbox-toggle').addEventListener('click', (event) => {
    detailsSheet?.close()
    executionInbox?.open(event.currentTarget)
  })
  tabs.querySelector('.timeline-panel-toggle').addEventListener('click', () => {
    applyLayout(!showTimeline)
  })
  tabs.querySelector('.timeline-label-toggle').addEventListener('click', () => {
    showTimelineLabels = !showTimelineLabels
    writeBooleanPreference(preferenceStorage, TIMELINE_LABEL_KEY, showTimelineLabels)
    renderTabs()
    rendererController.setLabelsVisible(showTimelineLabels)
  })
  tabs.querySelectorAll('[data-timeline-zoom]').forEach((button) => button.addEventListener('click', () => {
    const nextZoom = button.dataset.timelineZoom
    if (nextZoom === timelineZoom) return
    timelineZoom = nextZoom
    writeChoicePreference(preferenceStorage, TIMELINE_ZOOM_KEY, timelineZoom, SVAR_TIMELINE_ZOOMS)
    rendererController.setTimelineZoom(timelineZoom)
    renderTabs()
    requestAnimationFrame(() => rendererController.locateNow())
  }))
  tabs.querySelector('.locate-now').addEventListener('click', () => {
    if (!showTimeline) applyLayout(true)
    rendererController.locateNow()
  })
}

function renderRefreshState() {
  const element = document.getElementById('refresh-state')
  const message = refreshMessages.mutation || refreshMessages.freshness || refreshMessages.connection
  element.textContent = message
  element.classList.toggle('is-visible', Boolean(message))
}

function setRefreshMessage(channel, message = '') {
  refreshMessages[channel] = message
  renderRefreshState()
}

function statusMenu() {
  let menu = document.getElementById('status-menu')
  if (menu) return menu
  menu = document.createElement('div')
  menu.id = 'status-menu'
  menu.className = 'status-menu'
  menu.setAttribute('role', 'listbox')
  menu.setAttribute('aria-label', '选择任务状态')
  menu.hidden = true
  document.querySelector('.app').appendChild(menu)
  return menu
}

function statusTrigger(taskId) {
  return [...document.querySelectorAll('[data-status-task-id]')]
    .find((element) => element.dataset.statusTaskId === taskId) ?? null
}

function restoreStatusFocus(taskId) {
  const target = statusTrigger(taskId) ?? document.querySelector('.tab.is-active')
  target?.focus({ preventScroll: true })
}

function closeStatusMenu({ restoreFocus = true } = {}) {
  const taskId = openStatusTaskId
  const trigger = openStatusTrigger?.isConnected
    ? openStatusTrigger
    : (taskId ? statusTrigger(taskId) : null)
  const menu = document.getElementById('status-menu')
  if (menu) menu.hidden = true
  if (trigger) trigger.setAttribute('aria-expanded', 'false')
  openStatusTaskId = null
  openStatusTrigger = null
  if (restoreFocus) trigger?.focus({ preventScroll: true })
}

function positionStatusMenu(menu, trigger) {
  const rect = trigger.getBoundingClientRect()
  const width = Math.min(176, window.innerWidth - 16)
  menu.style.width = `${width}px`
  menu.style.left = `${Math.min(window.innerWidth - width - 8, Math.max(8, rect.left))}px`
  menu.style.top = `${Math.min(window.innerHeight - menu.offsetHeight - 8, Math.max(8, rect.bottom + 4))}px`
  if (menu.getBoundingClientRect().bottom > window.innerHeight - 8) {
    menu.style.top = `${Math.max(8, rect.top - menu.offsetHeight - 4)}px`
  }
}

function openStatusMenu(trigger, { focus = 'selected' } = {}) {
  const taskId = trigger.dataset.statusTaskId
  const task = raw.find((item) => item.id === taskId)
  if (!task || pendingStatus.has(taskId)) return
  if (openStatusTaskId === taskId) {
    closeStatusMenu()
    return
  }
  closeStatusMenu({ restoreFocus: false })
  openStatusTaskId = taskId
  openStatusTrigger = trigger
  trigger.setAttribute('aria-expanded', 'true')
  const menu = statusMenu()
  menu.dataset.taskId = taskId
  menu.innerHTML = STATUS_ORDER.map((status) => (
    `<button class="status-option status-${status}" id="status-option-${status}" type="button" role="option" data-status="${status}" aria-selected="${task.status === status}" tabindex="-1"><span class="status-option-dot" aria-hidden="true"></span><span>${STATUS_LABELS[status]}</span>${task.status === status ? '<span class="status-option-check" aria-hidden="true">✓</span>' : ''}</button>`
  )).join('')
  menu.hidden = false
  positionStatusMenu(menu, trigger)
  const options = [...menu.querySelectorAll('[role="option"]')]
  const selectedIndex = Math.max(0, options.findIndex((option) => (
    option.getAttribute('aria-selected') === 'true'
  )))
  const targetIndex = focus === 'first' ? 0 : focus === 'last' ? options.length - 1 : selectedIndex
  options[targetIndex]?.focus({ preventScroll: true })
}

async function updateTaskStatus(taskId, status) {
  const task = raw.find((item) => item.id === taskId)
  if (!task || pendingStatus.has(taskId) || task.status === status) return
  pendingStatus.add(taskId)
  setRefreshMessage('mutation', '')
  rendererController.refreshTask(taskId, { statusPending: true })
  try {
    const response = await fetch(`/api/v1/tasks/${encodeURIComponent(taskId)}/status`, {
      method: 'PATCH',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ status, expected_updated_at: task.updated_at }),
    })
    const result = await response.json().catch(() => null)
    if (!response.ok) {
      const error = result?.error ?? { code: 'SERVICE_RESPONSE_INVALID' }
      setRefreshMessage('mutation', statusMutationMessage(error))
      if (['TASK_VERSION_CONFLICT', 'TASK_NOT_FOUND'].includes(error.code)) {
        await coordinator?.invalidate()
      }
      return
    }
    await coordinator?.invalidate()
  } catch {
    setRefreshMessage('mutation', '状态修改失败，仍显示最后一次成功数据')
  } finally {
    pendingStatus.delete(taskId)
    rendererController.refreshTask(taskId, { statusPending: false })
  }
}

function moveStatusOption(menu, key) {
  const options = [...menu.querySelectorAll('[role="option"]')]
  const current = Math.max(0, options.indexOf(document.activeElement))
  const next = key === 'Home' ? 0
    : key === 'End' ? options.length - 1
      : (current + (key === 'ArrowDown' ? 1 : -1) + options.length) % options.length
  options[next]?.focus({ preventScroll: true })
}

function installStatusInteractions() {
  ganttElement.addEventListener('click', (event) => {
    const trigger = event.target.closest?.('[data-status-task-id]')
    if (!trigger) return
    event.preventDefault()
    event.stopPropagation()
    openStatusMenu(trigger)
  })
  ganttElement.addEventListener('keydown', (event) => {
    const trigger = event.target.closest?.('[data-status-task-id]')
    if (!trigger || !['Enter', ' ', 'ArrowDown', 'ArrowUp'].includes(event.key)) return
    event.preventDefault()
    event.stopPropagation()
    openStatusMenu(trigger, {
      focus: event.key === 'ArrowUp' ? 'last' : event.key === 'ArrowDown' ? 'first' : 'selected',
    })
  })
  document.addEventListener('click', (event) => {
    const option = event.target.closest?.('#status-menu [role="option"]')
    if (!option) return
    const taskId = openStatusTaskId
    const status = option.dataset.status
    closeStatusMenu({ restoreFocus: false })
    updateTaskStatus(taskId, status).finally(() => restoreStatusFocus(taskId))
  })
  document.addEventListener('keydown', (event) => {
    const menu = event.target.closest?.('#status-menu')
    if (!menu || menu.hidden) return
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault()
      moveStatusOption(menu, event.key)
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      document.activeElement?.click()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      closeStatusMenu()
    } else if (event.key === 'Tab') {
      closeStatusMenu({ restoreFocus: false })
    }
  })
  document.addEventListener('pointerdown', (event) => {
    if (!openStatusTaskId || event.target.closest?.('#status-menu, [data-status-task-id]')) return
    closeStatusMenu({ restoreFocus: false })
  }, true)
  window.addEventListener('resize', () => closeStatusMenu({ restoreFocus: false }))
}

function applyGridPanelWidth(width) {
  preferredGridWidth = Math.round(width)
  writeNumberPreference(preferenceStorage, GRID_WIDTH_KEY, preferredGridWidth)
  effectiveGridWidth = resolveEffectiveGridWidth()
  rendererController.setGridWidth(effectiveGridWidth)
}

function applyLayout(nextShowTimeline) {
  if (nextShowTimeline === showTimeline) return
  showTimeline = nextShowTimeline
  writeBooleanPreference(preferenceStorage, TIMELINE_PANEL_KEY, showTimeline)
  if (showTimeline) applyGridPanelWidth(preferredGridWidth ?? effectiveGridWidth)
  rendererController.setTimelineVisible(showTimeline)
  renderTabs()
}

window.addEventListener('resize', () => {
  if (layoutResizeFrame) cancelAnimationFrame(layoutResizeFrame)
  layoutResizeFrame = requestAnimationFrame(() => {
    layoutResizeFrame = 0
    if (!showTimeline) return
    const nextWidth = resolveEffectiveGridWidth()
    if (nextWidth !== effectiveGridWidth) {
      effectiveGridWidth = nextWidth
      rendererController.setGridWidth(effectiveGridWidth)
    }
  })
})

function renderSnapshot(snapshot, { initial = false } = {}) {
  if (!snapshot || !Array.isArray(snapshot.tasks)) throw new TypeError('Dashboard snapshot is invalid')
  closeStatusMenu({ restoreFocus: false })
  raw = snapshot.tasks
  index = createTaskIndex(raw)
  unassignedExecutionCount = Number.isInteger(snapshot.unassigned_execution_count)
    ? snapshot.unassigned_execution_count
    : 0
  renderTabs()
  rendererController.setSnapshot(snapshot, { initial })
  if (initial && showTimeline) rendererController.locateNow()
  if (!initial && detailsSheet?.isOpen()) void detailsSheet.refresh()
  if (!initial && executionInbox?.isOpen()) void executionInbox.refresh()
}

installContextInteractions()
installSessionCopyInteractions()
installStatusInteractions()
installTaskDetailsInteractions()
installExecutionInboxInteractions()

coordinator = createSnapshotCoordinator({
  load: () => dashboardApi.snapshot(),
  render: renderSnapshot,
  onStatus: ({ state }) => {
    if (state === 'fresh') setRefreshMessage('freshness', '')
    else if (state === 'stale') {
      setRefreshMessage('freshness', '任务数据刷新失败，正在显示最后一次成功数据')
    } else if (state === 'unavailable') {
      setRefreshMessage('freshness', '任务数据暂不可用，等待 taskd 恢复')
    }
  },
})

if (typeof EventSource !== 'function') {
  setRefreshMessage('connection', '当前浏览器不支持实时连接，仅加载一次任务数据')
  coordinator.invalidate()
} else {
  const events = createEventStream({
    url: '/api/v1/events',
    invalidate: () => coordinator.invalidate(),
    onConnectionState: (state) => {
      setRefreshMessage('connection', state === 'connected' ? '' : '实时连接已断开，正在重连…')
    },
  })
  events.start()
  window.addEventListener('beforeunload', () => {
    coordinator.stop()
    events.stop()
    rendererController.destroy()
  }, { once: true })
}
