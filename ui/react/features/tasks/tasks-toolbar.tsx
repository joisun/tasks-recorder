import { CalendarClock, ChevronsDownUp, ChevronsUpDown, Search } from 'lucide-react'

import { Button } from '@/components/ui/button'
import type { TaskStatus } from '@/lib/api/types'
import type { TimelineZoom } from './task-types'

export type TaskStatusScope = 'all' | TaskStatus

export function TasksToolbar({
  query,
  status,
  zoom,
  onQueryChange,
  onStatusChange,
  onZoomChange,
  onExpandAll,
  onCollapseAll,
  onToday,
}: {
  query: string
  status: TaskStatusScope
  zoom: TimelineZoom
  onQueryChange: (value: string) => void
  onStatusChange: (value: TaskStatusScope) => void
  onZoomChange: (value: TimelineZoom) => void
  onExpandAll: () => void
  onCollapseAll: () => void
  onToday: () => void
}) {
  return (
    <div className="tasks-toolbar" aria-label="任务视图工具栏">
      <label className="tasks-toolbar__search">
        <Search aria-hidden="true" />
        <input
          aria-label="搜索任务"
          type="search"
          value={query}
          placeholder="搜索任务、Workspace、Branch 或 Session ID"
          onChange={(event) => onQueryChange(event.target.value)}
        />
      </label>
      <select
        aria-label="任务状态"
        className="tasks-toolbar__select"
        value={status}
        onChange={(event) => onStatusChange(event.target.value as TaskStatusScope)}
      >
        <option value="all">全部状态</option>
        <option value="active">进行中</option>
        <option value="planned">待安排</option>
        <option value="waiting">等待中</option>
        <option value="blocked">已阻塞</option>
        <option value="done">已完成</option>
        <option value="canceled">已取消</option>
      </select>
      <div className="tasks-toolbar__group">
        <Button aria-label="全部展开" size="icon-xs" variant="ghost" onClick={onExpandAll}><ChevronsUpDown /></Button>
        <Button aria-label="全部折叠" size="icon-xs" variant="ghost" onClick={onCollapseAll}><ChevronsDownUp /></Button>
        <Button size="xs" variant="ghost" onClick={onToday}><CalendarClock />今天</Button>
      </div>
      <select
        aria-label="Timeline scale"
        className="tasks-toolbar__select tasks-toolbar__scale"
        value={zoom}
        onChange={(event) => onZoomChange(event.target.value as TimelineZoom)}
      >
        <option value="auto">自适应</option>
        <option value="hour">时</option>
        <option value="day">日</option>
        <option value="week">周</option>
        <option value="month">月</option>
      </select>
    </div>
  )
}
