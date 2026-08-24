import {
  copyTextToClipboard,
  canArchiveTask,
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
import { createProjectInbox, projectInboxButtonLabel } from './project-inbox.mjs'
import { createSettingsDialog } from './settings-dialog.mjs'

const TIMELINE_LABEL_KEY = 'dashboard-show-timeline-labels'
const TIMELINE_PANEL_KEY = 'dashboard-show-timeline'
const TIMELINE_ZOOM_KEY = 'dashboard-timeline-zoom-v2'
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
  ['auto', '自适应', '根据当前 Project 周期自动选择时间尺度'],
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
  preferenceStorage, TIMELINE_ZOOM_KEY, SVAR_TIMELINE_ZOOMS, 'auto',
)
let preferredGridWidth = readNumberPreference(preferenceStorage, GRID_WIDTH_KEY)
let effectiveGridWidth = null
let openStatusTaskId = null
let openStatusTrigger = null
let coordinator = null
let detailsSheet = null
let executionInbox = null
let projectInbox = null
let settingsDialog = null
let unassignedExecutionCount = 0
let unresolvedProjectCount = 0
let projectInboxItems = []
let projectSummaries = []
let layoutResizeFrame = 0
let pinnedContextAnchor = null
let compactDashboard = window.matchMedia?.('(max-width: 720px)')?.matches
  ?? window.innerWidth <= 720
const pendingStatus = new Set()
const pendingResume = new Set()
const refreshMessages = { connection: '', freshness: '', mutation: '' }
let transientMutationTimer = null

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
  onEmptyReset() {
    selectTaskFilter('all', { focus: true })
  },
  onGridResize(width) {
    if (!Number.isFinite(width) || width <= 0) return
    effectiveGridWidth = Math.round(width)
    if (showTimeline && !compactDashboard) {
      preferredGridWidth = effectiveGridWidth
      writeNumberPreference(preferenceStorage, GRID_WIDTH_KEY, preferredGridWidth)
    }
  },
})
const rendererController = createDashboardRendererController({
  renderer,
  initialView: {
    displayMode: showTimeline ? (compactDashboard ? 'chart' : 'all') : 'grid',
    gridWidth: effectiveGridWidth,
    labelsVisible: showTimelineLabels,
    timelineZoom,
    compact: compactDashboard,
    rowHeight: compactDashboard ? 44 : 30,
    scaleHeight: compactDashboard ? 28 : 24,
  },
})

function installTaskDetailsInteractions() {
  detailsSheet = createTaskDetailsSheet({
    element: document.getElementById('task-details-sheet'),
    backdrop: document.getElementById('task-details-backdrop'),
    api: dashboardApi,
    getTasks: () => raw.filter(({ entity_type: entityType }) => entityType !== 'project'),
    onChanged: () => coordinator?.invalidate(),
  })
  ganttElement.addEventListener('click', (event) => {
    const trigger = event.target.closest?.('[data-task-details-id]')
    if (!trigger) return
    event.preventDefault()
    event.stopPropagation()
    executionInbox?.close()
    projectInbox?.close()
    settingsDialog?.close()
    detailsSheet.open(trigger.dataset.taskDetailsId, { trigger })
  }, true)
}

function installExecutionInboxInteractions() {
  executionInbox = createExecutionInbox({
    element: document.getElementById('execution-inbox'),
    backdrop: document.getElementById('execution-inbox-backdrop'),
    api: dashboardApi,
    getTasks: () => raw.filter(({ entity_type: entityType }) => entityType !== 'project'),
    onChanged: () => coordinator?.invalidate(),
  })
}

function installProjectInboxInteractions() {
  projectInbox = createProjectInbox({
    element: document.getElementById('project-inbox'),
    backdrop: document.getElementById('project-inbox-backdrop'),
    api: dashboardApi,
    onChanged: () => coordinator?.invalidate(),
  })
}

