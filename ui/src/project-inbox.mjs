import { copyTextToClipboard, escapeHtml } from './dashboard-state.mjs'

export function projectInboxButtonLabel(count) {
  return Number(count) > 0 ? `项目 ${count}` : '项目'
}

function timestamp(value) {
  const date = new Date(value)
  if (Number.isNaN(date.valueOf())) return '时间未知'
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date)
}

export function projectInboxPresentation(session) {
  return {
    id: session.id,
    source: session.source || 'unknown',
    sessionId: session.external_session_id || '—',
    rootSessionId: session.root_external_session_id || session.external_session_id || '—',
    agent: session.agent || 'Unknown',
    context: [session.worktree || session.workfolder, session.branch].filter(Boolean).join(' · ') || '未发现本地路径',
    lastSeen: timestamp(session.last_seen_at),
  }
}

function projectOptions(projects) {
  return projects.map((project) => (
    `<option value="${escapeHtml(project.id)}">${escapeHtml(project.name)}</option>`
  )).join('')
}

export function projectInboxMarkup({ sessions = [], projects = [], message = '', busyId = null }) {
  const options = projectOptions(projects)
  const rows = sessions.map((session) => {
    const item = projectInboxPresentation(session)
    const busy = busyId === item.id
    return `<li class="project-inbox-session" data-project-session-row="${escapeHtml(item.id)}">
      <div class="project-inbox-session-head"><span class="source-badge">${escapeHtml(item.source)}</span><time>${escapeHtml(item.lastSeen)}</time></div>
      <div class="project-inbox-identity"><code title="${escapeHtml(item.sessionId)}">${escapeHtml(item.sessionId)}</code><button type="button" data-project-session-copy="${escapeHtml(item.sessionId)}" aria-label="复制 Session ID ${escapeHtml(item.sessionId)}">复制</button></div>
      <strong>${escapeHtml(item.agent)}</strong>
      <span class="project-inbox-context" title="${escapeHtml(item.context)}">${escapeHtml(item.context)}</span>
      <small>Root · ${escapeHtml(item.rootSessionId)}</small>
      <div class="project-inbox-assign"><label><span class="sr-only">选择 Project</span><select data-project-choice${projects.length === 0 || busy ? ' disabled' : ''}><option value="">选择 Project…</option>${options}</select></label><button type="button" data-project-assign="${escapeHtml(item.id)}"${projects.length === 0 || busy ? ' disabled' : ''}>${busy ? '归属中…' : '确认归属'}</button></div>
    </li>`
  }).join('')
  return `<section class="inbox-shell project-inbox-shell" role="dialog" aria-modal="true" aria-labelledby="project-inbox-title">
    <header class="inbox-header"><div><span class="details-eyebrow">Project resolution</span><h2 id="project-inbox-title">项目待认领</h2><p>${sessions.length} 个 Source Session</p></div><button class="details-close" type="button" data-project-inbox-close aria-label="关闭项目待认领">×</button></header>
    <div class="inbox-message${message ? ' is-visible' : ''}" role="status" aria-live="polite">${escapeHtml(message)}</div>
    <p class="project-inbox-explainer">Project 只接受你的显式选择或已登记的本地路径；branch 名不会自动合并项目。</p>
    <div class="inbox-list-wrap" aria-busy="${Boolean(busyId)}"><ol class="inbox-list project-inbox-list">${rows || '<li class="details-empty">所有 Session 都已归属 Project</li>'}</ol></div>
  </section>`
}

function focusableElements(element) {
  return [...element.querySelectorAll('button:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])')]
}

export function createProjectInbox({ element, backdrop, api, onChanged = () => undefined }) {
  const state = {
    open: false,
    sessions: [],
    projects: [],
    message: '',
    busyId: null,
    returnFocus: null,
  }

  function render() {
    element.innerHTML = projectInboxMarkup(state)
  }

  function setData(sessions = [], projects = []) {
    state.sessions = Array.isArray(sessions) ? sessions : []
    state.projects = Array.isArray(projects) ? projects : []
    if (state.open) render()
  }

  function open(trigger = document.activeElement) {
    state.open = true
    state.returnFocus = trigger
    state.message = ''
    element.hidden = false
    backdrop.hidden = false
    render()
    element.querySelector('[data-project-inbox-close]')?.focus({ preventScroll: true })
  }

  function close() {
    if (!state.open) return
    state.open = false
    element.hidden = true
    backdrop.hidden = true
    const target = state.returnFocus?.isConnected
      ? state.returnFocus
      : document.querySelector('[data-project-inbox-toggle]')
    target?.focus({ preventScroll: true })
  }

  element.addEventListener('click', async (event) => {
    if (event.target.closest('[data-project-inbox-close]')) {
      close()
      return
    }
    const copy = event.target.closest('[data-project-session-copy]')
    if (copy) {
      const copied = await copyTextToClipboard(copy.dataset.projectSessionCopy)
      state.message = copied ? 'Session ID 已复制' : '复制失败，请手动选择 Session ID'
      render()
      return
    }
    const trigger = event.target.closest('[data-project-assign]')
    if (!trigger || state.busyId) return
    const row = trigger.closest('[data-project-session-row]')
    const projectId = row?.querySelector('[data-project-choice]')?.value
    if (!projectId) {
      state.message = '请先选择目标 Project'
      render()
      return
    }
    state.busyId = trigger.dataset.projectAssign
    state.message = ''
    render()
    try {
      await api.assignSourceSessionProject(state.busyId, projectId, null)
      state.sessions = state.sessions.filter(({ id }) => id !== state.busyId)
      state.message = 'Project 归属已更新'
      await onChanged()
    } catch (error) {
      state.message = error?.code === 'SOURCE_SESSION_PROJECT_CONFLICT'
        ? '该 Session 已在其他位置更新，已重新加载'
        : (error?.message ?? 'Project 归属失败')
      await onChanged()
    } finally {
      state.busyId = null
      if (state.open) render()
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

  return { open, close, setData, isOpen: () => state.open }
}
