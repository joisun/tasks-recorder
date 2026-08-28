export type TaskStatus = 'planned' | 'active' | 'waiting' | 'blocked' | 'done' | 'canceled'
export type TaskLifecycle = 'planned' | 'in_progress' | 'waiting' | 'blocked' | 'done' | 'canceled'
export type TaskEntityType = 'project' | 'main_task' | 'subtask'
export type LiveState = 'running' | 'idle' | 'stale' | 'ended' | 'none'

export interface TimeRange {
  start: string
  end: string
}

export interface ActualSegment extends TimeRange {
  id: string
  kind: 'segment' | 'envelope'
}

export interface TaskProgress {
  remaining: number
  total: number
  completed: number
  ratio: number
}

export interface TaskRecord {
  id: string
  parent_id: string | null
  project_id: string | null
  entity_type: TaskEntityType
  title: string
  description: string | null
  lifecycle: TaskLifecycle
  status: TaskStatus
  rollup_state: TaskLifecycle
  sort_order: number
  revision: number
  archived_at: string | null
  progress: TaskProgress | null
  agent: string
  next_action: string | null
  planned: TimeRange | null
  actual: TimeRange | null
  actual_segments: ActualSegment[]
  actual_segment_count: number
  start: string | null
  end: string | null
  last_activity: string | null
  updated_at: string
  session_id: string | null
  session_source: string | null
  resume_available: boolean
  workspace: string | null
  workfolder: string | null
  worktree: string | null
  branch: string | null
  execution_count: number
  active_execution_count: number
  running_execution_count: number
  idle_execution_count: number
  stale_execution_count: number
  active_agent_count: number
  live_state: LiveState
  blocked_count: number
}

export interface ProjectSummary {
  id: string
  name: string
  description?: string | null
  revision?: number
  archived_at?: string | null
  updated_at?: string
}

export interface ProjectInboxRecord {
  id: string
  source: string
  external_session_id: string
  root_external_session_id: string
  first_seen_at: string
  last_seen_at: string
  agent: string
  workfolder: string | null
  worktree: string | null
  branch: string | null
}

export interface DashboardWarning {
  code: string
  task_id?: string
}

export interface DashboardSnapshot {
  server_instance_id: string
  revision: number
  schema_version: number
  generated_at: string
  home_directory: string
  tasks: TaskRecord[]
  projects: ProjectSummary[]
  warnings: DashboardWarning[]
  project_inbox: ProjectInboxRecord[]
  project_inbox_count: number
  attribution_inbox_count: number
  unassigned_execution_count: number
}

export interface DashboardMeta {
  service: 'tasks-recorder'
  service_version: string
  api_version: string
  capabilities: {
    runtime_registry: boolean
    unified_runs: boolean
    internal_scheduler: boolean
  }
}

export interface TaskDetailResponse {
  task: TaskRecord
  children?: TaskRecord[]
  parent?: TaskRecord | null
}

export interface ExecutionRecord {
  id: string
  task_id?: string | null
  classification?: 'unknown' | 'work' | 'non_work'
  root_session_id?: string
  session_id?: string
  status?: string
  agent?: string | null
  agent_type?: string | null
  agent_path?: string | null
  workfolder?: string | null
  worktree?: string | null
  branch?: string | null
  started_at?: string | null
  ended_at?: string | null
  last_seen_at?: string | null
  [key: string]: unknown
}

export interface ExecutionFilters {
  task_id?: string
  root_session_id?: string
  session_id?: string
  status?: string
  unassigned?: boolean
}

export interface TaskEventRecord {
  id: string
  task_id?: string
  event_type: string
  before_json?: string | null
  after_json?: string | null
  actor?: string | null
  created_at: string
}

export interface TaskPatch {
  title?: string
  description?: string | null
  status?: TaskStatus
  next_action?: string | null
  due_date?: string | null
  parent_id?: string | null
  sort_order?: number
}

export interface TaskMutationResponse {
  task: TaskRecord
  changed?: boolean
  revision?: number
}

export interface TaskResumeResponse {
  ok?: boolean
  terminal?: string
  session_id?: string
}

export interface ExecutionAssignmentPatch {
  actor: 'user'
  changes: Array<{
    id: string
    task_id: string | null
    expected_task_id: string | null
    classification: 'work' | 'non_work'
    expected_classification: 'unknown' | 'work' | 'non_work'
  }>
}

export interface ExecutionAssignmentResponse {
  executions: ExecutionRecord[]
  changed?: boolean
}

export interface ProjectAssignmentResponse {
  source_session: ProjectInboxRecord
  changed?: boolean
}
