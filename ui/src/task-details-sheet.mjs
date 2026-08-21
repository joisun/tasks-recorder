import { renderPreservingFocus } from './focus-state.mjs'

export const DETAIL_TABS = [
  { id: 'summary', label: '概览' },
  { id: 'executions', label: 'Executions' },
  { id: 'activity', label: '动态' },
]

const EVENT_LABELS = {
  created: '创建任务',
  renamed: '重命名任务',
  description_changed: '修改描述',
  updated: '更新任务',
  status_changed: '修改状态',
  canceled: '取消任务',
  moved: '移动任务',
  reordered: '调整顺序',
  archived: '归档任务',
  deleted: '删除任务',
  restored: '恢复任务',
  execution_bound: '关联 Execution',
  execution_unbound: '解除 Execution 关联',
}

function optionalText(value) {
  const normalized = String(value ?? '').trim()
  return normalized || null
}

function parseEventValue(value) {
  if (!value) return {}
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function meaningfulEventValue(value) {
  if (value === undefined || value === null || value === '') return '—'
  if (typeof value === 'object') return '已更新'
  return String(value)
}

function changedField(before, after) {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)])
  for (const key of keys) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) return key
  }
  return null
}

export function taskDraft(task) {
  return {
    title: task?.title ?? '',
    description: task?.description ?? '',
    status: task?.status ?? 'planned',
    next_action: task?.next_action ?? '',
    due_date: task?.due_date ?? '',
    parent_id: task?.parent_id ?? '',
    sort_order: task?.sort_order === undefined || task?.sort_order === null
      ? ''
      : String(task.sort_order),
  }
}

export function taskPatch(task, draft) {
  const title = String(draft.title ?? '').trim()
  if (!title) throw new TypeError('title is required')

  const normalized = {
    title,
    description: optionalText(draft.description),
    status: draft.status,
    next_action: optionalText(draft.next_action),
    due_date: optionalText(draft.due_date),
    parent_id: optionalText(draft.parent_id),
    sort_order: draft.sort_order === '' || draft.sort_order === null || draft.sort_order === undefined
      ? 0
      : Number(draft.sort_order),
  }
  if (!Number.isFinite(normalized.sort_order)) throw new TypeError('sort_order must be a number')

  const patch = {}
  for (const [key, value] of Object.entries(normalized)) {
    const current = key === 'sort_order'
      ? Number(task?.[key] ?? 0)
      : (task?.[key] ?? null)
    if (value !== current) patch[key] = value
  }
  return patch
}

export function taskActionVisibility(task) {
  if (task?.deleted_at) {
    return { addChild: false, cancel: false, archive: false, delete: false, restore: true }
  }
  if (task?.archived_at) {
    return { addChild: false, cancel: false, archive: false, delete: true, restore: true }
  }
  const active = ['planned', 'active', 'waiting', 'blocked'].includes(task?.status)
  return {
    addChild: active,
    cancel: active,
    archive: !active,
    delete: true,
    restore: false,
  }
}

export function conflictViewState({ draft, latestTask }) {
  return {
    draft,
    task: latestTask,
    message: '任务已在其他位置更新；你的输入已保留，请检查后重新保存。',
  }
}

export function executionPresentation(execution) {
  const agent = [execution.agent_type, execution.agent_path].filter(Boolean).join(' · ') || '主线程'
  const context = [execution.worktree || execution.workfolder, execution.branch].filter(Boolean).join(' · ')
  const attributedSegments = Array.isArray(execution.attributed_segments)
    ? execution.attributed_segments
    : []
  return {
    id: execution.id,
    kind: execution.kind ?? 'unknown',
    agent,
    context: context || '—',
    sessionId: execution.session_id ?? '',
    turnId: execution.turn_id ?? '',
    status: execution.status ?? 'unknown',
    startedAt: execution.started_at ?? null,
    endedAt: execution.ended_at ?? null,
    segmentCount: attributedSegments.length,
    segmentTaskCount: new Set(attributedSegments.map(({ task_id: taskId }) => taskId)).size,
  }
}

