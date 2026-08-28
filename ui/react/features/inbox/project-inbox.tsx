import { FolderGit2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { ProjectInboxRecord, ProjectSummary } from '@/lib/api/types'
import { ContextCell } from '@/features/tasks/context-cell'

function localTime(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '时间未知'
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date)
}

export function ProjectInbox({
  sessions,
  projects,
  choices,
  busyId,
  onChoiceChange,
  onAssign,
}: {
  sessions: ProjectInboxRecord[]
  projects: ProjectSummary[]
  choices: Record<string, string>
  busyId: string | null
  onChoiceChange: (sessionId: string, projectId: string) => void
  onAssign: (session: ProjectInboxRecord, projectId: string) => void
}) {
  if (sessions.length === 0) {
    return <div className="inbox-empty"><FolderGit2 /><strong>Project Inbox 已清空</strong><span>所有 Source Session 都已有明确项目归属。</span></div>
  }
  return (
    <ol className="project-inbox-list">
      {sessions.map((session) => {
        const context = session.worktree ?? session.workfolder
        const choice = choices[session.id] ?? ''
        const busy = busyId === session.id
        return (
          <li key={session.id}>
            <div className="inbox-row-heading">
              <span className="inbox-source">{session.source || 'unknown'}</span>
              <time>{localTime(session.last_seen_at)}</time>
            </div>
            <strong>{session.agent || 'Unknown agent'}</strong>
            <ContextCell label="Session ID" value={session.external_session_id} />
            <p>{context || '未发现本地路径'}{session.branch ? ` · ${session.branch}` : ''}</p>
            <small>Root · {session.root_external_session_id || session.external_session_id}</small>
            <div className="inbox-row-actions">
              <Select
                aria-label={`为 ${session.external_session_id} 选择 Project`}
                isDisabled={busy || projects.length === 0}
                placeholder="选择 Project…"
                selectedKey={choice || null}
                onSelectionChange={(key) => onChoiceChange(session.id, String(key))}
              >
                <SelectTrigger size="sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {projects.map((project) => <SelectItem id={project.id} key={project.id}>{project.name}</SelectItem>)}
                </SelectContent>
              </Select>
              <Button
                isDisabled={!choice || busy}
                size="sm"
                onPress={() => onAssign(session, choice)}
              >{busy ? '归属中…' : '确认归属'}</Button>
            </div>
          </li>
        )
      })}
    </ol>
  )
}
