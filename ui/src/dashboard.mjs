import {
  copyTextToClipboard,
  contextPathPresentation,
  contextPopoverPosition,
  createGanttLayout,
  createTaskIndex,
  effectiveGridPanelWidth,
  endOf,
  escapeHtml,
  formatHomePath,
  gridPanelWidthBounds,
  isHistoricalRoot,
  isTaskOpen,
  labelPlacement,
  nextGridPanelWidth,
  progressOf,
  readBooleanPreference,
  readNumberPreference,
  retainedGridScroll,
  relativeActivity,
  resolvePreferenceStorage,
  sessionIdPresentation,
  statusMutationMessage,
  tabCount,
  timelineBounds,
  writeBooleanPreference,
  writeNumberPreference,
} from './dashboard-state.mjs'
import { createSnapshotCoordinator } from './snapshot-coordinator.mjs'
import { createEventStream } from './event-stream.mjs'

const gantt = window.gantt

const TIMELINE_LABEL_KEY = 'dashboard-show-timeline-labels'
const TIMELINE_PANEL_KEY = 'dashboard-show-timeline'
const GRID_WIDTH_KEY = 'dashboard-grid-width'
const STATUS_LABELS = { active: '进行中', waiting: '等待中', blocked: '已阻塞', planned: '待安排', done: '已完成' }
const STATUS_ORDER = ['planned', 'active', 'waiting', 'blocked', 'done']
const TAB_DEFS = [
  ['all', '全部'], ['blocked', '已阻塞'], ['active', '进行中'], ['waiting', '等待中'],
  ['planned', '待安排'], ['history', '历史'],
]
const AGENT_COLORS = ['var(--accent)', 'var(--accent-hover)', 'var(--success)', 'var(--warn)', 'var(--muted)']

let raw = []
let index = createTaskIndex(raw)
let activeFilter = 'all'
const preferenceStorage = resolvePreferenceStorage()
let showTimelineLabels = readBooleanPreference(preferenceStorage, TIMELINE_LABEL_KEY)
let showTimeline = readBooleanPreference(preferenceStorage, TIMELINE_PANEL_KEY, true)
let preferredGridWidth = readNumberPreference(preferenceStorage, GRID_WIDTH_KEY)
let effectiveGridWidth = null
let initialized = false
let markerId = null
let homeDirectory = ''
let rememberedGridX = 0
let rememberedTimelineX = 0
let openStatusTaskId = null
let openStatusTrigger = null
let coordinator = null
let layoutResizeFrame = 0
const pendingStatus = new Set()
const refreshMessages = { connection: '', freshness: '', mutation: '' }

function hashString(value) {
  let hash = 0
  for (const character of String(value)) hash = (hash * 31 + character.charCodeAt(0)) >>> 0
  return hash
}

function taskLabel(task) {
  return `<span class="task-label"><span class="status-dot status-${task.status}" aria-hidden="true"></span><span class="task-name">${escapeHtml(task.text)}</span></span>`
}

function statusPill(task) {
  const id = String(task.id)
  const status = task.source?.status ?? task.status
  const pending = pendingStatus.has(id)
  const label = STATUS_LABELS[status] ?? status
  return `<button class="status-pill status-${status}" type="button" data-status-task-id="${escapeHtml(id)}" aria-label="修改 ${escapeHtml(task.text)} 状态，当前${escapeHtml(label)}" aria-haspopup="listbox" aria-controls="status-menu" aria-expanded="${openStatusTaskId === id}" aria-busy="${pending}" ${pending ? 'disabled' : ''}><span>${escapeHtml(label)}</span><svg viewBox="0 0 12 12" aria-hidden="true"><path d="m3 4.5 3 3 3-3" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg></button>`
}

function noteCell(task) {
  return task.note
    ? `<span class="task-note" title="${escapeHtml(task.note)}">${escapeHtml(task.note)}</span>`
    : '<span class="task-note is-empty">—</span>'
}

function agentChip(task) {
  const color = AGENT_COLORS[hashString(task.agent) % AGENT_COLORS.length]
  return `<span class="agent-chip" title="执行 Agent：${escapeHtml(task.agent)}"><span class="agent-dot" style="background:${color}"></span>${escapeHtml(task.agent)}</span>`
}

function activityCell(task) {
  const activity = relativeActivity(task.source, new Date())
  return `<span class="activity-time ${activity.tone === 'default' ? '' : `is-${activity.tone}`}">${activity.text}</span>`
}

