import { useQuery } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'

import { DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Drawer } from '@/components/ui/drawer'
import type { DashboardApi } from '@/lib/api/dashboard-api'
import type { ScheduleRecord } from '@/lib/api/types'
import { queryKeys } from '@/lib/query/keys'
import { RunDetail } from './run-detail'
import { RunHistory } from './run-history'

const ACTIVE_RUN_STATUSES = new Set(['queued', 'claimed', 'running'])

export function RunReviewDrawer({
  api,
  schedule,
  open,
  onOpenChange,
}: {
  api: DashboardApi
  schedule: ScheduleRecord | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const scheduleDetail = useQuery({
    queryKey: queryKeys.schedule(schedule?.id ?? ''),
    queryFn: () => api.schedule(schedule?.id ?? ''),
    enabled: open && Boolean(schedule),
  })
  const history = useQuery({
    queryKey: queryKeys.runs(schedule?.id ?? ''),
    queryFn: () => api.scheduleRuns(schedule?.id ?? ''),
    enabled: open && Boolean(schedule),
    refetchOnMount: 'always',
  })
  const orderedRuns = useMemo(() => [...(history.data?.runs ?? [])].sort((left, right) => {
    const leftTime = Date.parse(left.finished_at ?? left.started_at ?? left.created_at) || 0
    const rightTime = Date.parse(right.finished_at ?? right.started_at ?? right.created_at) || 0
    return rightTime - leftTime
  }), [history.data?.runs])

  useEffect(() => {
    if (!open) return
    setSelectedRunId((current) => orderedRuns.some(({ id }) => id === current) ? current : orderedRuns[0]?.id ?? null)
  }, [open, orderedRuns])

  useEffect(() => {
    setSelectedRunId(null)
  }, [schedule?.id])

  const runDetail = useQuery({
    queryKey: queryKeys.run(selectedRunId ?? ''),
    queryFn: () => api.scheduledRun(selectedRunId ?? ''),
    enabled: open && Boolean(selectedRunId),
    refetchInterval: (query) => ACTIVE_RUN_STATUSES.has(query.state.data?.run.status ?? '')
      ? 2_000
      : false,
  })
  const currentSchedule = scheduleDetail.data?.job ?? schedule

  return (
    <Drawer isOpen={open} onOpenChange={onOpenChange} placement="right" swipeToDismiss={false} className="run-review-drawer">
      <DialogContent showCloseButton>
        <DialogHeader>
          <DialogTitle>{currentSchedule?.title ?? '执行记录'}</DialogTitle>
          <DialogDescription>运行记录、产出与可恢复 Session</DialogDescription>
        </DialogHeader>

        {history.isPending ? <div className="run-review-drawer__state" aria-busy="true">正在读取执行记录…</div> : null}
        {history.isError ? <div className="run-review-drawer__state is-error" role="alert">{history.error.message}</div> : null}
        {history.data ? (
          <div className="run-review-drawer__body">
            <RunHistory
              runs={orderedRuns}
              dispatches={history.data.dispatches ?? []}
              selectedRunId={selectedRunId}
              onSelect={setSelectedRunId}
            />
            <div className="run-review-drawer__detail">
              {runDetail.isPending && selectedRunId ? <div className="run-review-drawer__state" aria-busy="true">正在读取 Run…</div> : null}
              {runDetail.isError ? <div className="run-review-drawer__state is-error" role="alert">{runDetail.error.message}</div> : null}
              {runDetail.data ? <RunDetail key={runDetail.data.run.id} api={api} run={runDetail.data.run} /> : null}
              {!selectedRunId && !history.isPending ? <div className="run-review-drawer__state">选择一条 Run 查看详情</div> : null}
            </div>
          </div>
        ) : null}
      </DialogContent>
    </Drawer>
  )
}