function installSettingsInteractions() {
  settingsDialog = createSettingsDialog({
    element: document.getElementById('settings-dialog'),
    backdrop: document.getElementById('settings-backdrop'),
    api: dashboardApi,
  })
}

function resumeErrorMessage(error) {
  const messages = {
    TASK_NOT_RESUMABLE: '该任务还没有可召回的 Codex 会话',
    CODEX_SESSION_NOT_FOUND: '本机找不到该 Codex 会话记录，可能已被清理或移动',
    SESSION_SOURCE_UNSUPPORTED: '当前仅支持召回 Codex 会话',
    TERMINAL_UNAVAILABLE: '所选终端当前不可用，请在 Settings 中重新选择',
    CODEX_UNAVAILABLE: '未找到 Codex CLI，请检查本机安装路径',
    WORKSPACE_NOT_FOUND: '该会话的 Workspace 已不存在',
    WORKSPACE_INVALID: '该会话没有有效的 Workspace',
    TERMINAL_LAUNCH_FAILED: '终端启动失败，请检查应用权限或重新选择终端',
  }
  return messages[error?.code] ?? error?.message ?? '会话召回失败'
}

function transientMutationMessage(message) {
  if (transientMutationTimer) clearTimeout(transientMutationTimer)
  setRefreshMessage('mutation', message)
  transientMutationTimer = setTimeout(() => {
    if (refreshMessages.mutation === message) setRefreshMessage('mutation', '')
  }, 3_200)
}

function installResumeInteractions() {
  ganttElement.addEventListener('click', async (event) => {
    const button = event.target.closest?.('[data-resume-task-id]')
    if (!button) return
    event.preventDefault()
    event.stopPropagation()
    const taskId = button.dataset.resumeTaskId
    if (!taskId || pendingResume.has(taskId)) return
    pendingResume.add(taskId)
    button.disabled = true
    button.classList.add('is-launching')
    button.setAttribute('aria-busy', 'true')
    setRefreshMessage('mutation', '')
    try {
      const result = await dashboardApi.resumeTask(taskId)
      const session = result.session_id?.length > 13
        ? `${result.session_id.slice(0, 8)}…${result.session_id.slice(-4)}`
        : result.session_id
      transientMutationMessage(`已在 ${result.terminal_label} 召回 Session ${session}`)
    } catch (error) {
      transientMutationMessage(resumeErrorMessage(error))
    } finally {
      pendingResume.delete(taskId)
      if (button.isConnected) {
        button.disabled = false
        button.classList.remove('is-launching')
        button.removeAttribute('aria-busy')
      }
    }
  }, true)
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

function unpinContextPopover() {
  if (!pinnedContextAnchor) return
  const anchor = pinnedContextAnchor
  pinnedContextAnchor = null
  hideContextPopover(anchor)
}

function installContextInteractions() {
  ganttElement.addEventListener('pointerover', (event) => {
    const anchor = event.target.closest?.('.context-path[data-full-path]')
    if (anchor) showContextPopover(anchor)
  })
  ganttElement.addEventListener('pointerout', (event) => {
    const anchor = event.target.closest?.('.context-path[data-full-path]')
    if (anchor && anchor !== pinnedContextAnchor && !anchor.contains(event.relatedTarget)) {
      hideContextPopover(anchor)
    }
  })
  ganttElement.addEventListener('focusin', (event) => {
    const anchor = event.target.closest?.('.context-path[data-full-path]')
    if (anchor) showContextPopover(anchor)
  })
  ganttElement.addEventListener('focusout', (event) => {
    const anchor = event.target.closest?.('.context-path[data-full-path]')
    if (anchor && anchor !== pinnedContextAnchor) hideContextPopover(anchor)
  })
  ganttElement.addEventListener('click', (event) => {
    if (event.target.closest?.('[data-copy-context-value]')) return
    const anchor = event.target.closest?.('.context-path[data-full-path]')
    if (!anchor) return
    event.preventDefault()
    event.stopPropagation()
    if (anchor === pinnedContextAnchor) {
      unpinContextPopover()
      return
    }
    unpinContextPopover()
    pinnedContextAnchor = anchor
    showContextPopover(anchor)
  }, true)
  document.addEventListener('pointerdown', (event) => {
    if (!pinnedContextAnchor || event.target.closest?.('.context-path[data-full-path], #context-popover')) return
    unpinContextPopover()
  }, true)
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') unpinContextPopover()
  })
  window.addEventListener('resize', () => {
    unpinContextPopover()
    hideContextPopover(document.querySelector('.context-path[aria-describedby]'))
  })
}

