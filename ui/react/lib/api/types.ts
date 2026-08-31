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

export type ScheduleCadence =
  | { kind: 'once'; at: string; timezone_mode?: 'system' }
  | { kind: 'hourly'; minute: number; timezone_mode?: 'system' }
  | { kind: 'daily'; hour: number; minute: number; timezone_mode?: 'system' }
  | { kind: 'weekly'; hour: number; minute: number; weekdays: number[]; timezone_mode?: 'system' }
  | { kind: 'monthly'; hour: number; minute: number; day: number; timezone_mode?: 'system' }

export type RunStatus =
  | 'queued'
  | 'claimed'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'timed_out'
  | 'skipped_overlap'
  | 'canceled'
  | 'lost'
  | 'interrupted'

export type ScheduleExecutionStatus = RunStatus | 'dispatch_failed' | 'dispatch_stalled'

export interface ScheduleExecutionSummary {
  kind: 'run' | 'dispatch'
  id: string
  status: ScheduleExecutionStatus
  trigger?: 'scheduled' | 'manual' | 'catchup' | string
  requested_at?: string | null
  last_attempted_at?: string | null
  claim_deadline_at?: string | null
  started_at?: string | null
  finished_at?: string | null
  error_code?: string | null
  output_count?: number
  attempt_count?: number
}

export interface ScheduleLastRun {
  id: string
  status: RunStatus
  finished_at: string | null
  reviewed_at: string | null
}

export type ScheduleCapabilityMode = 'inherit' | 'disabled'

export interface ScheduleCapabilities {
  skills: ScheduleCapabilityMode
  integrations: ScheduleCapabilityMode
}

export interface ScheduleRecord {
  id: string
  title: string
  prompt?: string
  workspace: string
  agent: string
  cadence: ScheduleCadence
  timezone_mode: string
  thread_mode: string
  sandbox_mode: 'read-only' | 'workspace-write' | 'danger-full-access'
  model: string | null
  reasoning_effort: string | null
  timeout_seconds: number
  capabilities: ScheduleCapabilities
  enabled: boolean
  etag: string
  source_path: string
  schedule_generation: number
  sync_state: string
  sync_error_code: string | null
  next_run_at: string | null
  last_run_at: string | null
  unread_run_count?: number
  last_run?: ScheduleLastRun | null
  current_execution?: ScheduleExecutionSummary | null
  created_at: string
  updated_at: string
}

export interface ScheduleCapability {
  supported: boolean
  backend?: string
  reason?: string | null
  [key: string]: unknown
}

export interface RuntimeStatus {
  id: string
  display_name: string
  state: 'ready' | 'unavailable' | string
  models_source?: string
  error_code?: string | null
  capabilities?: Record<string, unknown>
}

export interface RuntimeListResponse {
  runtimes: RuntimeStatus[]
}

export interface RuntimeModel {
  id?: string
  slug?: string
  displayName?: string
  display_name?: string
  description?: string
  reasoningLevels?: string[]
  supported_reasoning_levels?: string[]
  defaultReasoningLevel?: string
  default_reasoning_level?: string
}

export interface RuntimeModelCatalogResponse {
  source: string
  models: RuntimeModel[]
  error_code?: string | null
}

export interface InvalidScheduleDefinition {
  path?: string
  title?: string
  code?: string
  message?: string
  [key: string]: unknown
}

export interface ScheduleListResponse {
  capability: ScheduleCapability
  jobs: ScheduleRecord[]
  invalid?: InvalidScheduleDefinition[]
}

export interface ScheduleResponse {
  job: ScheduleRecord
  changed?: boolean
}

export interface RunFileChange {
  path: string
  kind: 'add' | 'update' | 'delete' | string
}

export interface RunRecord {
  id: string
  job_id: string
  definition_etag: string
  runtime_id: string
  interactive: boolean
  turn_revision: number | null
  trigger: 'scheduled' | 'manual' | 'catchup' | string
  status: RunStatus
  thread_id: string | null
  scheduled_for: string | null
  claimed_at: string | null
  started_at: string | null
  heartbeat_at: string | null
  finished_at: string | null
  exit_code: number | null
  error_code: string | null
  final_message: string | null
  file_changes: RunFileChange[]
  has_stdout_log: boolean
  has_stderr_log: boolean
  reviewed_at: string | null
  created_at: string
  updated_at: string
}

export interface RunDispatchRecord extends ScheduleExecutionSummary {
  kind: 'dispatch'
  job_id?: string
}

export interface ScheduleRunsResponse {
  runs: RunRecord[]
  dispatches?: RunDispatchRecord[]
}

export interface RunResponse {
  run: RunRecord
  changed?: boolean
}

export interface RunLogResponse {
  stream: 'stdout' | 'stderr'
  content: string
  truncated?: boolean
}

export interface RunControlResponse {
  accepted: boolean
  run_id: string
  turn_revision: number
}

export interface RunResumeResponse {
  ok?: boolean
  terminal?: string
  run_id?: string
  session_id?: string
}

export interface RunEvent {
  sequence: number
  runId: string
  type: string
  observedAt: string
  payload: Record<string, unknown>
}

export interface RunConversationMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
}

export interface RunConversationResponse {
  run_id: string
  session_id: string
  messages: RunConversationMessage[]
  truncated: boolean
}

export interface ScheduleMutationInput {
  title: string
  prompt: string
  workspace: string
  agent: string
  cadence: ScheduleCadence
  sandbox_mode: ScheduleRecord['sandbox_mode']
  model: string | null
  reasoning_effort: string | null
  timeout_seconds: number
  capabilities: ScheduleCapabilities
}
