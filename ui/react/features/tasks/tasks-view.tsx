import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useMemo, useState } from 'react'

import { TooltipProvider } from '@/components/ui/tooltip'
import { DashboardApiError, type DashboardApi } from '@/lib/api/dashboard-api'
import type { DashboardSnapshot, TaskRecord, TaskStatus } from '@/lib/api/types'
import { queryKeys } from '@/lib/query/keys'
import { TaskDetailsSheet } from './task-details-sheet'
import { TaskGantt } from './task-gantt'
import type { TimelineZoom } from './task-types'
import { TasksToolbar, type TaskStatusScope } from './tasks-toolbar'

function effectiveStatus(task: TaskRecord): TaskStatus {
  const status = task.rollup_state ?? task.lifecycle ?? task.status
  return status === 'in_progress' ? 'active' : status
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
    const statusMatch = status === 'all' || effectiveStatus(task) === status
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

export function TasksView({ api, snapshot }: { api: DashboardApi; snapshot: DashboardSnapshot }) {
  const queryClient = useQueryClient()
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<TaskStatusScope>('all')
  const [zoom, setZoom] = useState<TimelineZoom>('auto')
  const [openIds, setOpenIds] = useState<Set<string> | null>(null)
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [todayRequest, setTodayRequest] = useState(0)
  const [message, setMessage] = useState('')
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
    <TooltipProvider>
      <div className="tasks-view">
        <TasksToolbar
          query={query}
          status={status}
          zoom={zoom}
          onCollapseAll={() => setOpenIds(new Set())}
          onExpandAll={() => setOpenIds(new Set(groupIds))}
          onQueryChange={setQuery}
          onStatusChange={setStatus}
          onToday={() => setTodayRequest((value) => value + 1)}
          onZoomChange={setZoom}
        />
        <TaskGantt
          snapshot={filtered}
          zoom={zoom}
          openIds={openIds}
          selectedTaskId={selectedTaskId}
          pendingTaskIds={pendingTaskIds}
          todayRequest={todayRequest}
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
      </div>
    </TooltipProvider>
  )
}