export function eventPresentation(event) {
  const before = parseEventValue(event.before_json)
  const after = parseEventValue(event.after_json)
  const field = changedField(before, after)
  const detail = field
    ? `${meaningfulEventValue(before[field])} → ${meaningfulEventValue(after[field])}`
    : (event.actor ? `由 ${event.actor} 操作` : '')
  return {
    id: event.id,
    label: EVENT_LABELS[event.event_type] ?? '更新任务',
    detail,
    actor: event.actor ?? '',
    createdAt: event.created_at ?? null,
  }
}

export function focusTrapTarget({ current, count, shiftKey }) {
  if (count <= 0) return null
  if (shiftKey && current === 0) return count - 1
  if (!shiftKey && current === count - 1) return 0
  return null
}

export function restoreFocusTarget({ returnFocus, taskId, findTaskTrigger, fallback }) {
  if (returnFocus?.isConnected) return returnFocus
  return findTaskTrigger?.(taskId) ?? fallback ?? null
}

function escapeMarkup(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}

function timeLabel(value) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date)
}

function tabMarkup(activeTab) {
  return DETAIL_TABS.map(({ id, label }) => (
    `<button id="details-tab-${id}" class="details-tab${activeTab === id ? ' is-active' : ''}" type="button" role="tab" aria-selected="${activeTab === id}" aria-controls="details-panel-${id}" data-details-tab="${id}">${label}</button>`
  )).join('')
}

function summaryMarkup({ task, draft, tasks, showChildForm }) {
  const statuses = [
    ['planned', '待安排'], ['active', '进行中'], ['waiting', '等待中'],
    ['blocked', '已阻塞'], ['done', '已完成'], ['canceled', '已取消'],
  ]
  const parents = tasks
    .filter((candidate) => (
      candidate.id !== task.id
      && !candidate.deleted_at
      && candidate.entity_type === 'main_task'
      && (!task.project_id || candidate.project_id === task.project_id)
    ))
    .map((candidate) => `<option value="${escapeMarkup(candidate.id)}"${draft.parent_id === candidate.id ? ' selected' : ''}>${escapeMarkup(candidate.title)}</option>`)
    .join('')
  return `<section id="details-panel-summary" class="details-panel" role="tabpanel" aria-labelledby="details-tab-summary">
    <form class="details-form" data-details-form>
      <label class="details-field details-field-wide"><span>标题</span><input name="title" value="${escapeMarkup(draft.title)}" maxlength="240" required></label>
      <label class="details-field details-field-wide"><span>描述</span><textarea name="description" rows="5">${escapeMarkup(draft.description)}</textarea></label>
      <label class="details-field"><span>状态</span><select name="status">${statuses.map(([value, label]) => `<option value="${value}"${draft.status === value ? ' selected' : ''}>${label}</option>`).join('')}</select></label>
      <label class="details-field"><span>Due date</span><input name="due_date" type="date" value="${escapeMarkup(draft.due_date)}"></label>
      <label class="details-field details-field-wide"><span>Next action</span><textarea name="next_action" rows="3" maxlength="1000">${escapeMarkup(draft.next_action)}</textarea></label>
      <label class="details-field"><span>Parent</span><select name="parent_id"><option value="">无（Root task）</option>${parents}</select></label>
      <label class="details-field"><span>Sort order</span><input name="sort_order" type="number" step="1" value="${escapeMarkup(draft.sort_order)}"></label>
      <div class="details-form-meta"><span>Task ID</span><code>${escapeMarkup(task.id)}</code><span>Revision</span><code>${escapeMarkup(task.revision)}</code></div>
      <button class="details-primary" type="submit">保存更改</button>
    </form>
    ${showChildForm ? `<form class="child-task-form" data-child-form><label class="details-field details-field-wide"><span>子任务标题</span><input name="title" maxlength="240" required autofocus></label><div class="child-form-actions"><button type="button" data-details-action="dismiss-child">取消</button><button class="details-primary" type="submit">创建子任务</button></div></form>` : ''}
  </section>`
}

