import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'

import { queryKeys } from '@/lib/query/keys'
import {
  persistDashboardView,
  readDashboardView,
} from '@/lib/preferences/dashboard-preferences'
import { ScheduledView } from '@/features/scheduled/scheduled-view'
import { TaskStatusNavigation, type TaskStatusScope } from '@/features/tasks/tasks-toolbar'
import { taskStatusCounts, TasksView } from '@/features/tasks/tasks-view'
import { AppShell } from './app-shell'
import { useDashboardApi, useDashboardConnection } from './app-providers'

export function DashboardApp() {
  const api = useDashboardApi()
  const connectionState = useDashboardConnection()
  const [view, setView] = useState(readDashboardView)
  const [taskStatus, setTaskStatus] = useState<TaskStatusScope>('all')
  const meta = useQuery({ queryKey: queryKeys.meta, queryFn: () => api.meta() })
  const snapshot = useQuery({
    queryKey: queryKeys.snapshot,
    queryFn: () => api.snapshot(),
    enabled: view === 'tasks',
  })
  const schedules = useQuery({
    queryKey: queryKeys.schedules,
    queryFn: () => api.schedules(),
    enabled: view === 'scheduled',
  })

  useEffect(() => persistDashboardView(view), [view])

  const taskCount = snapshot.data
    ? snapshot.data.tasks.filter(({ entity_type: entityType }) => entityType !== 'project').length
    : null

  const countLabel = view === 'tasks'
    ? (taskCount === null ? '— 个任务' : `${taskCount} 个任务`)
    : (schedules.data ? `${schedules.data.jobs.length} 个计划` : '— 个计划')

  return (
    <AppShell
      connectionState={connectionState}
      countLabel={countLabel}
      navigationAddon={view === 'tasks' && snapshot.data ? (
        <TaskStatusNavigation
          counts={taskStatusCounts(snapshot.data)}
          status={taskStatus}
          onStatusChange={setTaskStatus}
        />
      ) : null}
      onViewChange={setView}
      view={view}
    >
      {view === 'tasks' ? (
      <section
        className="tasks-workspace"
        aria-label="Tasks workspace"
        aria-busy={snapshot.isPending || meta.isPending}
        data-service-version={meta.data?.service_version}
      >
        {snapshot.data ? (
          <TasksView
            api={api}
            snapshot={snapshot.data}
            status={taskStatus}
          />
        ) : null}
        {snapshot.isError && !snapshot.data ? (
          <div className="tasks-workspace__unavailable" role="alert">
            <strong>无法读取任务数据</strong>
            <span>请确认 taskd 正在运行。</span>
          </div>
        ) : null}
      </section>
      ) : (
        <ScheduledView
          api={api}
          data={schedules.data ?? null}
          isPending={schedules.isPending}
          error={schedules.error}
        />
      )}
    </AppShell>
  )
}
