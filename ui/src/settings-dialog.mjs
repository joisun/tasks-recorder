import { escapeHtml } from './dashboard-state.mjs'

function terminalOption(option, selected) {
  const unavailable = !option.available
  return `<option value="${escapeHtml(option.id)}"${option.id === selected ? ' selected' : ''}${unavailable ? ' disabled' : ''}>${escapeHtml(option.label)}${unavailable ? ' · 未安装' : ''}</option>`
}

export function settingsDialogMarkup({
  settings = { resume_terminal: 'terminal' },
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
  return `<section class="settings-shell" role="dialog" aria-modal="true" aria-labelledby="settings-title" aria-describedby="settings-description">
    <aside class="settings-sidebar">
      <div class="settings-brand"><span class="settings-kicker">Tasks Recorder</span><h2 id="settings-title">Settings</h2></div>
      <nav class="settings-navigation" aria-label="设置分类"><button class="settings-nav-item is-active" type="button" aria-current="page"><span class="settings-nav-icon" aria-hidden="true"></span><span>General</span></button></nav>
      <p class="settings-version">Local control plane</p>
    </aside>
    <div class="settings-content">
      <button class="settings-close" type="button" data-settings-close aria-label="关闭设置"><span aria-hidden="true">×</span></button>
      <header class="settings-heading"><span class="settings-kicker">Preferences</span><h3>General</h3><p id="settings-description">配置会话召回方式。更多 Dashboard 偏好会继续收纳在这里。</p></header>
      <section class="settings-group" aria-labelledby="resume-settings-title">
        <div class="settings-group-heading"><span class="settings-section-icon" aria-hidden="true"></span><div><h4 id="resume-settings-title">Session resume</h4><p>从任务上下文返回真实的 Codex 会话。</p></div></div>
        <div class="settings-row">
          <label for="resume-terminal"><strong>Terminal</strong><span>点击任务行尾部按钮时使用的终端</span></label>
          <select id="resume-terminal" data-settings-terminal${loading || saving ? ' disabled' : ''}>${loading ? '<option>读取中…</option>' : options}</select>
        </div>
        <div class="settings-meta"><span class="settings-availability${selectedOption?.available === false ? ' is-unavailable' : ''}"><i aria-hidden="true"></i>${escapeHtml(availability)}</span><code>codex resume · cwd: Workspace</code></div>
      </section>
      <p class="settings-security-note">页面不会发送 shell command；taskd 会从本地记录重新解析 Session ID 与 Workspace，再交给受支持的 terminal adapter。</p>
      <div class="settings-message${message ? ' is-visible' : ''}${error ? ' is-error' : ''}" role="status" aria-live="polite">${escapeHtml(message)}</div>
    </div>
  </section>`
}

function focusableElements(element) {
  return [...element.querySelectorAll('button:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])')]
}

export function createSettingsDialog({ element, backdrop, api } = {}) {
  const state = {
    open: false,
    settings: { resume_terminal: 'terminal' },
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

  element.addEventListener('click', (event) => {
    if (event.target.closest('[data-settings-close]')) close()
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