function executionsMarkup(executions) {
  const rows = executions.map(executionPresentation).map((item) => `<li class="execution-item">
    <div class="execution-heading"><span class="execution-kind">${escapeMarkup(item.kind)}</span><span class="execution-status is-${escapeMarkup(item.status)}">${escapeMarkup(item.status)}</span></div>
    <strong>${escapeMarkup(item.agent)}</strong>
    <div class="execution-context">${escapeMarkup(item.context)}</div>
    <dl><div><dt>Session ID</dt><dd><code>${escapeMarkup(item.sessionId || '—')}</code>${item.sessionId ? `<button class="details-copy" type="button" data-copy-value="${escapeMarkup(item.sessionId)}" aria-label="复制 Session ID">复制</button>` : ''}</dd></div><div><dt>Turn ID</dt><dd><code>${escapeMarkup(item.turnId || '—')}</code></dd></div><div><dt>Segments</dt><dd>${item.segmentCount ? `${item.segmentCount} 个区间 · ${item.segmentTaskCount} 个 Task` : '—'}</dd></div><div><dt>开始</dt><dd>${escapeMarkup(timeLabel(item.startedAt))}</dd></div><div><dt>结束</dt><dd>${escapeMarkup(timeLabel(item.endedAt))}</dd></div></dl>
  </li>`).join('')
  return `<section id="details-panel-executions" class="details-panel" role="tabpanel" aria-labelledby="details-tab-executions"><ol class="execution-list">${rows || '<li class="details-empty">尚无 Execution 记录</li>'}</ol></section>`
}

function activityMarkup(events) {
  const rows = events.map(eventPresentation).map((item) => `<li class="activity-item"><span class="activity-rail" aria-hidden="true"></span><div><div class="activity-heading"><strong>${escapeMarkup(item.label)}</strong><time>${escapeMarkup(timeLabel(item.createdAt))}</time></div>${item.detail ? `<p>${escapeMarkup(item.detail)}</p>` : ''}${item.actor ? `<span class="activity-actor">${escapeMarkup(item.actor)}</span>` : ''}</div></li>`).join('')
  return `<section id="details-panel-activity" class="details-panel" role="tabpanel" aria-labelledby="details-tab-activity"><ol class="activity-list">${rows || '<li class="details-empty">尚无任务动态</li>'}</ol></section>`
}

export function detailsSheetMarkup({
  task,
  draft = taskDraft(task),
  activeTab = 'summary',
  executions = [],
  events = [],
  tasks = [],
  message = '',
  busy = false,
  showChildForm = false,
}) {
  const actions = taskActionVisibility(task)
  return `<header class="details-header"><div><span class="details-eyebrow">Task details</span><h2 id="task-details-title">${escapeMarkup(task.title)}</h2></div><button class="details-close" type="button" data-details-close aria-label="关闭任务详情">×</button></header>
    <div class="details-tabs" role="tablist" aria-label="任务详情">${tabMarkup(activeTab)}</div>
    <div class="details-message${message ? ' is-visible' : ''}" role="status" aria-live="polite">${escapeMarkup(message)}</div>
    <div class="details-body" aria-busy="${busy}">
      <div${activeTab === 'summary' ? '' : ' hidden'}>${summaryMarkup({ task, draft, tasks, showChildForm })}</div>
      <div${activeTab === 'executions' ? '' : ' hidden'}>${executionsMarkup(executions)}</div>
      <div${activeTab === 'activity' ? '' : ' hidden'}>${activityMarkup(events)}</div>
    </div>
    <footer class="details-actions">
      ${actions.addChild ? '<button type="button" data-details-action="add-child">新增子任务</button>' : ''}
      ${actions.cancel ? '<button type="button" data-details-action="cancel">取消任务</button>' : ''}
      ${actions.archive ? '<button type="button" data-details-action="archive">归档</button>' : ''}
      ${actions.restore ? '<button type="button" data-details-action="restore">恢复</button>' : ''}
      ${actions.delete ? '<button class="is-danger" type="button" data-details-action="delete">删除</button>' : ''}
    </footer>`
}

