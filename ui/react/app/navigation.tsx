import { CalendarClock, ListTree } from 'lucide-react'

import type { DashboardView } from '@/lib/preferences/dashboard-preferences'

export function Navigation({ view }: { view: DashboardView }) {
  return (
    <nav className="app-navigation" aria-label="Dashboard views">
      <button
        type="button"
        className="app-navigation__item is-active"
        aria-current={view === 'tasks' ? 'page' : undefined}
        tabIndex={0}
      >
        <ListTree aria-hidden="true" />
        Tasks
      </button>
      <button
        type="button"
        className="app-navigation__item"
        aria-label="Scheduled（迁移中）"
        aria-disabled="true"
        disabled
      >
        <CalendarClock aria-hidden="true" />
        Scheduled
        <span className="app-navigation__migration">迁移中</span>
      </button>
    </nav>
  )
}