function installSessionCopyInteractions() {
  ganttElement.addEventListener('click', async (event) => {
    const button = event.target.closest?.('[data-copy-session-id], [data-copy-context-value]')
    if (!button) return
    event.preventDefault()
    event.stopPropagation()
    const sessionId = button.dataset.copySessionId
    const contextValue = button.dataset.copyContextValue
    const contextLabel = button.dataset.copyContextLabel
    const value = sessionId ?? contextValue
    const label = sessionId ? `Session ID ${sessionId}` : contextLabel
    if (!await copyTextToClipboard(value)) {
      setRefreshMessage('mutation', `${label} 复制失败，请手动选择文本复制`)
      return
    }
    button.classList.add('is-copied')
    button.setAttribute('aria-label', `已复制 ${label}`)
    if (sessionId) button.title = '已复制'
    setTimeout(() => {
      if (!button.isConnected) return
      button.classList.remove('is-copied')
      button.setAttribute('aria-label', sessionId ? `复制 Session ID ${sessionId}` : `复制 ${contextLabel}`)
      if (sessionId) button.title = '复制 Session ID'
    }, 1_600)
  }, true)
}

function renderTabs() {
  const tabs = document.getElementById('tabs')
  const filters = TAB_DEFS.map(([key, label]) => (
    `<button class="tab ${activeFilter === key ? 'is-active' : ''}" type="button" role="tab" aria-selected="${activeFilter === key}" tabindex="${activeFilter === key ? '0' : '-1'}" data-key="${key}">${label}<span class="tab-count">${tabCount(key, raw, index)}</span></button>`
  )).join('')
  const zooms = TIMELINE_ZOOM_DEFS.map(([key, label, title]) => (
    `<button class="timeline-zoom-option${timelineZoom === key ? ' is-active' : ''}" type="button" data-timeline-zoom="${key}" aria-pressed="${timelineZoom === key}" title="${title}" ${showTimeline ? '' : 'disabled'}>${label}</button>`
  )).join('')
  const viewModeControls = compactDashboard
    ? `<button class="timeline-tool${showTimeline ? '' : ' is-active'}" type="button" data-dashboard-view="grid" aria-pressed="${!showTimeline}" title="显示任务表">任务</button>
       <button class="timeline-tool${showTimeline ? ' is-active' : ''}" type="button" data-dashboard-view="timeline" aria-pressed="${showTimeline}" title="显示 Timeline">Timeline</button>`
    : `<button class="timeline-tool timeline-panel-toggle${showTimeline ? ' is-active' : ''}" type="button" data-dashboard-view="toggle" aria-pressed="${showTimeline}" title="${showTimeline ? '隐藏 Timeline' : '显示 Timeline'}">Timeline</button>`
  tabs.innerHTML = `
    <div class="status-filter-tabs" role="tablist" aria-label="任务状态">${filters}</div>
    <div class="toolbar-actions">
      <div class="inbox-tools" role="group" aria-label="待认领工作">
        <button class="inbox-toggle${unresolvedProjectCount > 0 ? ' has-items' : ''}" type="button" data-project-inbox-toggle aria-label="打开 Project Inbox，${unresolvedProjectCount} 个 Source Session 待处理"><span>${projectInboxButtonLabel(unresolvedProjectCount)}</span></button>
        <button class="inbox-toggle${unassignedExecutionCount > 0 ? ' has-items' : ''}" type="button" data-execution-inbox-toggle aria-label="打开 Attribution Inbox，${unassignedExecutionCount} 个 Execution 待处理"><span>${inboxButtonLabel(unassignedExecutionCount)}</span></button>
      </div>
      <div class="timeline-zoom" role="group" aria-label="Timeline 时间尺度">${zooms}</div>
      <div class="timeline-legend" aria-label="Timeline 图例"><span><i class="legend-actual" aria-hidden="true"></i>Actual</span><span><i class="legend-plan" aria-hidden="true"></i>Plan</span></div>
      <div class="view-tools" role="group" aria-label="Timeline 视图">
        ${viewModeControls}
        <button class="timeline-tool timeline-label-toggle${showTimelineLabels ? ' is-active' : ''}" type="button" aria-pressed="${showTimelineLabels}" title="${showTimelineLabels ? '隐藏任务名称' : '显示任务名称'}" ${showTimeline ? '' : 'disabled'}>标签</button>
        <button class="timeline-tool locate-now" type="button" title="定位到今天">今天</button>
      </div>
      <button class="settings-toggle" type="button" data-settings-toggle aria-label="打开 Settings"><svg viewBox="0 0 18 18" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="9" cy="9" r="2.4"></circle><path d="M9 1.75v1.5M9 14.75v1.5M16.25 9h-1.5M3.25 9h-1.5M14.13 3.87l-1.06 1.06M4.93 13.07l-1.06 1.06M14.13 14.13l-1.06-1.06M4.93 4.93 3.87 3.87"></path><circle cx="9" cy="9" r="5.15"></circle></svg></button>
    </div>`

  tabs.querySelectorAll('.tab').forEach((button) => button.addEventListener('click', () => {
    selectTaskFilter(button.dataset.key, { focus: true })
  }))
  tabs.querySelector('.status-filter-tabs').addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const buttons = [...event.currentTarget.querySelectorAll('[role="tab"]')]
    const current = Math.max(0, buttons.indexOf(document.activeElement))
    const next = event.key === 'Home' ? 0
      : event.key === 'End' ? buttons.length - 1
        : (current + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length
    buttons[next]?.click()
  })
  tabs.querySelector('[data-project-inbox-toggle]').addEventListener('click', (event) => {
    detailsSheet?.close()
    executionInbox?.close()
    settingsDialog?.close()
    projectInbox?.open(event.currentTarget)
  })
  tabs.querySelector('[data-execution-inbox-toggle]').addEventListener('click', (event) => {
    detailsSheet?.close()
    projectInbox?.close()
    settingsDialog?.close()
    executionInbox?.open(event.currentTarget)
  })
  tabs.querySelector('[data-settings-toggle]').addEventListener('click', (event) => {
    detailsSheet?.close()
    executionInbox?.close()
    projectInbox?.close()
    settingsDialog?.open(event.currentTarget)
  })
  tabs.querySelectorAll('[data-dashboard-view]').forEach((button) => button.addEventListener('click', () => {
    const mode = button.dataset.dashboardView
    applyLayout(mode === 'toggle' ? !showTimeline : mode === 'timeline')
  }))
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

