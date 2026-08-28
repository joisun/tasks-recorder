import type { ExecutionFilters } from '../api/types'

export const queryKeys = {
  all: ['dashboard'] as const,
  meta: ['dashboard', 'meta'] as const,
  snapshot: ['dashboard', 'snapshot'] as const,
  tasks: ['dashboard', 'tasks'] as const,
  task: (id: string) => ['dashboard', 'tasks', id] as const,
  executions: ['dashboard', 'executions'] as const,
  executionList: (filters: ExecutionFilters = {}) => (
    ['dashboard', 'executions', filters] as const
  ),
}
