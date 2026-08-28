import { CalendarClock, ListTree } from 'lucide-react'

import { Button } from '@/components/ui/button'
import type { DashboardView } from '@/lib/preferences/dashboard-preferences'

export function Navigation({
  view,
  onViewChange,
}: {
  view: DashboardView
  onViewChange: (view: DashboardView) => void
}) {
  return (
    <nav className="app-navigation" aria-label="Dashboard views">
      <Button
        type="button"
        className={`app-navigation__item${view === 'tasks' ? ' is-active' : ''}`}
        aria-current={view === 'tasks' ? 'page' : undefined}
        size="xs"
        variant={view === 'tasks' ? 'secondary' : 'quiet'}
        onPress={() => onViewChange('tasks')}
      >
        <ListTree aria-hidden="true" />
        Tasks
      </Button>
      <Button
        type="button"
        className={`app-navigation__item${view === 'scheduled' ? ' is-active' : ''}`}
        aria-current={view === 'scheduled' ? 'page' : undefined}
        size="xs"
        variant={view === 'scheduled' ? 'secondary' : 'quiet'}
        onPress={() => onViewChange('scheduled')}
      >
        <CalendarClock aria-hidden="true" />
        Scheduled
      </Button>
    </nav>
  )
}
