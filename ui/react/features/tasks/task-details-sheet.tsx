import { useQuery } from '@tanstack/react-query'
import { Archive, Terminal } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Drawer } from '@/components/ui/drawer'
import { Tab, TabList, TabPanel, Tabs } from '@/components/ui/tabs'
import type { DashboardApi } from '@/lib/api/dashboard-api'
import type { TaskRecord, TaskStatus } from '@/lib/api/types'
import { queryKeys } from '@/lib/query/keys'
import { ContextCell } from './context-cell'
import { STATUS_LABELS } from './task-status-control'

function localTime(value: string | null | undefined) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    hour12: false,
  }).format(date)
}

function eventLabel(value: string) {
  return ({
    created: '创建任务', renamed: '重命名任务', description_changed: '修改描述',
    updated: '更新任务', status_changed: '修改状态', canceled: '取消任务', moved: '移动任务',
    reordered: '调整顺序', archived: '归档任务', deleted: '删除任务', restored: '恢复任务',
    execution_bound: '关联 Execution', execution_unbound: '解除 Execution 关联',
  } as Record<string, string>)[value] ?? '更新任务'
}

export function TaskDetailsSheet({
  api,
  taskId,
  projection,
  open,
  busy = false,
  message = '',
  onOpenChange,
  onStatusChange,
  onArchive,
  onResume,
}: {
  api: DashboardApi
  taskId: string | null
  projection: TaskRecord | null
  open: boolean
  busy?: boolean
  message?: string
  onOpenChange: (open: boolean) => void
  onStatusChange: (task: TaskRecord, status: TaskStatus) => void
  onArchive: (task: TaskRecord) => void
  onResume: (task: TaskRecord) => void
}) {
  const detail = useQuery({
    queryKey: queryKeys.task(taskId ?? ''),
    queryFn: () => api.task(taskId as string),
    enabled: open && Boolean(taskId),
    placeholderData: (previous) => previous,
  })
  const executions = useQuery({
    queryKey: queryKeys.executionList(taskId ? { task_id: taskId } : {}),
    queryFn: () => api.executions({ task_id: taskId as string }),
    enabled: open && Boolean(taskId),
    placeholderData: (previous) => previous,
  })
  const events = useQuery({
    queryKey: queryKeys.taskEvents(taskId ?? ''),
    queryFn: () => api.events(taskId as string),
    enabled: open && Boolean(taskId),
    placeholderData: (previous) => previous,
  })

  const task = detail.data?.task
    ? { ...projection, ...detail.data.task }
    : projection
  const children = detail.data?.children ?? []
  const readError = detail.error ?? executions.error ?? events.error
  const canResume = Boolean(task?.resume_available && task.workspace && task.session_id)
  const archiveStatus = task?.rollup_state === 'in_progress' ? 'active' : task?.rollup_state ?? task?.status
  const canArchive = Boolean(task && !task.archived_at && ['done', 'canceled'].includes(archiveStatus ?? ''))

  return (
    <Drawer isDismissable={false} isOpen={open} modal={false} onOpenChange={onOpenChange} placement="right" swipeToDismiss={false} className="task-details-sheet">
      <DialogContent
        aria-busy={busy || detail.isPending}
        showCloseButton
      >
        <DialogHeader>
          <DialogTitle>{task?.title ?? '任务详情'}</DialogTitle>
          <DialogDescription>
            {task ? `${task.entity_type === 'subtask' ? 'Subtask' : task.entity_type === 'project' ? 'Project' : 'Main Task'} · revision ${task.revision}` : '正在读取任务上下文'}
          </DialogDescription>
        </DialogHeader>
        {message || readError ? (
          <div className="task-details-sheet__message" role="status">
            {message || (readError as Error).message}
          </div>
        ) : null}
        <Tabs className="task-details-sheet__tabs" defaultSelectedKey="summary">
          <TabList variant="line" aria-label="任务详情">
            <Tab id="summary">概览</Tab>
            <Tab id="executions">Executions</Tab>
            <Tab id="activity">动态</Tab>
          </TabList>
          <TabPanel className="task-details-sheet__panel" id="summary">
            {task ? (
              <div className="task-details-summary">
                {task.entity_type !== 'project' ? (
                  <div className="task-details-field">
                    <span>状态</span>
                    <Select
                      aria-label="修改任务状态"
                      isDisabled={busy}
                      selectedKey={task.status}
                      onSelectionChange={(key) => onStatusChange(task, String(key) as TaskStatus)}
                    >
                      <SelectTrigger size="sm"><SelectValue /></SelectTrigger>
                      <SelectContent>
                      {(Object.keys(STATUS_LABELS) as TaskStatus[]).map((status) => (
                        <SelectItem id={status} key={status}>{STATUS_LABELS[status]}</SelectItem>
                      ))}
                      </SelectContent>
                    </Select>
                  </div>
                ) : null}
                <div className="task-details-field task-details-field--wide"><span>描述</span><p>{task.description || '—'}</p></div>
                <div className="task-details-field task-details-field--wide"><span>Next action</span><p>{task.next_action || '—'}</p></div>
                <div className="task-details-field"><span>Workspace</span><ContextCell label="Workspace" value={task.workspace ?? task.workfolder ?? task.worktree} /></div>
                <div className="task-details-field"><span>Branch</span><ContextCell label="Branch" value={task.branch} /></div>
                <div className="task-details-field task-details-field--wide"><span>Session ID</span><ContextCell label="Session ID" value={task.session_id} /></div>
                <dl className="task-details-metrics">
                  <div><dt>最近活跃</dt><dd>{localTime(task.last_activity)}</dd></div>
                  <div><dt>更新时间</dt><dd>{localTime(task.updated_at)}</dd></div>
                  <div><dt>子任务</dt><dd>{children.length ? `${children.filter(({ status }) => status === 'done').length}/${children.length}` : '—'}</dd></div>
                  <div><dt>Executions</dt><dd>{task.execution_count}</dd></div>
                </dl>
              </div>
            ) : null}
          </TabPanel>
          <TabPanel className="task-details-sheet__panel" id="executions">
            <ol className="task-details-list">
              {(executions.data ?? []).map((execution) => (
                <li key={execution.id}>
                  <div><strong>{execution.agent || 'Codex'}</strong><span>{execution.status || 'unknown'}</span></div>
                  <p>{execution.worktree || execution.workfolder || '—'}{execution.branch ? ` · ${execution.branch}` : ''}</p>
                  <small>{localTime(execution.started_at)} — {localTime(execution.ended_at)}</small>
                  {execution.session_id ? <ContextCell label="Session ID" value={execution.session_id} /> : null}
                </li>
              ))}
              {!executions.isPending && executions.data?.length === 0 ? <li className="is-empty">尚无 Execution 记录</li> : null}
            </ol>
          </TabPanel>
          <TabPanel className="task-details-sheet__panel" id="activity">
            <ol className="task-activity-list">
              {(events.data ?? []).map((event) => (
                <li key={event.id}><span aria-hidden="true" /><div><strong>{eventLabel(event.event_type)}</strong><small>{localTime(event.created_at)}</small></div></li>
              ))}
              {!events.isPending && events.data?.length === 0 ? <li className="is-empty">尚无任务动态</li> : null}
            </ol>
          </TabPanel>
        </Tabs>
        <DialogFooter className="task-details-sheet__actions">
          <Button isDisabled={!canResume || busy} variant="secondary" onPress={() => task && onResume(task)}><Terminal />在终端恢复</Button>
          {canArchive ? <Button isDisabled={busy} variant="quiet" onPress={() => task && onArchive(task)}><Archive />归档</Button> : null}
        </DialogFooter>
      </DialogContent>
    </Drawer>
  )
}
