import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useMemo, useState } from 'react'

import { InboxDrawer } from '@/features/inbox/inbox-drawer'
import { DashboardApiError, type DashboardApi } from '@/lib/api/dashboard-api'
import type { DashboardSnapshot, TaskRecord, TaskStatus } from '@/lib/api/types'
import { queryKeys } from '@/lib/query/keys'
import { TaskDetailsSheet } from './task-details-sheet'
import { TaskGantt } from './task-gantt'
import type { TimelineZoom } from './task-types'
import { TasksToolbar, type TaskStatusCounts, type TaskStatusScope } from './tasks-toolbar'

const TIMELINE_LABEL_KEY = 'dashboard-show-timeline-labels'

function readTimelineLabelPreference() {
  try {
    const stored = window.localStorage.getItem(TIMELINE_LABEL_KEY)
    return stored === null ? true : stored === 'true'
  } catch {
    return true
  }
}

function writeTimelineLabelPreference(value: boolean) {
  try {
    window.localStorage.setItem(TIMELINE_LABEL_KEY, String(value))
  } catch {
    // Preferences are optional when storage is unavailable.
  }
}

function effectiveStatus(task: TaskRecord): TaskStatus {
  const status = task.rollup_state ?? task.lifecycle ?? task.status
  return status === 'in_progress' ? 'active' : status
}

function isHistoryTask(task: TaskRecord) {
  return Boolean(task.archived_at) || ['done', 'canceled'].includes(effectiveStatus(task))
}

export function taskStatusCounts(snapshot: DashboardSnapshot): TaskStatusCounts {
  const counts: TaskStatusCounts = {
    all: 0,
    blocked: 0,
    active: 0,
    waiting: 0,
    planned: 0,
    history: 0,
  }
  for (const task of snapshot.tasks) {
    if (task.entity_type === 'project') continue
    if (isHistoryTask(task)) {
      counts.history += 1
      continue
    }
    counts.all += 1
    const status = effectiveStatus(task)
    if (status === 'blocked' || status === 'active' || status === 'waiting' || status === 'planned') {
      counts[status] += 1
    }
  }
  return counts
}

export function filterTaskSnapshot(
  snapshot: DashboardSnapshot,
  { query = '', status = 'all' }: { query?: string; status?: TaskStatusScope },
): DashboardSnapshot {
  const needle = query.trim().toLocaleLowerCase()
  if (!needle && status === 'all') return snapshot
  const byId = new Map(snapshot.tasks.map((task) => [task.id, task]))
  const children = new Map<string, TaskRecord[]>()
  for (const task of snapshot.tasks) {
    if (!task.parent_id) continue
    children.set(task.parent_id, [...(children.get(task.parent_id) ?? []), task])
  }
  const included = new Set<string>()
  const matches = (task: TaskRecord) => {
    const history = isHistoryTask(task)
    const statusMatch = status === 'history'
      ? history
      : status === 'all'
        ? !history
        : !history && effectiveStatus(task) === status
    const haystack = [task.title, task.description, task.workspace, task.workfolder, task.branch, task.session_id]
      .filter(Boolean).join('\n').toLocaleLowerCase()
    return statusMatch && (!needle || haystack.includes(needle))
  }
  function includeDescendants(id: string) {
    for (const child of children.get(id) ?? []) {
      included.add(child.id)
      includeDescendants(child.id)
    }
  }
  for (const task of snapshot.tasks) {
    if (task.entity_type === 'project' || !matches(task)) continue
    included.add(task.id)
    includeDescendants(task.id)
    let parentId = task.parent_id
    while (parentId) {
      included.add(parentId)
      parentId = byId.get(parentId)?.parent_id ?? null
    }
  }
  return { ...snapshot, tasks: snapshot.tasks.filter(({ id }) => included.has(id)) }
}

function mutationMessage(error: unknown) {
  if (error instanceof DashboardApiError && error.code === 'TASK_VERSION_CONFLICT') {
    return '任务已在其他位置更新，已恢复最新数据。请检查后重试。'
  }
  return error instanceof Error ? error.message : '操作失败，已恢复修改前的数据。'
}

