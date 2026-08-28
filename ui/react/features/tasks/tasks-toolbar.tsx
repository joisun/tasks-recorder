import { CalendarClock, ChevronsDownUp, ChevronsUpDown, Inbox, Tags } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { SearchField } from '@/components/ui/search-field'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
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
  onNow,
  labelsVisible,
  onToggleLabels,
  inboxCount = 0,
  onOpenInbox,
}: {
  query: string
  status: TaskStatusScope
  zoom: TimelineZoom
  onQueryChange: (value: string) => void
  onStatusChange: (value: TaskStatusScope) => void
  onZoomChange: (value: TimelineZoom) => void
  onExpandAll: () => void
  onCollapseAll: () => void
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
      <Select
        aria-label="任务状态"
        className="tasks-toolbar__select"
        selectedKey={status}
        onSelectionChange={(key) => onStatusChange(String(key) as TaskStatusScope)}
      >
        <SelectTrigger size="sm"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem id="all">全部状态</SelectItem>
          <SelectItem id="active">进行中</SelectItem>
          <SelectItem id="planned">待安排</SelectItem>
          <SelectItem id="waiting">等待中</SelectItem>
          <SelectItem id="blocked">已阻塞</SelectItem>
          <SelectItem id="done">已完成</SelectItem>
          <SelectItem id="canceled">已取消</SelectItem>
        </SelectContent>
      </Select>
      <Button className="tasks-toolbar__inbox" size="sm" variant="secondary" onPress={onOpenInbox}>
        <Inbox />待处理{inboxCount > 0 ? <span>{inboxCount}</span> : null}
      </Button>
      <div className="tasks-toolbar__group">
        <Button aria-label="全部展开" isIconOnly size="xs" variant="quiet" onPress={onExpandAll}><ChevronsUpDown /></Button>
        <Button aria-label="全部折叠" isIconOnly size="xs" variant="quiet" onPress={onCollapseAll}><ChevronsDownUp /></Button>
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
