import type { ExecutionFilters } from '../api/types'

export const queryKeys = {
  all: ['dashboard'] as const,
  meta: ['dashboard', 'meta'] as const,
  snapshot: ['dashboard', 'snapshot'] as const,
  tasks: ['dashboard', 'tasks'] as const,
  task: (id: string) => ['dashboard', 'tasks', id] as const,
  taskEvents: (id: string) => ['dashboard', 'tasks', id, 'events'] as const,
  executions: ['dashboard', 'executions'] as const,
  executionList: (filters: ExecutionFilters = {}) => (
    ['dashboard', 'executions', filters] as const
  ),
  inboxExecutions: ['dashboard', 'inbox', 'executions'] as const,
  inboxExecutionList: (count: number) => (
    ['dashboard', 'inbox', 'executions', count] as const
  ),
  schedules: ['dashboard', 'schedules'] as const,
  schedule: (id: string) => ['dashboard', 'schedules', id] as const,
  runs: (scheduleId: string) => ['dashboard', 'schedules', scheduleId, 'runs'] as const,
  run: (runId: string) => ['dashboard', 'runs', runId] as const,
  runLog: (runId: string, stream: 'stdout' | 'stderr') => (
    ['dashboard', 'runs', runId, 'logs', stream] as const
  ),
}
