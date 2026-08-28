import type { PropsWithChildren } from 'react'
import { Waypoints } from 'lucide-react'

import type { DashboardConnectionState } from '@/lib/events/dashboard-event-source'
import type { DashboardView } from '@/lib/preferences/dashboard-preferences'
import { ConnectionStatus } from './connection-status'
import { Navigation } from './navigation'

export function AppShell({
  children,
  connectionState,
  taskCount,
  view,
}: PropsWithChildren<{
  connectionState: DashboardConnectionState
  taskCount: number | null
  view: DashboardView
}>) {
  return (
    <div className="app-shell">
      <header className="app-shell__header">
        <div className="app-shell__brand">
          <span className="app-shell__mark" aria-hidden="true"><Waypoints /></span>
          <h1>Tasks Recorder</h1>
        </div>
        <Navigation view={view} />
        <div
          className="app-shell__actions"
          data-testid="global-actions"
          data-safe-area="global-actions"
        >
          <span className="app-shell__task-count" aria-live="polite">
            {taskCount === null ? '— 个任务' : `${taskCount} 个任务`}
          </span>
          <ConnectionStatus state={connectionState} />
        </div>
      </header>
      <main className="app-shell__main">{children}</main>
    </div>
  )
}
