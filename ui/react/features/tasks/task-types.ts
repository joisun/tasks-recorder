import type { ITask } from '@svar-ui/react-gantt'

import type { DashboardSnapshot, TaskRecord, TaskStatus, TimeRange } from '@/lib/api/types'

export type TimelineZoom = 'auto' | 'hour' | 'day' | 'week' | 'month'

export interface TimelineDomain {
  minimum: Date
  maximum: Date
}

export interface TimelineScale {
  id: Exclude<TimelineZoom, 'auto'>
  start: Date
  end: Date
  lengthUnit: 'hour' | 'day'
  cellWidth: number
  scales: Array<{
    unit: 'hour' | 'day' | 'week' | 'month' | 'quarter' | 'year'
    step: number
    format: (date: Date) => string
  }>
}

export interface TaskProjectionOptions {
  viewportWidth: number
  openIds?: ReadonlySet<string> | null
  zoom?: TimelineZoom
  includeArchived?: boolean
  now?: Date
}

export interface TaskGanttRow extends ITask {
  id: string
  parent: string | number
  text: string
  start: Date
  end: Date
  type: 'summary' | 'task'
  open: boolean
  status: TaskStatus
  source: TaskRecord
  entity_type: TaskRecord['entity_type']
  status_indicator: 'bar' | 'ring' | 'dot'
  planned_pattern: 'dash-dot' | null
  progress_count: string | null
  workspace: string | null
  branch: string | null
  session_id: string | null
  last_activity: string | null
}

export interface TaskGanttModel {
  rows: TaskGanttRow[]
  rowIds: string[]
  links: []
  domain: TimelineDomain
  scale: TimelineScale
  empty: boolean
}

export interface ProjectedTaskSnapshot {
  snapshot: DashboardSnapshot
  model: TaskGanttModel
}

export interface TaskScope {
  primary: TimeRange
  actual: TimeRange | null
  planned: TimeRange | null
}
