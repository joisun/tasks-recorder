import { CalendarClock, ChevronsDownUp, ChevronsUpDown, Inbox, Tags } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { SearchField } from '@/components/ui/search-field'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { TimelineZoom } from './task-types'

export type TaskStatusScope = 'all' | 'blocked' | 'active' | 'waiting' | 'planned' | 'history'

export interface TaskStatusCounts {
  all: number
  blocked: number
  active: number
  waiting: number
  planned: number
  history: number
}

const STATUS_ITEMS: Array<{ id: TaskStatusScope; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'blocked', label: '已阻塞' },
  { id: 'active', label: '进行中' },
  { id: 'waiting', label: '等待中' },
  { id: 'planned', label: '待安排' },
  { id: 'history', label: '历史' },
]

export function TaskStatusNavigation({
  counts,
  status,
  onStatusChange,
}: {
  counts: TaskStatusCounts
  status: TaskStatusScope
  onStatusChange: (status: TaskStatusScope) => void
}) {
  return (
    <div className="app-task-status-nav" aria-label="任务状态视图">
      {STATUS_ITEMS.map((item) => (
        <Button
          key={item.id}
          className="app-task-status-nav__item"
          aria-pressed={status === item.id}
          data-active={status === item.id || undefined}
          size="xs"
          variant="quiet"
          onPress={() => onStatusChange(item.id)}
        >
          {item.label}<span>{counts[item.id]}</span>
        </Button>
      ))}
    </div>
  )
}

export function TasksToolbar({
  query,
  zoom,
  onQueryChange,
  onZoomChange,
  allExpanded,
  onToggleExpansion,
  onNow,
  labelsVisible,
  onToggleLabels,
  inboxCount = 0,
  onOpenInbox,
}: {
  query: string
  zoom: TimelineZoom
  onQueryChange: (value: string) => void
  onZoomChange: (value: TimelineZoom) => void
  allExpanded: boolean
  onToggleExpansion: () => void
  onNow: () => void
  labelsVisible: boolean
  onToggleLabels: () => void
  inboxCount?: number
  onOpenInbox?: () => void
}) {
  return (
    <div className="tasks-toolbar" aria-label="任务视图工具栏">
      <SearchField
        aria-label="搜索任务"
        className="tasks-toolbar__search"
        value={query}
        size="sm"
        placeholder="搜索任务、Workspace、Branch 或 Session ID"
        onChange={onQueryChange}
      />
      <Button className="tasks-toolbar__inbox" size="sm" variant="secondary" onPress={onOpenInbox}>
        <Inbox />待处理{inboxCount > 0 ? <span>{inboxCount}</span> : null}
      </Button>
      <div className="tasks-toolbar__group">
        <Button
          aria-label={allExpanded ? '全部折叠' : '全部展开'}
          isIconOnly
          size="xs"
          variant="quiet"
          onPress={onToggleExpansion}
        >
          {allExpanded ? <ChevronsDownUp /> : <ChevronsUpDown />}
        </Button>
        <Button
          aria-label={labelsVisible ? '隐藏 Timeline 标签' : '显示 Timeline 标签'}
          aria-pressed={labelsVisible}
          size="xs"
          variant={labelsVisible ? 'secondary' : 'quiet'}
          onPress={onToggleLabels}
        >
          <Tags />标签
        </Button>
        <Button
          aria-label="定位到当前时间"
          className="tasks-toolbar__now"
          size="xs"
          variant="quiet"
          onPress={onNow}
        >
          <CalendarClock />NOW
        </Button>
      </div>
      <Select
        aria-label="Timeline scale"
        className="tasks-toolbar__select tasks-toolbar__scale"
        selectedKey={zoom}
        onSelectionChange={(key) => onZoomChange(String(key) as TimelineZoom)}
      >
        <SelectTrigger size="sm"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem id="auto">自适应</SelectItem>
          <SelectItem id="hour">时</SelectItem>
          <SelectItem id="day">日</SelectItem>
          <SelectItem id="week">周</SelectItem>
          <SelectItem id="month">月</SelectItem>
        </SelectContent>
      </Select>
    </div>
  )
}
