import { renderPreservingFocus } from './focus-state.mjs'

function normalized(value) {
  return String(value ?? '').trim().toLocaleLowerCase()
}

export function filterInboxExecutions(executions, filters = {}) {
  const query = normalized(filters.query)
  const rootSessionId = String(filters.rootSessionId ?? '').trim()
  const status = String(filters.status ?? '').trim()
  const startedAfter = filters.startedAfter ? Date.parse(filters.startedAfter) : null
  return executions.filter((execution) => {
    if (rootSessionId && execution.root_session_id !== rootSessionId) return false
    if (status && execution.status !== status) return false
    if (startedAfter !== null && (Date.parse(execution.started_at) || 0) < startedAfter) return false
    if (!query) return true
    return [
      execution.id,
      execution.root_session_id,
      execution.session_id,
      execution.agent_type,
      execution.agent_path,
      execution.workfolder,
      execution.worktree,
      execution.branch,
    ].some((value) => normalized(value).includes(query))
  })
}

export function reconcileInboxSelection(selection, executions) {
  const available = new Set(executions.map(({ id }) => id))
  return new Set([...selection].filter((id) => available.has(id)))
}

export function inboxButtonLabel(count) {
  return Number(count) > 0 ? `任务 ${count}` : '任务'
}

export function inboxExecutionPresentation(execution) {
  return {
    id: execution.id,
    rootSessionId: execution.root_session_id ?? '',
    sessionId: execution.session_id ?? '',
    agent: [execution.agent_type, execution.agent_path].filter(Boolean).join(' · ') || 'Unknown agent',
    context: [execution.worktree || execution.workfolder, execution.branch].filter(Boolean).join(' · ') || '—',
    status: execution.status ?? 'unknown',
    startedAt: execution.started_at ?? null,
  }
}

