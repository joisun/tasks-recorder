import type {
  RunStatus,
  ScheduleCadence,
  ScheduleExecutionStatus,
  ScheduleRecord,
} from '@/lib/api/types'

export type ScheduleFilter = 'all' | 'active' | 'paused'

const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日']

function pad(value: number) {
  return String(value).padStart(2, '0')
}

function dateValue(value: string | null | undefined, fallback: number) {
  const timestamp = Date.parse(value ?? '')
  return Number.isFinite(timestamp) ? timestamp : fallback
}

export function compactDateTime(value: string | null | undefined) {
  const date = new Date(value ?? '')
  if (!Number.isFinite(date.getTime())) return '未安排'
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date)
}

export function fullDateTime(value: string | null | undefined) {
  const date = new Date(value ?? '')
  if (!Number.isFinite(date.getTime())) return '—'
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date)
}

export function runDuration(
  startedAt: string | null | undefined,
  finishedAt: string | null | undefined,
) {
  const started = Date.parse(startedAt ?? '')
  const finished = Date.parse(finishedAt ?? '')
  if (!Number.isFinite(started)) return '—'
  const duration = Math.max(0, (Number.isFinite(finished) ? finished : Date.now()) - started)
  if (duration < 1_000) return '<1s'
  if (duration < 60_000) return `${Math.round(duration / 1_000)}s`
  const minutes = Math.floor(duration / 60_000)
  const seconds = Math.round((duration % 60_000) / 1_000)
  if (minutes < 60) return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  return remainingMinutes ? `${hours}h ${remainingMinutes}m` : `${hours}h`
}

export function triggerLabel(trigger: string | null | undefined) {
  if (trigger === 'manual') return '手动'
  if (trigger === 'scheduled') return '计划'
  if (trigger === 'catchup') return '补跑'
  return trigger || '未知'
}

export function relativeTime(value: string | null | undefined, now = Date.now()) {
  const timestamp = Date.parse(value ?? '')
  if (!Number.isFinite(timestamp)) return '—'
  const delta = timestamp - now
  const absolute = Math.abs(delta)
  const formatter = new Intl.RelativeTimeFormat('zh-CN', { numeric: 'auto' })
  if (absolute < 60_000) return formatter.format(Math.round(delta / 1_000), 'second')
  if (absolute < 3_600_000) return formatter.format(Math.round(delta / 60_000), 'minute')
  if (absolute < 86_400_000) return formatter.format(Math.round(delta / 3_600_000), 'hour')
  return formatter.format(Math.round(delta / 86_400_000), 'day')
}

export function cadenceSummary(cadence: ScheduleCadence) {
  switch (cadence.kind) {
    case 'once': return `一次 · ${compactDateTime(cadence.at)}`
    case 'hourly': return `每小时 ${pad(cadence.minute)} 分`
    case 'daily': return `每天 ${pad(cadence.hour)}:${pad(cadence.minute)}`
    case 'weekly': {
      const days = cadence.weekdays.map((day) => WEEKDAYS[day - 1]).filter(Boolean).join('、')
      return `每周${days || '—'} ${pad(cadence.hour)}:${pad(cadence.minute)}`
    }
    case 'monthly': return `每月 ${cadence.day} 日 ${pad(cadence.hour)}:${pad(cadence.minute)}`
  }
}

export function sortSchedules(schedules: ScheduleRecord[]) {
  return [...schedules].sort((left, right) => {
    const leftUnread = (left.unread_run_count ?? 0) > 0
    const rightUnread = (right.unread_run_count ?? 0) > 0
    if (leftUnread !== rightUnread) return leftUnread ? -1 : 1
    if (left.enabled !== right.enabled) return left.enabled ? -1 : 1
    if (left.enabled) {
      const next = dateValue(left.next_run_at, Number.POSITIVE_INFINITY)
        - dateValue(right.next_run_at, Number.POSITIVE_INFINITY)
      if (next !== 0) return next
    } else {
      const updated = dateValue(right.updated_at, 0) - dateValue(left.updated_at, 0)
      if (updated !== 0) return updated
    }
    return left.title.localeCompare(right.title, 'zh-CN') || left.id.localeCompare(right.id)
  })
}

export function filterSchedules(
  schedules: ScheduleRecord[],
  { query = '', status = 'all' }: { query?: string; status?: ScheduleFilter } = {},
) {
  const needle = query.trim().toLocaleLowerCase()
  return sortSchedules(schedules).filter((schedule) => {
    if (status === 'active' && !schedule.enabled) return false
    if (status === 'paused' && schedule.enabled) return false
    if (!needle) return true
    return [schedule.title, schedule.workspace, cadenceSummary(schedule.cadence)]
      .some((value) => value.toLocaleLowerCase().includes(needle))
  })
}

const STATUS_LABELS: Record<ScheduleExecutionStatus, string> = {
  queued: '排队中',
  claimed: '准备中',
  running: '运行中',
  succeeded: '已成功',
  failed: '失败',
  timed_out: '已超时',
  skipped_overlap: '已跳过',
  canceled: '已取消',
  lost: '已丢失',
  interrupted: '已中断',
  dispatch_failed: '调度失败',
  dispatch_stalled: '调度停滞',
}

export function runStatusLabel(status: ScheduleExecutionStatus | RunStatus) {
  return STATUS_LABELS[status] ?? '状态未知'
}

export function isActiveRun(schedule: ScheduleRecord) {
  return ['queued', 'claimed', 'running'].includes(schedule.current_execution?.status ?? '')
}
