import { useQueryClient } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import { useMemo, useState } from 'react'

import { Button } from '@/components/ui/button'
import { SearchField } from '@/components/ui/search-field'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { DashboardApi } from '@/lib/api/dashboard-api'
import type { ScheduleListResponse, ScheduleRecord } from '@/lib/api/types'
import { queryKeys } from '@/lib/query/keys'
import { ScheduleCard, type ScheduleBusyAction } from './schedule-card'
import { filterSchedules, type ScheduleFilter } from './schedule-format'

function idempotencyKey() {
  return globalThis.crypto?.randomUUID?.()
    ?? `manual-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export function ScheduledView({
  api,
  data,
  isPending,
  error,
  onCreate,
  onEdit,
  onReview,
}: {
  api: DashboardApi
  data: ScheduleListResponse | null
  isPending: boolean
  error: Error | null
  onCreate?: () => void
  onEdit?: (schedule: ScheduleRecord) => void
  onReview?: (schedule: ScheduleRecord) => void
}) {
  const queryClient = useQueryClient()
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<ScheduleFilter>('all')
  const [busy, setBusy] = useState<{ id: string; action: ScheduleBusyAction } | null>(null)
  const [mutationError, setMutationError] = useState('')
  const jobs = data?.jobs ?? []
  const visible = useMemo(() => filterSchedules(jobs, { query, status }), [jobs, query, status])
  const activeCount = jobs.filter(({ enabled }) => enabled).length
  const unreadCount = jobs.reduce((total, schedule) => total + (schedule.unread_run_count ?? 0), 0)
  const controlsDisabled = isPending || data?.capability.supported === false

  async function mutate(schedule: ScheduleRecord, action: Exclude<ScheduleBusyAction, null>) {
    if (busy) return
    setBusy({ id: schedule.id, action })
    setMutationError('')
    try {
      if (action === 'run') await api.runScheduleNow(schedule.id, idempotencyKey())
      else if (action === 'pause') await api.pauseSchedule(schedule.id, schedule.etag)
      else await api.resumeSchedule(schedule.id, schedule.etag)
      await queryClient.invalidateQueries({ queryKey: queryKeys.schedules })
    } catch (caught) {
      setMutationError(caught instanceof Error ? caught.message : 'Schedule 更新失败')
    } finally {
      setBusy(null)
    }
  }

  let content
  if (data?.capability.supported === false) {
    content = (
      <div className="scheduled-state" role="status">
        <strong>当前环境不支持 Scheduled Tasks</strong>
        <span>{data.capability.backend ? `Backend · ${data.capability.backend}` : 'Scheduler capability 暂不可用'}</span>
      </div>
    )
  } else if (isPending) {
    content = <div className="scheduled-state" role="status" aria-busy="true">正在读取 Scheduled Tasks…</div>
  } else if (error) {
    content = (
      <div className="scheduled-state is-error" role="alert">
        <strong>Scheduled Tasks 暂不可用</strong>
        <span>{error.message}</span>
      </div>
    )
  } else if (jobs.length === 0) {
    content = (
      <div className="scheduled-state">
        <strong>还没有 Scheduled Task</strong>
        <span>创建一个本机 Agent 工作计划。</span>
      </div>
    )
  } else if (visible.length === 0) {
    content = <div className="scheduled-state">没有匹配的 Scheduled Task</div>
  } else {
    content = (
      <ol className="schedule-list">
        {visible.map((schedule) => (
          <ScheduleCard
            key={schedule.id}
            schedule={schedule}
            busyAction={busy?.id === schedule.id ? busy.action : null}
            onRunNow={(current) => void mutate(current, 'run')}
            onToggle={(current) => void mutate(current, current.enabled ? 'pause' : 'resume')}
            onEdit={onEdit}
            onReview={onReview}
          />
        ))}
      </ol>
    )
  }

  return (
    <section className="scheduled-workspace" aria-labelledby="scheduled-title">
      <header className="scheduled-header">
        <div>
          <h1 id="scheduled-title">Scheduled</h1>
          <p>{jobs.length} 个计划 · {activeCount} 个启用{unreadCount ? ` · ${unreadCount} 条未读` : ''}</p>
        </div>
        <Button isDisabled={!onCreate || controlsDisabled} size="sm" onPress={onCreate}>
          <Plus aria-hidden="true" />
          新建计划
        </Button>
      </header>

      <div className="scheduled-toolbar">
        <SearchField
          aria-label="搜索 Scheduled Tasks"
          className="scheduled-toolbar__search"
          isDisabled={controlsDisabled}
          placeholder="搜索标题、Workspace 或 cadence"
          size="sm"
          value={query}
          onChange={setQuery}
        />
        <Select
          aria-label="Scheduled 状态"
          className="scheduled-toolbar__filter"
          isDisabled={controlsDisabled}
          selectedKey={status}
          onSelectionChange={(key) => setStatus(String(key) as ScheduleFilter)}
        >
          <SelectTrigger size="sm"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem id="all">全部状态</SelectItem>
            <SelectItem id="active">已启用</SelectItem>
            <SelectItem id="paused">已暂停</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {data?.invalid?.length ? (
        <div className="scheduled-definition-errors" role="alert">
          <strong>{data.invalid.length} 个 definition 未启用</strong>
          <span>修复 Markdown 后会自动重新读取。</span>
        </div>
      ) : null}
      {mutationError ? <div className="scheduled-mutation-error" role="alert">{mutationError}</div> : null}
      <div className="scheduled-list-region">{content}</div>
    </section>
  )
}