function focusableElements(element) {
  return [...element.querySelectorAll('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex="-1"])')]
    .filter((candidate) => !candidate.closest('[hidden]'))
}

export function createTaskDetailsSheet({
  element,
  backdrop,
  api,
  getTasks = () => [],
  onChanged = () => undefined,
  confirmImpl = globalThis.confirm?.bind(globalThis) ?? (() => true),
  clipboard = globalThis.navigator?.clipboard,
  randomId = () => globalThis.crypto.randomUUID(),
}) {
  const state = {
    id: null, detail: null, task: null, draft: null, executions: [], events: [],
    activeTab: 'summary', message: '', busy: false, showChildForm: false, returnFocus: null,
  }

  function isOpen() {
    return Boolean(state.id && !element.hidden)
  }

  function render() {
    if (!state.task) return
    renderPreservingFocus({
      root: element,
      fallbackSelector: '[data-details-close]',
      render: () => {
        element.innerHTML = detailsSheetMarkup({
          task: state.task,
          draft: state.draft,
          activeTab: state.activeTab,
          executions: state.executions,
          events: state.events,
          tasks: getTasks(),
          message: state.message,
          busy: state.busy,
          showChildForm: state.showChildForm,
        })
      },
    })
  }

  function close() {
    if (!isOpen()) return
    const taskId = state.id
    element.hidden = true
    backdrop.hidden = true
    document.documentElement.classList.remove('has-details-sheet')
    const target = restoreFocusTarget({
      returnFocus: state.returnFocus,
      taskId,
      findTaskTrigger: (id) => [...document.querySelectorAll('[data-task-details-id]')]
        .find((candidate) => candidate.dataset.taskDetailsId === id) ?? null,
      fallback: document.querySelector('.tab.is-active'),
    })
    state.id = null
    target?.focus({ preventScroll: true })
  }

  async function load({ preserveDraft = false } = {}) {
    if (!state.id) return
    const id = state.id
    state.busy = true
    if (state.task) render()
    try {
      const [detail, executions, events] = await Promise.all([
        api.task(id),
        api.executions({ task_id: id }),
        api.events(id),
      ])
      if (state.id !== id) return
      const localDraft = state.draft
      state.detail = detail
      const projection = getTasks().find((task) => task.id === id)
      state.task = {
        ...detail.task,
        ...(projection ? {
          project_id: projection.project_id,
          entity_type: projection.entity_type,
        } : {}),
      }
      state.executions = executions
      state.events = events
      state.draft = preserveDraft && localDraft ? localDraft : taskDraft(detail.task)
      state.message = ''
    } catch (error) {
      if (state.id === id) state.message = error.message
    } finally {
      if (state.id === id) {
        state.busy = false
        render()
      }
    }
  }

  async function open(id, { trigger = document.activeElement } = {}) {
    state.id = id
    state.returnFocus = trigger
    state.activeTab = 'summary'
    state.message = ''
    state.showChildForm = false
    state.task = getTasks().find((task) => task.id === id) ?? { id, title: id, status: 'planned' }
    state.draft = taskDraft(state.task)
    element.hidden = false
    backdrop.hidden = false
    document.documentElement.classList.add('has-details-sheet')
    render()
    element.querySelector('[data-details-close]')?.focus({ preventScroll: true })
    await load()
  }

  function readDraft() {
    const form = element.querySelector('[data-details-form]')
    if (!form) return state.draft
    const values = Object.fromEntries(new FormData(form))
    return { ...state.draft, ...values }
  }

  async function runMutation(operation) {
    if (!state.task || state.busy) return
    state.busy = true
    state.message = ''
    render()
    try {
      const result = await operation()
      state.task = result.task ?? state.task
      state.draft = taskDraft(state.task)
      state.message = '已保存'
      await onChanged()
      await load()
    } catch (error) {
      if (error.code === 'TASK_VERSION_CONFLICT' && error.details?.task) {
        const conflict = conflictViewState({ draft: state.draft, latestTask: error.details.task })
        state.task = conflict.task
        state.draft = conflict.draft
        state.message = conflict.message
      } else {
        state.message = error.message
      }
    } finally {
      state.busy = false
      render()
    }
  }

  element.addEventListener('input', (event) => {
    if (!event.target.name || !event.target.closest('[data-details-form]')) return
    state.draft = { ...state.draft, [event.target.name]: event.target.value }
  })

  element.addEventListener('submit', async (event) => {
    event.preventDefault()
    if (event.target.matches('[data-details-form]')) {
      state.draft = readDraft()
      let patch
      try {
        patch = taskPatch(state.task, state.draft)
      } catch (error) {
        state.message = error.message
        render()
        return
      }
      if (Object.keys(patch).length === 0) {
        state.message = '没有需要保存的更改'
        render()
        return
      }
      await runMutation(() => api.updateTask(state.task.id, state.task.revision, patch))
      return
    }
    if (event.target.matches('[data-child-form]')) {
      const title = String(new FormData(event.target).get('title') ?? '').trim()
      const sessions = [...(state.detail?.sessions ?? [])].sort((left, right) => (
        String(right.last_seen_at ?? '').localeCompare(String(left.last_seen_at ?? ''))
      ))
      const context = sessions[0]
      if (!title || !context?.session_id || !context?.workfolder) {
        state.message = title ? '该任务没有可用于创建子任务的 Session context' : '请输入子任务标题'
        render()
        return
      }
      await runMutation(async () => {
        await api.createChild(randomId(), {
          title,
          parent_id: state.task.id,
          project: state.task.project,
          session_id: context.session_id,
          workfolder: context.workfolder,
        })
        state.showChildForm = false
        return { task: state.task }
      })
    }
  })

  element.addEventListener('click', async (event) => {
    const closeButton = event.target.closest('[data-details-close]')
    if (closeButton) {
      close()
      return
    }
    const tab = event.target.closest('[data-details-tab]')
    if (tab) {
      state.draft = readDraft()
      state.activeTab = tab.dataset.detailsTab
      render()
      element.querySelector(`[data-details-tab="${state.activeTab}"]`)?.focus({ preventScroll: true })
      return
    }
    const copy = event.target.closest('[data-copy-value]')
    if (copy) {
      try {
        await clipboard?.writeText(copy.dataset.copyValue)
        state.message = 'Session ID 已复制'
      } catch {
        state.message = '复制失败，请手动选择 Session ID'
      }
      render()
      return
    }
    const action = event.target.closest('[data-details-action]')?.dataset.detailsAction
    if (!action) return
    state.draft = readDraft()
    if (action === 'add-child') {
      state.showChildForm = true
      render()
      element.querySelector('[data-child-form] input')?.focus({ preventScroll: true })
    } else if (action === 'dismiss-child') {
      state.showChildForm = false
      render()
    } else if (action === 'cancel') {
      await runMutation(() => api.updateTask(state.task.id, state.task.revision, { status: 'canceled' }))
    } else if (action === 'archive') {
      await runMutation(() => api.archiveTask(state.task.id, state.task.revision))
    } else if (action === 'restore') {
      await runMutation(() => api.restoreTask(state.task.id, state.task.revision))
    } else if (action === 'delete' && confirmImpl(`删除任务“${state.task.title}”？可稍后恢复。`)) {
      await runMutation(() => api.deleteTask(state.task.id, state.task.revision))
    }
  })

  element.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      close()
      return
    }
    if (event.key !== 'Tab') return
    const focusable = focusableElements(element)
    const target = focusTrapTarget({
      current: focusable.indexOf(document.activeElement),
      count: focusable.length,
      shiftKey: event.shiftKey,
    })
    if (target === null) return
    event.preventDefault()
    focusable[target]?.focus({ preventScroll: true })
  })
  backdrop.addEventListener('click', close)

  return {
    open,
    close,
    refresh: () => load({ preserveDraft: true }),
    isOpen,
    selectedId: () => state.id,
  }
}
