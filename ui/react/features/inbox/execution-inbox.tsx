import { ListChecks, LoaderCircle } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { SearchField } from '@/components/ui/search-field'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { ExecutionRecord, TaskRecord } from '@/lib/api/types'

function localTime(value: string | null | undefined) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date)
}

export function filterExecutions(executions: ExecutionRecord[], query: string) {
  const needle = query.trim().toLocaleLowerCase()
  if (!needle) return executions
  return executions.filter((execution) => [
    execution.id, execution.root_session_id, execution.session_id, execution.agent,
    execution.agent_type, execution.agent_path, execution.worktree, execution.workfolder,
    execution.branch,
  ].some((value) => String(value ?? '').toLocaleLowerCase().includes(needle)))
}

export function ExecutionInbox({
  executions,
  tasks,
  query,
  selectedIds,
  targetTaskId,
  loading,
  busy,
  onQueryChange,
  onSelectionChange,
  onTargetTaskChange,
  onAssign,
  onMarkNonWork,
}: {
  executions: ExecutionRecord[]
  tasks: TaskRecord[]
  query: string
  selectedIds: ReadonlySet<string>
  targetTaskId: string
  loading: boolean
  busy: boolean
  onQueryChange: (value: string) => void
  onSelectionChange: (ids: Set<string>) => void
  onTargetTaskChange: (value: string) => void
  onAssign: () => void
  onMarkNonWork: () => void
}) {
  const filtered = filterExecutions(executions, query)
  const allSelected = filtered.length > 0 && filtered.every(({ id }) => selectedIds.has(id))
  return (
    <div className="execution-inbox">
      <div className="execution-inbox__controls">
        <SearchField
          aria-label="搜索 Execution"
          placeholder="搜索 Agent、Session 或 Workspace"
          size="sm"
          value={query}
          onChange={onQueryChange}
        />
        <label><input
          type="checkbox"
          checked={allSelected}
          disabled={filtered.length === 0}
          onChange={(event) => {
            const next = new Set(selectedIds)
            for (const execution of filtered) {
              if (event.target.checked) next.add(execution.id)
              else next.delete(execution.id)
            }
            onSelectionChange(next)
          }}
        />选择当前结果</label>
        <span>已选 {selectedIds.size}</span>
      </div>
      {loading ? (
        <div className="inbox-empty"><LoaderCircle className="inbox-empty__spinner" /><strong>正在读取待归属 Execution</strong></div>
      ) : filtered.length === 0 ? (
        <div className="inbox-empty">
          <ListChecks />
          <strong>{query.trim() ? '没有符合条件的 Execution' : '没有待归属 Execution'}</strong>
          <span>{query.trim() ? '调整搜索条件后重试。' : '新的未绑定工作会自动出现在这里。'}</span>
        </div>
      ) : (
        <ol className="execution-inbox-list">
          {filtered.map((execution) => (
            <li key={execution.id}>
              <label className="execution-inbox-select">
                <input
                  aria-label={`选择 ${execution.id}`}
                  type="checkbox"
                  checked={selectedIds.has(execution.id)}
                  onChange={(event) => {
                    const next = new Set(selectedIds)
                    if (event.target.checked) next.add(execution.id)
                    else next.delete(execution.id)
                    onSelectionChange(next)
                  }}
                />
              </label>
              <div>
                <div className="inbox-row-heading"><strong>{execution.agent || execution.agent_type || 'Unknown agent'}</strong><span>{execution.status || 'unknown'}</span></div>
                <code>{execution.root_session_id || execution.session_id || execution.id}</code>
                <p>{execution.worktree || execution.workfolder || '—'}{execution.branch ? ` · ${execution.branch}` : ''}</p>
                <small>{localTime(execution.started_at)} · {execution.session_id || '—'}</small>
              </div>
            </li>
          ))}
        </ol>
      )}
      <div className="execution-inbox__actions">
        <Select aria-label="分配到任务" placeholder="选择目标 Task…" selectedKey={targetTaskId || null} onSelectionChange={(key) => onTargetTaskChange(String(key))}>
          <SelectTrigger size="sm"><SelectValue /></SelectTrigger>
          <SelectContent>
            {tasks.map((task) => <SelectItem id={task.id} key={task.id}>{task.title}</SelectItem>)}
          </SelectContent>
        </Select>
        <Button isDisabled={busy || selectedIds.size === 0 || !targetTaskId} size="sm" onPress={onAssign}>分配</Button>
        <Button isDisabled={busy || selectedIds.size === 0} size="sm" variant="secondary" onPress={onMarkNonWork}>标记 non-work</Button>
      </div>
    </div>
  )
}
