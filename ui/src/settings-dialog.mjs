import { escapeHtml } from './dashboard-state.mjs'

function terminalOption(option, selected) {
  const unavailable = !option.available
  return `<option value="${escapeHtml(option.id)}"${option.id === selected ? ' selected' : ''}${unavailable ? ' disabled' : ''}>${escapeHtml(option.label)}${unavailable ? ' · 未安装' : ''}</option>`
}

export function settingsDialogMarkup({
  settings = { resume_terminal: 'terminal', schedule_definitions_dir: '' },
  terminalOptions = [],
  loading = false,
  saving = false,
  message = '',
  error = false,
} = {}) {
  const selected = settings.resume_terminal ?? 'terminal'
  const selectedOption = terminalOptions.find(({ id }) => id === selected)
  const options = terminalOptions.map((option) => terminalOption(option, selected)).join('')
  const availability = selectedOption
    ? (selectedOption.available ? '已就绪' : '当前未安装')
    : '等待读取配置'
  return `<section class="settings-shell" role="dialog" aria-modal="true" aria-labelledby="settings-title settings-general-title">
    <aside class="settings-sidebar">
      <div class="settings-brand"><h2 id="settings-title">Settings</h2></div>
      <nav class="settings-navigation" aria-label="设置分类"><button class="settings-nav-item is-active" type="button" aria-current="page"><span class="settings-nav-icon" aria-hidden="true"></span><span>General</span></button></nav>
    </aside>
    <div class="settings-content">
      <button class="settings-close" type="button" data-settings-close aria-label="关闭设置"><span aria-hidden="true">×</span></button>
      <header class="settings-heading"><h3 id="settings-general-title">General</h3></header>
      <section class="settings-group" aria-labelledby="resume-settings-title">
        <div class="settings-group-heading"><span class="settings-section-icon" aria-hidden="true"></span><div><h4 id="resume-settings-title">Session resume</h4><p>从任务上下文返回真实的 Codex 会话。</p></div></div>
        <div class="settings-row">
          <label for="resume-terminal"><strong>Terminal</strong><span>点击任务行尾部按钮时使用的终端</span></label>
          <select id="resume-terminal" data-settings-terminal${loading || saving ? ' disabled' : ''}>${loading ? '<option>读取中…</option>' : options}</select>
        </div>
        <div class="settings-meta"><span class="settings-availability${selectedOption?.available === false ? ' is-unavailable' : ''}"><i aria-hidden="true"></i>${escapeHtml(availability)}</span><code>codex resume · cwd: Workspace</code></div>
      </section>
      <section class="settings-group" aria-labelledby="definitions-settings-title">
        <div class="settings-group-heading"><span class="settings-folder-icon" aria-hidden="true"></span><div><h4 id="definitions-settings-title">Schedule definitions</h4><p>Markdown 是 Schedule 的唯一 source of truth。</p></div></div>
        <div class="settings-row settings-directory-row">
          <label for="schedule-definitions-dir"><strong>Definitions directory</strong><span>递归读取带 tasks-recorder/schedule marker 的 Markdown</span></label>
          <div class="settings-directory-control"><input id="schedule-definitions-dir" data-settings-definitions-dir value="${escapeHtml(settings.schedule_definitions_dir || '')}" spellcheck="false"${loading || saving ? ' disabled' : ''}><button type="button" data-settings-save-definitions${loading || saving ? ' disabled' : ''}>Save</button></div>
        </div>
      </section>
      <div class="settings-message${message ? ' is-visible' : ''}${error ? ' is-error' : ''}" role="status" aria-live="polite">${escapeHtml(message)}</div>
    </div>
  </section>`
}

export function isRenderedFocusable(candidate) {
  if (candidate?.closest?.('[hidden]')) return false
  if (typeof candidate?.getClientRects !== 'function') return true
  return candidate.getClientRects().length > 0
}

export function relocationMessage(result = {}) {
  const relocation = result?.relocation
  if (!relocation) return '设置已保存'
  const parts = ['目录已切换', `迁移 ${Number(relocation.moved_count) || 0}`]
  if ((Number(relocation.merged_count) || 0) > 0) parts.push(`合并 ${Number(relocation.merged_count)}`)
  if (relocation.cleanup_warning) parts.push('旧目录保留了未清理文件')
  return parts.join(' · ')
}

function focusableElements(element) {
  return [...element.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])')]
    .filter(isRenderedFocusable)
}

export function createSettingsDialog({ element, backdrop, api } = {}) {
  const state = {
    open: false,
    settings: { resume_terminal: 'terminal', schedule_definitions_dir: '' },
    terminalOptions: [],
    loading: false,
    saving: false,
    message: '',
    error: false,
    returnFocus: null,
  }

  function render() {
    element.innerHTML = settingsDialogMarkup(state)
  }

  async function load() {
    state.loading = true
    state.message = ''
    state.error = false
    render()
    try {
      const result = await api.settings()
      state.settings = result.settings
      state.terminalOptions = result.terminal_options
    } catch (error) {
      state.message = error?.message ?? '无法读取设置'
      state.error = true
    } finally {
      state.loading = false
      if (state.open) {
        render()
        element.querySelector('[data-settings-terminal]')?.focus({ preventScroll: true })
      }
    }
  }

  function open(trigger = document.activeElement) {
    state.open = true
    state.returnFocus = trigger
    state.message = ''
    state.error = false
    element.hidden = false
    backdrop.hidden = false
    render()
    element.querySelector('[data-settings-close]')?.focus({ preventScroll: true })
    void load()
  }

  function close() {
    if (!state.open) return
    state.open = false
    element.hidden = true
    backdrop.hidden = true
    const target = state.returnFocus?.isConnected
      ? state.returnFocus
      : document.querySelector('[data-settings-toggle]')
    target?.focus({ preventScroll: true })
  }

  element.addEventListener('click', async (event) => {
    if (event.target.closest('[data-settings-close]')) close()
    if (!event.target.closest('[data-settings-save-definitions]') || state.saving) return
    const input = element.querySelector('[data-settings-definitions-dir]')
    const previous = state.settings.schedule_definitions_dir
    state.saving = true
    state.message = '正在保存…'
    state.error = false
    try {
      const result = await api.updateSettings({ schedule_definitions_dir: input?.value ?? '' })
      state.settings = result.settings
      state.terminalOptions = result.terminal_options
      state.message = relocationMessage(result)
    } catch (error) {
      state.settings = { ...state.settings, schedule_definitions_dir: previous }
      state.message = error?.message ?? 'Definitions directory 保存失败'
      state.error = true
    } finally {
      state.saving = false
      if (state.open) {
        render()
        element.querySelector('[data-settings-definitions-dir]')?.focus({ preventScroll: true })
      }
    }
  })
  element.addEventListener('change', async (event) => {
    const select = event.target.closest('[data-settings-terminal]')
    if (!select || state.saving) return
    const previous = state.settings.resume_terminal
    state.settings = { ...state.settings, resume_terminal: select.value }
    state.saving = true
    state.message = '正在保存…'
    state.error = false
    render()
    try {
      const result = await api.updateSettings({ resume_terminal: select.value })
      state.settings = result.settings
      state.terminalOptions = result.terminal_options
      state.message = '设置已保存'
    } catch (error) {
      state.settings = { ...state.settings, resume_terminal: previous }
      state.message = error?.message ?? '设置保存失败'
      state.error = true
    } finally {
      state.saving = false
      if (state.open) {
        render()
        element.querySelector('[data-settings-terminal]')?.focus({ preventScroll: true })
      }
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

  return { open, close, isOpen: () => state.open }
}
