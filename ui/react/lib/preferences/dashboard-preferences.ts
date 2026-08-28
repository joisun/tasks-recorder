export type DashboardView = 'tasks'

export function readDashboardView(location = window.location): DashboardView {
  const view = new URLSearchParams(location.search).get('view')
  return view === 'tasks' ? view : 'tasks'
}

export function persistDashboardView(view: DashboardView, history = window.history) {
  const url = new URL(window.location.href)
  if (url.searchParams.get('view') === view) return
  url.searchParams.set('view', view)
  history.replaceState(history.state, '', `${url.pathname}${url.search}${url.hash}`)
}