function selectTaskFilter(nextFilter, { focus = false } = {}) {
  if (!TAB_DEFS.some(([key]) => key === nextFilter)) return
  activeFilter = nextFilter
  renderTabs()
  rendererController.setFilter(activeFilter)
  if (focus) document.querySelector(`.tab[data-key="${activeFilter}"]`)?.focus({ preventScroll: true })
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
  menu.setAttribute('role', 'menu')
  menu.setAttribute('aria-label', '任务状态与操作')
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
  const effectiveStatus = task.rollup_state ?? task.status
  const optionsMarkup = STATUS_ORDER.map((status) => (
    `<button class="status-option status-${status}" id="status-option-${status}" type="button" role="menuitemradio" data-status="${status}" aria-checked="${effectiveStatus === status}" tabindex="-1"><span class="status-option-dot" aria-hidden="true"></span><span>${STATUS_LABELS[status]}</span>${effectiveStatus === status ? '<span class="status-option-check" aria-hidden="true">✓</span>' : ''}</button>`
  )).join('')
  const archiveMarkup = canArchiveTask(task)
    ? '<div class="status-menu-separator" role="separator"></div><button class="status-option status-action" type="button" role="menuitem" data-status-action="archive" tabindex="-1"><span class="archive-option-icon" aria-hidden="true"></span><span>归档任务</span><span></span></button>'
    : ''
  menu.innerHTML = `${optionsMarkup}${archiveMarkup}`
  menu.hidden = false
  positionStatusMenu(menu, trigger)
  const options = [...menu.querySelectorAll('button:not([disabled])')]
  const selectedIndex = Math.max(0, options.findIndex((option) => (
    option.getAttribute('aria-checked') === 'true'
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

async function archiveTask(taskId) {
  const task = raw.find((item) => item.id === taskId)
  if (!task || pendingStatus.has(taskId) || !canArchiveTask(task)) return
  pendingStatus.add(taskId)
  setRefreshMessage('mutation', '')
  rendererController.refreshTask(taskId, { statusPending: true })
  try {
    await dashboardApi.archiveTask(taskId, task.revision)
    await coordinator?.invalidate()
  } catch (error) {
    setRefreshMessage('mutation', statusMutationMessage(error))
    if (['TASK_VERSION_CONFLICT', 'TASK_NOT_FOUND'].includes(error?.code)) {
      await coordinator?.invalidate()
    }
  } finally {
    pendingStatus.delete(taskId)
    rendererController.refreshTask(taskId, { statusPending: false })
  }
}

function moveStatusOption(menu, key) {
  const options = [...menu.querySelectorAll('button:not([disabled])')]
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
    const option = event.target.closest?.('#status-menu [data-status], #status-menu [data-status-action]')
    if (!option) return
    const taskId = openStatusTaskId
    const status = option.dataset.status
    const action = option.dataset.statusAction
    closeStatusMenu({ restoreFocus: false })
    const mutation = action === 'archive'
      ? archiveTask(taskId)
      : updateTaskStatus(taskId, status)
    mutation.finally(() => restoreStatusFocus(taskId))
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
  rendererController.setTimelineVisible(showTimeline, { compact: compactDashboard })
  renderTabs()
}

window.addEventListener('resize', () => {
  if (layoutResizeFrame) cancelAnimationFrame(layoutResizeFrame)
  layoutResizeFrame = requestAnimationFrame(() => {
    layoutResizeFrame = 0
    const nextCompact = window.matchMedia?.('(max-width: 720px)')?.matches
      ?? window.innerWidth <= 720
    if (nextCompact !== compactDashboard) {
      compactDashboard = nextCompact
      effectiveGridWidth = resolveEffectiveGridWidth()
      rendererController.setResponsiveLayout({
        compact: compactDashboard,
        timelineVisible: showTimeline,
        gridWidth: effectiveGridWidth,
      })
      renderTabs()
      return
    }
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
  unresolvedProjectCount = Number.isInteger(snapshot.project_inbox_count)
    ? snapshot.project_inbox_count
    : 0
  projectInboxItems = Array.isArray(snapshot.project_inbox) ? snapshot.project_inbox : []
  projectSummaries = Array.isArray(snapshot.projects) ? snapshot.projects : []
  projectInbox?.setData(projectInboxItems, projectSummaries)
  renderTabs()
  rendererController.setSnapshot(snapshot, { initial })
  if (initial && showTimeline) rendererController.locateNow()
  if (!initial && detailsSheet?.isOpen()) void detailsSheet.refresh()
  if (!initial && executionInbox?.isOpen()) void executionInbox.refresh()
}

installContextInteractions()
installSessionCopyInteractions()
installResumeInteractions()
installStatusInteractions()
installTaskDetailsInteractions()
installExecutionInboxInteractions()
installProjectInboxInteractions()
installSettingsInteractions()

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