export function TasksView({
  api,
  snapshot,
  status = 'all',
}: {
  api: DashboardApi
  snapshot: DashboardSnapshot
  status?: TaskStatusScope
}) {
  const queryClient = useQueryClient()
  const [query, setQuery] = useState('')
  const [zoom, setZoom] = useState<TimelineZoom>('auto')
  const [openIds, setOpenIds] = useState<Set<string> | null>(null)
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [nowRequest, setNowRequest] = useState(0)
  const [labelsVisible, setLabelsVisible] = useState(readTimelineLabelPreference)
  const [message, setMessage] = useState('')
  const [inboxOpen, setInboxOpen] = useState(false)
  const filtered = useMemo(
    () => filterTaskSnapshot(snapshot, { query, status }),
    [query, snapshot, status],
  )
  const selectedTask = snapshot.tasks.find(({ id }) => id === selectedTaskId) ?? null

  const statusMutation = useMutation({
    mutationFn: ({ task, nextStatus }: { task: TaskRecord; nextStatus: TaskStatus }) => (
      api.updateTask(task.id, task.revision, { status: nextStatus })
    ),
    onMutate: async ({ task, nextStatus }) => {
      setMessage('')
      await queryClient.cancelQueries({ queryKey: queryKeys.snapshot })
      const previous = queryClient.getQueryData<DashboardSnapshot>(queryKeys.snapshot)
      queryClient.setQueryData<DashboardSnapshot>(queryKeys.snapshot, (current) => current ? ({
        ...current,
        tasks: current.tasks.map((item) => item.id === task.id ? {
          ...item,
          status: nextStatus,
          lifecycle: nextStatus === 'active' ? 'in_progress' : nextStatus,
          rollup_state: nextStatus === 'active' ? 'in_progress' : nextStatus,
        } : item),
      }) : current)
      return previous
    },
    onError: (error, _variables, previous) => {
      if (previous) queryClient.setQueryData(queryKeys.snapshot, previous)
      setMessage(mutationMessage(error))
    },
    onSettled: async (_data, _error, { task }) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.snapshot }),
        queryClient.invalidateQueries({ queryKey: queryKeys.task(task.id) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.taskEvents(task.id) }),
      ])
    },
  })

  const archiveMutation = useMutation({
    mutationFn: (task: TaskRecord) => api.archiveTask(task.id, task.revision),
    onMutate: async (task) => {
      setMessage('')
      await queryClient.cancelQueries({ queryKey: queryKeys.snapshot })
      const previous = queryClient.getQueryData<DashboardSnapshot>(queryKeys.snapshot)
      queryClient.setQueryData<DashboardSnapshot>(queryKeys.snapshot, (current) => current ? ({
        ...current,
        tasks: current.tasks.map((item) => item.id === task.id
          ? { ...item, archived_at: new Date().toISOString() }
          : item),
      }) : current)
      return previous
    },
    onError: (error, _task, previous) => {
      if (previous) queryClient.setQueryData(queryKeys.snapshot, previous)
      setMessage(mutationMessage(error))
    },
    onSettled: async (_data, _error, task) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.snapshot }),
        queryClient.invalidateQueries({ queryKey: queryKeys.task(task.id) }),
      ])
    },
  })

  const resumeMutation = useMutation({
    mutationFn: (task: TaskRecord) => api.resumeTask(task.id),
    onMutate: () => setMessage(''),
    onError: (error) => setMessage(mutationMessage(error)),
  })

  const pendingTaskIds = new Set<string>()
  if (statusMutation.isPending) pendingTaskIds.add(statusMutation.variables.task.id)
  if (archiveMutation.isPending) pendingTaskIds.add(archiveMutation.variables.id)
  if (resumeMutation.isPending) pendingTaskIds.add(resumeMutation.variables.id)
  const groupIds = snapshot.tasks
    .filter((task) => task.entity_type === 'project' || snapshot.tasks.some(({ parent_id: parentId }) => parentId === task.id))
    .map(({ id }) => id)
  const allExpanded = openIds === null || groupIds.every((id) => openIds.has(id))

  const mutateStatus = (taskId: string, nextStatus: TaskStatus) => {
    const task = snapshot.tasks.find(({ id }) => id === taskId)
    if (task && task.status !== nextStatus) statusMutation.mutate({ task, nextStatus })
  }
  const archive = (taskId: string) => {
    const task = snapshot.tasks.find(({ id }) => id === taskId)
    if (task && ['done', 'canceled'].includes(effectiveStatus(task))) archiveMutation.mutate(task)
  }
  const resume = (taskId: string) => {
    const task = snapshot.tasks.find(({ id }) => id === taskId)
    if (task?.resume_available && task.workspace && task.session_id) resumeMutation.mutate(task)
  }

  return (
    <div className="tasks-view">
        <TasksToolbar
          query={query}
          zoom={zoom}
          inboxCount={snapshot.project_inbox_count + snapshot.unassigned_execution_count}
          allExpanded={allExpanded}
          onToggleExpansion={() => setOpenIds(allExpanded ? new Set() : new Set(groupIds))}
          onQueryChange={setQuery}
          onNow={() => setNowRequest((value) => value + 1)}
          labelsVisible={labelsVisible}
          onToggleLabels={() => setLabelsVisible((current) => {
            const next = !current
            writeTimelineLabelPreference(next)
            return next
          })}
          onOpenInbox={() => setInboxOpen(true)}
          onZoomChange={setZoom}
        />
        <TaskGantt
          snapshot={filtered}
          zoom={zoom}
          openIds={openIds}
          selectedTaskId={selectedTaskId}
          pendingTaskIds={pendingTaskIds}
          nowRequest={nowRequest}
          labelsVisible={labelsVisible}
          onArchive={archive}
          onOpenIdsChange={setOpenIds}
          onStatusChange={mutateStatus}
          onTaskResume={resume}
          onTaskSelect={setSelectedTaskId}
        />
        <TaskDetailsSheet
          api={api}
          taskId={selectedTaskId}
          projection={selectedTask}
          open={Boolean(selectedTaskId)}
          busy={statusMutation.isPending || archiveMutation.isPending || resumeMutation.isPending}
          message={message}
          onArchive={(task) => archive(task.id)}
          onOpenChange={(nextOpen) => { if (!nextOpen) setSelectedTaskId(null) }}
          onResume={(task) => resume(task.id)}
          onStatusChange={(task, nextStatus) => mutateStatus(task.id, nextStatus)}
        />
        <InboxDrawer api={api} snapshot={snapshot} open={inboxOpen} onOpenChange={setInboxOpen} />
    </div>
  )
}