export function batchAssignmentPayload({
  executions,
  selectedIds,
  taskId = null,
  classification = taskId ? 'work' : null,
}) {
  const selected = executions.filter(({ id }) => selectedIds.has(id))
  if (selected.length === 0) throw new TypeError('at least one execution must be selected')
  const targetClassification = classification ?? (taskId ? 'work' : null)
  if (!['work', 'non_work'].includes(targetClassification)) {
    throw new TypeError('taskId or non_work classification is required')
  }
  if (targetClassification === 'work' && !taskId) throw new TypeError('work requires taskId')
  return {
    actor: 'user',
    changes: selected.map((execution) => ({
      id: execution.id,
      expected_task_id: execution.task_id ?? null,
      expected_classification: execution.classification,
      task_id: targetClassification === 'work' ? taskId : null,
      classification: targetClassification,
    })),
  }
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

export function inboxMutationMessage(error) {
  if (error?.code === 'EXECUTION_BATCH_CONFLICT') {
    const count = error.details?.conflicts?.length ?? 0
    return `${count || '部分'} 个 Execution 已在其他位置更新；列表已刷新，请重新选择。`
  }
  if (error?.code === 'TASK_NOT_FOUND') return '目标任务已不存在；任务列表已刷新。'
  return error?.message ?? 'Execution 更新失败，请重试。'
}

function taskOptions(tasks) {
  const byId = new Map(tasks.map((task) => [task.id, task]))
  return tasks.map((task) => {
    let depth = 0
    let parent = task.parent_id ? byId.get(task.parent_id) : null
    const visited = new Set([task.id])
    while (parent && !visited.has(parent.id) && depth < 8) {
      visited.add(parent.id)
      depth += 1
      parent = parent.parent_id ? byId.get(parent.parent_id) : null
    }
    return `<option value="${escapeMarkup(task.id)}">${'— '.repeat(depth)}${escapeMarkup(task.title)}</option>`
  }).join('')
}

function executionRows(executions, selection) {
  return executions.map((execution) => {
    const item = inboxExecutionPresentation(execution)
    return `<li class="inbox-execution">
      <label class="inbox-select"><input type="checkbox" data-inbox-select="${escapeMarkup(item.id)}"${selection.has(item.id) ? ' checked' : ''}><span class="sr-only">选择 ${escapeMarkup(item.id)}</span></label>
      <div class="inbox-execution-main"><div class="inbox-execution-heading"><strong>${escapeMarkup(item.agent)}</strong><span class="execution-status is-${escapeMarkup(item.status)}">${escapeMarkup(item.status)}</span></div><code>${escapeMarkup(item.rootSessionId)}</code><span>${escapeMarkup(item.context)}</span><small>${escapeMarkup(timeLabel(item.startedAt))} · ${escapeMarkup(item.sessionId)}</small></div>
    </li>`
  }).join('')
}

export function inboxMarkup({
  executions = [],
  filtered = executions,
  selection = new Set(),
  tasks = [],
  filters = {},
  message = '',
  busy = false,
}) {
  const rootSessions = [...new Set(executions.map(({ root_session_id: id }) => id).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right))
  const allVisibleSelected = filtered.length > 0 && filtered.every(({ id }) => selection.has(id))
  return `<section class="inbox-shell" role="dialog" aria-modal="true" aria-labelledby="execution-inbox-title">
    <header class="inbox-header"><div><h2 id="execution-inbox-title">任务待归属</h2><p>${executions.length} 个 Work Execution</p></div><button class="details-close" type="button" data-inbox-close aria-label="关闭任务待归属">×</button></header>
    <div class="inbox-message${message ? ' is-visible' : ''}" role="status" aria-live="polite">${escapeMarkup(message)}</div>
    <div class="inbox-filters">
      <label><span>搜索 Agent / Path</span><input type="search" value="${escapeMarkup(filters.query)}" data-inbox-filter="query" placeholder="researcher / worktree"></label>
      <label><span>Root session</span><select data-inbox-filter="rootSessionId"><option value="">全部</option>${rootSessions.map((id) => `<option value="${escapeMarkup(id)}"${filters.rootSessionId === id ? ' selected' : ''}>${escapeMarkup(id)}</option>`).join('')}</select></label>
      <label><span>状态</span><select data-inbox-filter="status"><option value="">全部</option>${['active', 'completed', 'interrupted'].map((status) => `<option value="${status}"${filters.status === status ? ' selected' : ''}>${status}</option>`).join('')}</select></label>
      <label><span>开始日期</span><input type="date" value="${escapeMarkup(filters.startedAfter)}" data-inbox-filter="startedAfter"></label>
    </div>
    <div class="inbox-selection-bar"><label><input type="checkbox" data-inbox-select-all${allVisibleSelected ? ' checked' : ''}${filtered.length === 0 ? ' disabled' : ''}>选择当前结果</label><span>已选 ${selection.size}</span></div>
    <div class="inbox-list-wrap" aria-busy="${busy}"><ol class="inbox-list">${executionRows(filtered, selection) || '<li class="details-empty">没有匹配的待归属工作</li>'}</ol></div>
    <footer class="inbox-actions"><label><span class="sr-only">分配到任务</span><select data-inbox-task><option value="">选择目标 Task…</option>${taskOptions(tasks)}</select></label><button type="button" data-inbox-action="assign"${selection.size === 0 || busy ? ' disabled' : ''}>分配</button><button type="button" data-inbox-action="non-work"${selection.size === 0 || busy ? ' disabled' : ''}>标记 non-work</button></footer>
  </section>`
}

function inboxFilters(state) {
  return {
    ...state.filters,
    startedAfter: state.filters.startedAfter
      ? `${state.filters.startedAfter}T00:00:00.000Z`
      : '',
  }
}

function focusableElements(element) {
  return [...element.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])')]
}

