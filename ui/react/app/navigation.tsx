import { CalendarClock, ListTree } from 'lucide-react'

import { Button } from '@/components/ui/button'
import type { DashboardView } from '@/lib/preferences/dashboard-preferences'

export function Navigation({ view }: { view: DashboardView }) {
  return (
    <nav className="app-navigation" aria-label="Dashboard views">
      <Button
        type="button"
        className="app-navigation__item is-active"
        aria-current={view === 'tasks' ? 'page' : undefined}
        size="xs"
        variant="secondary"
      >
        <ListTree aria-hidden="true" />
        Tasks
      </Button>
      <Button
        type="button"
        className="app-navigation__item"
        aria-label="Scheduled（迁移中）"
        isDisabled
        size="xs"
        variant="quiet"
      >
        <CalendarClock aria-hidden="true" />
        Scheduled
        <span className="app-navigation__migration">迁移中</span>
      </Button>
    </nav>
  )
}
