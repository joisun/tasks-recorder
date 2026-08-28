import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'

import { DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Drawer } from '@/components/ui/drawer'
import { Tab, TabList, TabPanel, Tabs } from '@/components/ui/tabs'
import { DashboardApiError, type DashboardApi } from '@/lib/api/dashboard-api'
import type { DashboardSnapshot, ExecutionAssignmentPatch, ExecutionRecord } from '@/lib/api/types'
import { queryKeys } from '@/lib/query/keys'
import { ExecutionInbox } from './execution-inbox'
import { ProjectInbox } from './project-inbox'

function assignmentPayload(
  executions: ExecutionRecord[],
  selectedIds: ReadonlySet<string>,
  taskId: string | null,
): ExecutionAssignmentPatch {
  return {
    actor: 'user',
    changes: executions
      .filter(({ id }) => selectedIds.has(id))
      .map((execution) => ({
        id: execution.id,
        expected_task_id: execution.task_id ?? null,
        expected_classification: execution.classification ?? 'unknown',
        task_id: taskId,
        classification: taskId ? 'work' : 'non_work',
      })),
  }
}

function inboxError(error: unknown) {
  if (error instanceof DashboardApiError) {
    if (error.code === 'SOURCE_SESSION_PROJECT_CONFLICT') return '该 Session 已在其他位置更新，列表已刷新。'
    if (['EXECUTION_BATCH_CONFLICT', 'EXECUTION_CLASSIFICATION_CONFLICT'].includes(error.code)) {
      return '部分 Execution 已在其他位置更新，列表已刷新，请重新选择。'
    }
  }
  return error instanceof Error ? error.message : '操作失败，请重试。'
}

export function InboxDrawer({
  api,
  snapshot,
  open,
  onOpenChange,
}: {
  api: DashboardApi
  snapshot: DashboardSnapshot
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const queryClient = useQueryClient()
  const [projectChoices, setProjectChoices] = useState<Record<string, string>>({})
  const [selectedExecutionIds, setSelectedExecutionIds] = useState<Set<string>>(new Set())
  const [targetTaskId, setTargetTaskId] = useState('')
  const [executionQuery, setExecutionQuery] = useState('')
  const [message, setMessage] = useState('')
  const executions = useQuery({
    queryKey: queryKeys.inboxExecutionList(snapshot.unassigned_execution_count),
    queryFn: () => api.executions({ unassigned: true }),
    enabled: open,
    refetchOnMount: 'always',
  })

  useEffect(() => {
    const available = new Set((executions.data ?? []).map(({ id }) => id))
    setSelectedExecutionIds((current) => new Set([...current].filter((id) => available.has(id))))
  }, [executions.data])

  const projectMutation = useMutation({
    mutationFn: ({ sessionId, projectId }: { sessionId: string; projectId: string }) => (
      api.assignSourceSessionProject(sessionId, projectId, null)
    ),
    onMutate: () => setMessage(''),
    onError: (error) => setMessage(inboxError(error)),
    onSuccess: () => setMessage('Project 归属已更新。'),
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.snapshot })
    },
  })

  const executionMutation = useMutation({
    mutationFn: (input: ExecutionAssignmentPatch) => api.updateExecutionAssignments(input),
    onMutate: () => setMessage(''),
    onError: (error) => setMessage(inboxError(error)),
    onSuccess: () => {
      setMessage('Execution 归属已更新。')
      setSelectedExecutionIds(new Set())
    },
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.snapshot }),
        queryClient.invalidateQueries({ queryKey: queryKeys.inboxExecutions }),
      ])
    },
  })

  const activeTasks = snapshot.tasks.filter((task) => {
    const lifecycle = task.rollup_state === 'in_progress'
      ? 'active'
      : task.rollup_state ?? task.status
    return task.entity_type !== 'project'
      && !task.archived_at
      && !['done', 'canceled'].includes(lifecycle)
  })
  const executionData = executions.data ?? []
  const mutateExecutions = (taskId: string | null) => {
    const payload = assignmentPayload(executionData, selectedExecutionIds, taskId)
    if (payload.changes.length > 0) executionMutation.mutate(payload)
  }

  return (
    <Drawer isOpen={open} onOpenChange={onOpenChange} placement="right" swipeToDismiss={false} className="inbox-drawer">
      <DialogContent showCloseButton>
        <DialogHeader>
          <DialogTitle>待处理工作</DialogTitle>
          <DialogDescription>为未归属的 Session 和 Execution 补全明确上下文。</DialogDescription>
        </DialogHeader>
        {message ? <div className="inbox-drawer__message" role="status">{message}</div> : null}
        {executions.isError ? <div className="inbox-drawer__message" role="status">{executions.error.message}</div> : null}
        <Tabs className="inbox-drawer__tabs" defaultSelectedKey={snapshot.project_inbox_count > 0 ? 'projects' : 'executions'}>
          <TabList aria-label="待处理类型" variant="line">
            <Tab id="projects">Projects <span>{snapshot.project_inbox_count}</span></Tab>
            <Tab id="executions">Executions <span>{snapshot.unassigned_execution_count}</span></Tab>
          </TabList>
          <TabPanel className="inbox-drawer__panel" id="projects">
            <ProjectInbox
              sessions={snapshot.project_inbox}
              projects={snapshot.projects.filter(({ archived_at: archivedAt }) => !archivedAt)}
              choices={projectChoices}
              busyId={projectMutation.isPending ? projectMutation.variables.sessionId : null}
              onChoiceChange={(sessionId, projectId) => setProjectChoices((current) => ({ ...current, [sessionId]: projectId }))}
              onAssign={(session, projectId) => projectMutation.mutate({ sessionId: session.id, projectId })}
            />
          </TabPanel>
          <TabPanel className="inbox-drawer__panel" id="executions">
            <ExecutionInbox
              executions={executionData}
              tasks={activeTasks}
              query={executionQuery}
              selectedIds={selectedExecutionIds}
              targetTaskId={targetTaskId}
              loading={executions.isPending}
              busy={executionMutation.isPending || executions.isPending}
              onAssign={() => mutateExecutions(targetTaskId)}
              onMarkNonWork={() => mutateExecutions(null)}
              onQueryChange={setExecutionQuery}
              onSelectionChange={setSelectedExecutionIds}
              onTargetTaskChange={setTargetTaskId}
            />
          </TabPanel>
        </Tabs>
      </DialogContent>
    </Drawer>
  )
}