export function createExecutionInbox({
  element,
  backdrop,
  api,
  getTasks = () => [],
  onChanged = () => undefined,
}) {
  const state = {
    open: false,
    executions: [],
    selection: new Set(),
    filters: { query: '', rootSessionId: '', status: '', startedAfter: '' },
    message: '',
    busy: false,
    returnFocus: null,
  }

  function filtered() {
    return filterInboxExecutions(state.executions, inboxFilters(state))
  }

  function render() {
    renderPreservingFocus({
      root: element,
      fallbackSelector: '[data-inbox-close]',
      render: () => {
        element.innerHTML = inboxMarkup({
          executions: state.executions,
          filtered: filtered(),
          selection: state.selection,
          tasks: getTasks(),
          filters: state.filters,
          message: state.message,
          busy: state.busy,
        })
      },
    })
  }

  async function load({ message = '' } = {}) {
    state.busy = true
    if (state.open) render()
    try {
      state.executions = await api.executions({ unassigned: true })
      state.selection = reconcileInboxSelection(state.selection, state.executions)
      state.message = message
    } catch (error) {
      state.message = error.message
    } finally {
      state.busy = false
      if (state.open) render()
    }
  }

  async function open(trigger = document.activeElement) {
    state.open = true
    state.returnFocus = trigger
    element.hidden = false
    backdrop.hidden = false
    render()
    element.querySelector('[data-inbox-close]')?.focus({ preventScroll: true })
    await load()
  }

  function close() {
    if (!state.open) return
    state.open = false
    element.hidden = true
    backdrop.hidden = true
    const target = state.returnFocus?.isConnected
      ? state.returnFocus
      : document.querySelector('[data-execution-inbox-toggle]')
    target?.focus({ preventScroll: true })
  }

  async function mutate(payload) {
    state.busy = true
    state.message = ''
    render()
    try {
      await api.updateExecutionAssignments(payload)
      state.selection.clear()
      await onChanged()
      await load({ message: 'Execution 已更新' })
    } catch (error) {
      state.selection.clear()
      await load({ message: inboxMutationMessage(error) })
    } finally {
      state.busy = false
      render()
    }
  }

  element.addEventListener('input', (event) => {
    const field = event.target.dataset.inboxFilter
    if (!field) return
    state.filters[field] = event.target.value
    const focusField = field
    render()
    const next = element.querySelector(`[data-inbox-filter="${focusField}"]`)
    next?.focus({ preventScroll: true })
    if (next?.setSelectionRange) next.setSelectionRange(next.value.length, next.value.length)
  })
  element.addEventListener('change', (event) => {
    const executionId = event.target.dataset.inboxSelect
    if (executionId) {
      if (event.target.checked) state.selection.add(executionId)
      else state.selection.delete(executionId)
      render()
      return
    }
    if (event.target.matches('[data-inbox-select-all]')) {
      for (const execution of filtered()) {
        if (event.target.checked) state.selection.add(execution.id)
        else state.selection.delete(execution.id)
      }
      render()
    }
  })
  element.addEventListener('click', async (event) => {
    if (event.target.closest('[data-inbox-close]')) {
      close()
      return
    }
    const action = event.target.closest('[data-inbox-action]')?.dataset.inboxAction
    if (!action || state.busy) return
    try {
      const payload = action === 'non-work'
        ? batchAssignmentPayload({
          executions: state.executions,
          selectedIds: state.selection,
          classification: 'non_work',
        })
        : batchAssignmentPayload({
          executions: state.executions,
          selectedIds: state.selection,
          taskId: element.querySelector('[data-inbox-task]')?.value,
        })
      await mutate(payload)
    } catch (error) {
      state.message = error.message
      render()
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
    const current = focusable.indexOf(document.activeElement)
    const target = event.shiftKey && current === 0
      ? focusable.at(-1)
      : (!event.shiftKey && current === focusable.length - 1 ? focusable[0] : null)
    if (!target) return
    event.preventDefault()
    target.focus({ preventScroll: true })
  })
  backdrop.addEventListener('click', close)

  return {
    open,
    close,
    refresh: load,
    isOpen: () => state.open,
  }
}
