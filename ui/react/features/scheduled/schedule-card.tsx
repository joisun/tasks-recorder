import {
  CalendarClock,
  History,
  Pause,
  Pencil,
  Play,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import type { ScheduleRecord } from '@/lib/api/types'
import {
  cadenceSummary,
  compactDateTime,
  isActiveRun,
  relativeTime,
  runStatusLabel,
} from './schedule-format'

export type ScheduleBusyAction = 'run' | 'pause' | 'resume' | null

export function ScheduleCard({
  schedule,
  busyAction = null,
  onRunNow,
  onToggle,
  onEdit,
  onReview,
}: {
  schedule: ScheduleRecord
  busyAction?: ScheduleBusyAction
  onRunNow: (schedule: ScheduleRecord) => void
  onToggle: (schedule: ScheduleRecord) => void
  onEdit?: (schedule: ScheduleRecord) => void
  onReview?: (schedule: ScheduleRecord) => void
}) {
  const execution = schedule.current_execution
  const runActive = isActiveRun(schedule)
  const unread = Math.max(0, schedule.unread_run_count ?? 0)
  const executionTime = execution?.finished_at
    ?? execution?.started_at
    ?? execution?.requested_at
    ?? null
  const executionMeta = execution
    ? [execution.output_count ? `${execution.output_count} outputs` : null, execution.error_code, relativeTime(executionTime)]
      .filter(Boolean).join(' · ')
    : '查看执行记录'

  return (
    <li className="schedule-row" data-enabled={schedule.enabled} data-schedule-id={schedule.id}>
      <div className="schedule-row__identity">
        <div className="schedule-row__title">
          <h2>{schedule.title || 'Untitled schedule'}</h2>
          {!schedule.enabled ? <span>已暂停</span> : null}
        </div>
        <p>{cadenceSummary(schedule.cadence)}</p>
        <code>{schedule.workspace || 'Workspace 未知'}</code>
      </div>

      <Button
        className="schedule-row__execution"
        aria-label={`查看 ${schedule.title} 的执行记录`}
        isDisabled={!onReview}
        size="sm"
        variant="quiet"
        onPress={() => onReview?.(schedule)}
      >
        <span
          className="schedule-row__status-dot"
          data-status={execution?.status ?? 'idle'}
          data-running={runActive || undefined}
          aria-hidden="true"
        />
        <span>
          <strong>{execution ? runStatusLabel(execution.status) : '尚未运行'}</strong>
          <small>{executionMeta}</small>
        </span>
        {unread ? <b aria-label={`${unread} 条未读记录`}>{unread}</b> : null}
      </Button>

      <div className="schedule-row__next">
        <span><CalendarClock aria-hidden="true" /> 下次运行</span>
        <time dateTime={schedule.next_run_at ?? undefined}>
          {schedule.enabled ? compactDateTime(schedule.next_run_at) : '—'}
        </time>
      </div>

      <div className="schedule-row__actions" aria-label={`${schedule.title} 操作`}>
        <Button
          aria-label="编辑 Schedule"
          isDisabled={!onEdit || busyAction !== null}
          isIconOnly
          size="sm"
          variant="quiet"
          onPress={() => onEdit?.(schedule)}
        >
          <Pencil aria-hidden="true" />
        </Button>
        <Button
          aria-label={runActive ? '已有 Run 正在执行' : '立即运行'}
          isDisabled={runActive || busyAction !== null}
          isIconOnly
          isPending={busyAction === 'run'}
          size="sm"
          variant="quiet"
          onPress={() => onRunNow(schedule)}
        >
          <Play aria-hidden="true" />
        </Button>
        <Button
          aria-label={schedule.enabled ? '暂停 Schedule' : '启用 Schedule'}
          isDisabled={busyAction !== null}
          isIconOnly
          isPending={busyAction === 'pause' || busyAction === 'resume'}
          size="sm"
          variant="quiet"
          onPress={() => onToggle(schedule)}
        >
          {schedule.enabled ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
        </Button>
        <Button
          className="schedule-row__history-action"
          aria-label="查看执行记录"
          isDisabled={!onReview}
          isIconOnly
          size="sm"
          variant="quiet"
          onPress={() => onReview?.(schedule)}
        >
          <History aria-hidden="true" />
        </Button>
      </div>
    </li>
  )
}