function sessionIdCell(task) {
  const session = sessionIdPresentation(task.session_id)
  if (session.empty) return '<span class="session-id-cell is-empty">—</span>'
  const id = escapeHtml(session.full)
  return `<span class="session-id-cell" title="${id}"><span class="session-id-value">${escapeHtml(session.display)}</span><button class="session-copy" type="button" data-copy-session-id="${id}" aria-label="复制 Session ID ${id}" title="复制 Session ID"><svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5.25" y="5.25" width="7" height="7" rx="1" fill="none" stroke="currentColor"/><path d="M10.5 5.25V3.8a1 1 0 0 0-1-1H3.8a1 1 0 0 0-1 1v5.7a1 1 0 0 0 1 1h1.45" fill="none" stroke="currentColor"/></svg><span class="session-copy-check" aria-hidden="true">✓</span></button></span>`
}

function pathCell(field) {
  return (task) => {
    const path = contextPathPresentation(task[field], homeDirectory)
    if (path.empty) return '<span class="context-path is-empty">—</span>'
    return `<span class="context-path" tabindex="0" title="${escapeHtml(path.full)}" aria-label="完整路径：${escapeHtml(path.full)}" data-full-path="${escapeHtml(path.full)}"><span>${escapeHtml(path.display)}</span></span>`
  }
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
  const anchorRect = anchor.getBoundingClientRect()
  const popoverRect = popover.getBoundingClientRect()
  const position = contextPopoverPosition({
    anchor: anchorRect,
    popover: popoverRect,
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
  const ganttElement = document.getElementById('gantt_here')
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
  window.addEventListener('resize', () => hideContextPopover(document.querySelector('.context-path[aria-describedby]')))
}

function installSessionCopyInteractions() {
  const ganttElement = document.getElementById('gantt_here')
  ganttElement.addEventListener('click', async (event) => {
    const button = event.target.closest?.('[data-copy-session-id]')
    if (!button) return
    event.preventDefault()
    event.stopPropagation()
    const sessionId = button.dataset.copySessionId
    const copied = await copyTextToClipboard(sessionId)
    if (!copied) {
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

function rootTask(task) {
  let root = task
  while (root.parent) root = gantt.getTask(root.parent)
  return root
}

function renderTabs() {
  const tabs = document.getElementById('tabs')
  tabs.innerHTML = TAB_DEFS.map(([key, label]) => (
    `<button class="tab ${activeFilter === key ? 'is-active' : ''}" type="button" role="tab" aria-selected="${activeFilter === key}" data-key="${key}">${label}<span class="tab-count">${tabCount(key, raw, index)}</span></button>`
  )).join('') +
    `<button class="timeline-tool timeline-panel-toggle ${showTimeline ? 'is-active' : ''}" type="button" aria-pressed="${showTimeline}" aria-label="${showTimeline ? '折叠 Timeline' : '展开 Timeline'}" title="${showTimeline ? '折叠 Timeline' : '展开 Timeline'}"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="5" width="17" height="14" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M11 5v14" fill="none" stroke="currentColor" stroke-width="1.5"/></svg></button>` +
    `<button class="timeline-tool timeline-label-toggle ${showTimelineLabels ? 'is-active' : ''}" type="button" aria-pressed="${showTimelineLabels}" aria-label="${showTimelineLabels ? '隐藏任务名称' : '显示任务名称'}" title="${showTimelineLabels ? '隐藏 Timeline 任务名称' : '显示 Timeline 任务名称'}" ${showTimeline ? '' : 'disabled'}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 6h14M12 6v12M8.5 18h7" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg></button>` +
    '<button class="timeline-tool locate-now" type="button" aria-label="定位到当前时间" title="定位到当前时间"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="1.7"/><circle cx="12" cy="12" r="7" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg></button>'
  tabs.querySelectorAll('.tab').forEach((button) => button.addEventListener('click', () => {
    activeFilter = button.dataset.key
    renderTabs()
    gantt.refreshData()
  }))
  tabs.querySelector('.timeline-panel-toggle').addEventListener('click', () => {
    const next = !showTimeline
    writeBooleanPreference(preferenceStorage, TIMELINE_PANEL_KEY, next)
    applyLayout(next)
  })
  tabs.querySelector('.timeline-label-toggle').addEventListener('click', () => {
    showTimelineLabels = !showTimelineLabels
    writeBooleanPreference(preferenceStorage, TIMELINE_LABEL_KEY, showTimelineLabels)
    renderTabs()
    gantt.render()
  })
  tabs.querySelector('.locate-now').addEventListener('click', () => {
    if (!showTimeline) {
      writeBooleanPreference(preferenceStorage, TIMELINE_PANEL_KEY, true)
      applyLayout(true)
    }
    gantt.showDate(new Date())
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
  const trigger = openStatusTrigger?.isConnected ? openStatusTrigger : (taskId ? statusTrigger(taskId) : null)
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
  const selectedIndex = Math.max(0, options.findIndex((option) => option.getAttribute('aria-selected') === 'true'))
  const indexToFocus = focus === 'first' ? 0 : focus === 'last' ? options.length - 1 : selectedIndex
  options[indexToFocus]?.focus({ preventScroll: true })
}

async function updateTaskStatus(taskId, status) {
  const task = raw.find((item) => item.id === taskId)
  if (!task || pendingStatus.has(taskId) || task.status === status) return
  pendingStatus.add(taskId)
  setRefreshMessage('mutation', '')
  if (gantt.isTaskExists(taskId)) gantt.refreshTask(taskId)
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
      if (['TASK_VERSION_CONFLICT', 'TASK_NOT_FOUND'].includes(error.code)) await coordinator?.invalidate()
      return
    }
    await coordinator?.invalidate()
  } catch {
    setRefreshMessage('mutation', '状态修改失败，仍显示最后一次成功数据')
  } finally {
    pendingStatus.delete(taskId)
    if (gantt.isTaskExists(taskId)) gantt.refreshTask(taskId)
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
  const ganttElement = document.getElementById('gantt_here')
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
    openStatusMenu(trigger, { focus: event.key === 'ArrowUp' ? 'last' : event.key === 'ArrowDown' ? 'first' : 'selected' })
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

function ganttData({ openIds = new Set(), preserveOpen = false } = {}) {
  return raw.map((task) => {
    let root = task
    while (root.parent_id) root = index.byId.get(root.parent_id)
    const archived = isHistoricalRoot(root, index)
    const hasChildren = index.childrenByParent.has(task.id)
    return {
      id: task.id, text: task.title, start_date: new Date(task.start), end_date: endOf(task, new Date()),
      parent: task.parent_id || 0, open: preserveOpen ? openIds.has(task.id) : true,
      progress: progressOf(task, index), status: archived && !task.parent_id ? 'done' : task.status,
      archived, agent: task.agent, note: task.next_action || '', last_activity: task.last_activity || null,
      session_id: task.session_id, workfolder: task.workfolder, worktree: task.worktree, branch: task.branch,
      updated_at: task.updated_at,
      type: hasChildren ? gantt.config.types.project : gantt.config.types.task, source: task,
    }
  })
}

function labelSide(start, end, task) {
  try {
    const position = gantt.getTaskPosition(task, start, end)
    const timeline = document.querySelector('.gantt_task_data')
    if (!timeline) return 'right'
    return labelPlacement({ text: task.text, barLeft: position.left, barWidth: position.width, scrollLeft: timeline.scrollLeft, clientWidth: timeline.clientWidth })
  } catch {
    return 'right'
  }
}

function taskColumnWidthBounds() {
  return { minimum: 180, maximum: 520 }
}

function ganttContainerWidth() {
  return document.getElementById('gantt_here').clientWidth
}

function resolveEffectiveGridWidth() {
  return effectiveGridPanelWidth({
    containerWidth: ganttContainerWidth(),
    preferredWidth: preferredGridWidth,
  })
}

function setTaskColumnWidth(width) {
  const bounds = taskColumnWidthBounds()
  const next = Math.round(Math.min(bounds.maximum, Math.max(bounds.minimum, width)))
  gantt.config.columns[0].width = next
  gantt.render()
}

function installTaskColumnResizer() {
  const header = document.querySelector('.gantt_grid_scale .gantt_grid_head_cell:first-child')
  if (!header || header.querySelector('.task-column-resizer')) return
  const resizer = document.createElement('span')
  resizer.className = 'task-column-resizer'
  resizer.tabIndex = 0
  resizer.setAttribute('role', 'separator')
  resizer.setAttribute('aria-orientation', 'vertical')
  resizer.setAttribute('aria-label', '调整任务列宽度')
  header.appendChild(resizer)
  resizer.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return
    event.preventDefault()
    const startX = event.clientX
    const startWidth = header.getBoundingClientRect().width
    let latest = startWidth
    let frame = 0
    document.documentElement.classList.add('is-resizing-task-column')
    const apply = () => { frame = 0; setTaskColumnWidth(latest) }
    const move = (moveEvent) => { latest = startWidth + moveEvent.clientX - startX; if (!frame) frame = requestAnimationFrame(apply) }
    const up = () => {
      if (frame) cancelAnimationFrame(frame)
      setTaskColumnWidth(latest)
      document.documentElement.classList.remove('is-resizing-task-column')
      document.removeEventListener('pointermove', move)
      document.removeEventListener('pointerup', up)
      document.removeEventListener('pointercancel', up)
    }
    document.addEventListener('pointermove', move)
    document.addEventListener('pointerup', up)
    document.addEventListener('pointercancel', up)
  })
  resizer.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return
    event.preventDefault()
    setTaskColumnWidth(header.getBoundingClientRect().width + (event.key === 'ArrowRight' ? 16 : -16))
  })
}

function configureGantt() {
  gantt.plugins({ marker: true })
  gantt.config.csp = true
  gantt.config.readonly = true
  gantt.config.duration_unit = 'hour'
  gantt.config.row_height = 38
  gantt.config.bar_height = 14
  gantt.config.scale_height = 52
  gantt.config.min_column_width = 56
  gantt.config.smart_rendering = true
  gantt.config.show_progress = true
  gantt.config.show_links = false
  gantt.config.scales = [
    { unit: 'day', step: 1, format: (date) => new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric' }).format(date) },
    { unit: 'hour', step: 6, format: (date) => `${String(date.getHours()).padStart(2, '0')}:00` },
  ]
  gantt.config.columns = [
    { name: 'text', label: '任务', tree: true, width: 240, min_width: 180, template: taskLabel },
    { name: 'status', label: '状态', width: 72, align: 'center', template: statusPill },
    { name: 'session_id', label: 'Session ID', width: 276, min_width: 248, template: sessionIdCell },
    { name: 'workfolder', label: '工作目录', width: 180, min_width: 140, template: pathCell('workfolder') },
    { name: 'worktree', label: 'Worktree', width: 180, min_width: 140, template: pathCell('worktree') },
    { name: 'branch', label: 'Branch', width: 160, min_width: 120, template: pathCell('branch') },
    { name: 'note', label: '说明', width: 160, min_width: 120, template: noteCell },
    { name: 'agent', label: 'Agent', width: 78, align: 'center', template: agentChip },
    { name: 'activity', label: '活动', width: 56, align: 'right', template: activityCell },
  ]
  effectiveGridWidth = resolveEffectiveGridWidth()
  gantt.config.layout = createGanttLayout({ showTimeline, gridWidth: effectiveGridWidth })
  gantt.templates.task_text = (start, end, task) => showTimelineLabels && labelSide(start, end, task) === 'inside' ? escapeHtml(task.text) : ''
  gantt.templates.rightside_text = (start, end, task) => showTimelineLabels && labelSide(start, end, task) === 'right' ? escapeHtml(task.text) : ''
  gantt.templates.leftside_text = (start, end, task) => showTimelineLabels && labelSide(start, end, task) === 'left' ? escapeHtml(task.text) : ''
  gantt.templates.task_class = (start, end, task) => task.type === gantt.config.types.project ? '' : `status-${task.status}`
  gantt.attachEvent('onBeforeTaskDisplay', (id, task) => {
    const root = rootTask(task)
    if (activeFilter === 'history') return root.archived
    if (root.archived) return false
    return activeFilter === 'all' || root.status === activeFilter
  })
  gantt.attachEvent('onGanttRender', () => {
    installTaskColumnResizer()
    syncTimelineSplitterA11y()
  })
}

function viewScroll(horizontalId) {
  const horizontal = gantt.getLayoutView?.(horizontalId)?.getScrollState?.()
  const vertical = gantt.getLayoutView?.('sharedScroll')?.getScrollState?.()
  return {
    x: Number(horizontal?.position) || 0,
    y: Number(vertical?.position) || 0,
  }
}

function captureState() {
  const openIds = new Set()
  if (initialized) gantt.eachTask((task) => { if (isTaskOpen(task)) openIds.add(String(task.id)) })
  const gridScroll = initialized ? viewScroll('gridScroll') : { x: 0, y: 0 }
  const timelineScroll = initialized && showTimeline ? viewScroll('timelineScroll') : { x: rememberedTimelineX, y: 0 }
  const gridScrollState = initialized
    ? gantt.getLayoutView?.('gridScroll')?.getScrollState?.()
    : null
  const gridScrollRange = Math.max(
    0,
    (Number(gridScrollState?.scrollSize) || 0) - (Number(gridScrollState?.size) || 0),
  )
  const gridX = retainedGridScroll({
    timelineVisible: showTimeline,
    gridX: gridScroll.x,
    gridScrollable: Boolean(gridScrollState?.visible),
    gridScrollRange,
    rememberedGridX,
  })
  return {
    openIds,
    preserveOpen: initialized,
    gridX,
    timelineX: timelineScroll.x,
    verticalY: gridScroll.y || timelineScroll.y,
    taskWidth: Number(gantt.config.columns?.[0]?.width) || null,
  }
}

function restoreViewState(state) {
  gantt.scrollLayoutCell('grid', state.gridX, state.verticalY)
  if (showTimeline) gantt.scrollLayoutCell('timeline', state.timelineX, state.verticalY)
}

function scheduleLayoutStateRestore(state, { restoreSplitterFocus = false } = {}) {
  const resizeDelay = Number(gantt.config.container_resize_timeout) || 20
  setTimeout(() => {
    restoreViewState(state)
    syncTimelineSplitterA11y()
    if (restoreSplitterFocus) {
      document.querySelector('.timeline-splitter')?.focus({ preventScroll: true })
    }
  }, resizeDelay + 16)
}

function syncTimelineSplitterA11y() {
  const splitter = document.querySelector('.timeline-splitter')
  if (!splitter || effectiveGridWidth === null) return
  const bounds = gridPanelWidthBounds(ganttContainerWidth())
  splitter.setAttribute('aria-valuemin', String(bounds.minimum))
  splitter.setAttribute('aria-valuemax', String(bounds.maximum))
  splitter.setAttribute('aria-valuenow', String(effectiveGridWidth))
}

function applyGridPanelWidth(preferredWidth, { restoreFocus = false } = {}) {
  preferredGridWidth = Math.round(preferredWidth)
  writeNumberPreference(preferenceStorage, GRID_WIDTH_KEY, preferredGridWidth)
  const nextWidth = resolveEffectiveGridWidth()
  if (!initialized || !showTimeline || nextWidth === effectiveGridWidth) {
    syncTimelineSplitterA11y()
    return
  }
  const state = captureState()
  effectiveGridWidth = nextWidth
  gantt.config.layout = createGanttLayout({ showTimeline: true, gridWidth: effectiveGridWidth })
  gantt.resetLayout()
  scheduleLayoutStateRestore(state, { restoreSplitterFocus: restoreFocus })
}

function installTimelineSplitterInteractions() {
  const ganttElement = document.getElementById('gantt_here')
  ganttElement.addEventListener('pointerdown', (event) => {
    const splitter = event.target.closest?.('.timeline-splitter')
    if (!splitter || event.button !== 0 || !showTimeline) return
    event.preventDefault()
    const startX = event.clientX
    const startWidth = effectiveGridWidth
    let candidate = startWidth
    let frame = 0
    const guide = document.createElement('div')
    guide.className = 'timeline-splitter-guide'
    guide.style.left = `${candidate}px`
    ganttElement.appendChild(guide)
    document.documentElement.classList.add('is-resizing-timeline')

    const move = (moveEvent) => {
      const bounds = gridPanelWidthBounds(ganttContainerWidth())
      candidate = Math.round(Math.min(
        bounds.maximum,
        Math.max(bounds.minimum, startWidth + moveEvent.clientX - startX),
      ))
      if (!frame) {
        frame = requestAnimationFrame(() => {
          frame = 0
          guide.style.left = `${candidate}px`
        })
      }
    }
    const finish = (apply) => {
      if (frame) cancelAnimationFrame(frame)
      guide.remove()
      document.documentElement.classList.remove('is-resizing-timeline')
      document.removeEventListener('pointermove', move)
      document.removeEventListener('pointerup', up)
      document.removeEventListener('pointercancel', cancel)
      if (apply && candidate !== startWidth) applyGridPanelWidth(candidate)
    }
    const up = () => finish(true)
    const cancel = () => finish(false)
    document.addEventListener('pointermove', move)
    document.addEventListener('pointerup', up)
    document.addEventListener('pointercancel', cancel)
  })
  ganttElement.addEventListener('keydown', (event) => {
    const splitter = event.target.closest?.('.timeline-splitter')
    if (!splitter || !showTimeline) return
    const bounds = gridPanelWidthBounds(ganttContainerWidth())
    const nextWidth = nextGridPanelWidth({
      key: event.key,
      currentWidth: effectiveGridWidth,
      minimum: bounds.minimum,
      maximum: bounds.maximum,
    })
    if (nextWidth === null) return
    event.preventDefault()
    applyGridPanelWidth(nextWidth, { restoreFocus: true })
  })
}

function applyLayout(nextShowTimeline) {
  if (!initialized || nextShowTimeline === showTimeline) return
  const state = captureState()
  if (showTimeline) {
    rememberedGridX = state.gridX
    rememberedTimelineX = state.timelineX
  }
  showTimeline = nextShowTimeline
  if (showTimeline) effectiveGridWidth = resolveEffectiveGridWidth()
  gantt.config.layout = createGanttLayout({ showTimeline, gridWidth: effectiveGridWidth })
  gantt.resetLayout()
  renderTabs()
  scheduleLayoutStateRestore({
    ...state,
    gridX: showTimeline ? rememberedGridX : state.gridX,
    timelineX: showTimeline ? rememberedTimelineX : state.timelineX,
  })
}

function applyResponsiveLayout() {
  if (!initialized || !showTimeline) return
  const nextWidth = resolveEffectiveGridWidth()
  if (nextWidth === effectiveGridWidth) return
  const state = captureState()
  effectiveGridWidth = nextWidth
  gantt.config.layout = createGanttLayout({ showTimeline: true, gridWidth: effectiveGridWidth })
  gantt.resetLayout()
  scheduleLayoutStateRestore(state)
}

window.addEventListener('resize', () => {
  if (layoutResizeFrame) cancelAnimationFrame(layoutResizeFrame)
  layoutResizeFrame = requestAnimationFrame(() => {
    layoutResizeFrame = 0
    applyResponsiveLayout()
  })
})

function refreshMarker() {
  if (markerId !== null) gantt.deleteMarker(markerId)
  markerId = gantt.addMarker({ start_date: new Date(), css: 'today-marker', text: 'NOW', title: '当前时间' })
}

function renderSnapshot(snapshot, { initial = false } = {}) {
  if (!snapshot || !Array.isArray(snapshot.tasks)) throw new TypeError('Dashboard snapshot is invalid')
  closeStatusMenu({ restoreFocus: false })
  const state = captureState()
  raw = snapshot.tasks
  homeDirectory = typeof snapshot.home_directory === 'string' ? snapshot.home_directory : ''
  index = createTaskIndex(raw)
  renderTabs()
  const { minimum, maximum } = timelineBounds(raw, new Date())
  if (!initialized) {
    configureGantt()
    gantt.init('gantt_here', minimum, maximum)
    initialized = true
  } else {
    gantt.config.start_date = minimum
    gantt.config.end_date = maximum
  }
  gantt.clearAll()
  gantt.parse({ data: ganttData(state), links: [] })
  if (state.taskWidth) setTaskColumnWidth(state.taskWidth)
  if (!initial) restoreViewState(state)
  refreshMarker()
  if (initial && showTimeline) gantt.showDate(new Date())
}

async function loadSnapshot() {
  const response = await fetch('/api/v1/snapshot', {
    headers: { Accept: 'application/json' },
    cache: 'no-store',
  })
  if (!response.ok) throw new Error(`snapshot request failed with HTTP ${response.status}`)
  return response.json()
}

if (!gantt) {
  document.getElementById('gantt_here').innerHTML = '<p class="empty-state">DHTMLX Gantt 加载失败。</p>'
} else {
  installContextInteractions()
  installSessionCopyInteractions()
  installStatusInteractions()
  installTimelineSplitterInteractions()
  let connectionState = 'connecting'
  coordinator = createSnapshotCoordinator({
    load: loadSnapshot,
    render: renderSnapshot,
    onStatus: ({ state }) => {
      if (state === 'fresh') setRefreshMessage('freshness', '')
      else if (state === 'stale') setRefreshMessage('freshness', '任务数据刷新失败，正在显示最后一次成功数据')
      else if (state === 'unavailable') setRefreshMessage('freshness', '任务数据暂不可用，等待 taskd 恢复')
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
        connectionState = state
        setRefreshMessage('connection', state === 'connected' ? '' : '实时连接已断开，正在重连…')
      },
    })
    events.start()
    window.addEventListener('beforeunload', () => {
      coordinator.stop()
      events.stop()
    }, { once: true })
  }
}
