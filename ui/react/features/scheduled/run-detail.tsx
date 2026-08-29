import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Clipboard, FileText, Terminal } from 'lucide-react'
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import type { DashboardApi } from '@/lib/api/dashboard-api'
import type { RunRecord } from '@/lib/api/types'
import { queryKeys } from '@/lib/query/keys'
import {
  fullDateTime,
  runDuration,
  runStatusLabel,
  triggerLabel,
} from './schedule-format'
import { LiveSession } from './live-session'

const LOG_TAIL_BYTES = 32 * 1024

function shortSessionId(value: string) {
  if (value.length <= 20) return value
  return `${value.slice(0, 8)}…${value.slice(-8)}`
}

export function RunDetail({ api, run }: { api: DashboardApi; run: RunRecord }) {
  const queryClient = useQueryClient()
  const [logStream, setLogStream] = useState<'stdout' | 'stderr' | null>(null)
  const [copied, setCopied] = useState(false)
  const [actionError, setActionError] = useState('')
  const log = useQuery({
    queryKey: queryKeys.runLog(run.id, logStream ?? 'stdout'),
    queryFn: () => api.scheduledRunLog(run.id, { stream: logStream ?? 'stdout', tail: LOG_TAIL_BYTES }),
    enabled: logStream !== null,
  })

  const reviewed = useMutation({
    mutationFn: () => api.markScheduledRunReviewed(run.id),
    onMutate: () => setActionError(''),
    onError: (error) => setActionError(error instanceof Error ? error.message : '标记失败'),
    onSuccess: async (response) => {
      queryClient.setQueryData(queryKeys.run(run.id), response)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.runs(run.job_id) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.schedules }),
      ])
    },
  })
  const resume = useMutation({
    mutationFn: () => api.resumeScheduledRun(run.id),
    onMutate: () => setActionError(''),
    onError: (error) => setActionError(error instanceof Error ? error.message : 'Terminal 打开失败'),
  })

  async function copySession() {
    if (!run.thread_id) return
    try {
      await navigator.clipboard.writeText(run.thread_id)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1_500)
    } catch {
      setActionError('无法复制 Session ID')
    }
  }

  return (
    <article className="run-detail">
      <div className="run-detail__summary">
        <div>
          <span className="run-detail__status" data-status={run.status}>
            <i aria-hidden="true" />{runStatusLabel(run.status)}
          </span>
          <strong>{triggerLabel(run.trigger)}</strong>
        </div>
        <dl>
          <div><dt>开始</dt><dd>{fullDateTime(run.started_at ?? run.created_at)}</dd></div>
          <div><dt>耗时</dt><dd>{runDuration(run.started_at, run.finished_at)}</dd></div>
          <div><dt>Exit code</dt><dd>{run.exit_code ?? '—'}</dd></div>
          <div><dt>Runtime</dt><dd>{run.runtime_id}</dd></div>
        </dl>
      </div>

      <LiveSession
        api={api}
        run={run}
        onTerminal={() => {
          void Promise.all([
            queryClient.refetchQueries({ queryKey: queryKeys.run(run.id), exact: true }),
            queryClient.invalidateQueries({ queryKey: queryKeys.runs(run.job_id) }),
            queryClient.invalidateQueries({ queryKey: queryKeys.schedules }),
          ])
        }}
      />

      <section className="run-detail__section">
        <div className="run-detail__section-heading">
          <h3>结果</h3>
          {!run.reviewed_at ? (
            <Button size="xs" variant="quiet" isPending={reviewed.isPending} onPress={() => reviewed.mutate()}>
              <Check aria-hidden="true" />标记已读
            </Button>
          ) : <span>已读</span>}
        </div>
        {run.final_message ? <p className="run-detail__message">{run.final_message}</p> : (
          <p className="run-detail__empty">没有 final message</p>
        )}
        {run.error_code ? <code className="run-detail__error">{run.error_code}</code> : null}
      </section>

      <section className="run-detail__section">
        <div className="run-detail__section-heading"><h3>产出文件</h3><span>{run.file_changes.length}</span></div>
        {run.file_changes.length ? (
          <ul className="run-detail__files">
            {run.file_changes.map((file) => (
              <li key={`${file.kind}-${file.path}`}>
                <FileText aria-hidden="true" />
                <code>{file.path}</code>
                <span>{file.kind}</span>
              </li>
            ))}
          </ul>
        ) : <p className="run-detail__empty">没有记录文件变更</p>}
      </section>

      <section className="run-detail__section">
        <div className="run-detail__section-heading"><h3>Session</h3></div>
        {run.thread_id ? (
          <div className="run-detail__session">
            <code>{shortSessionId(run.thread_id)}</code>
            <Button aria-label="复制 Session ID" isIconOnly size="xs" variant="quiet" onPress={() => void copySession()}>
              {copied ? <Check aria-hidden="true" /> : <Clipboard aria-hidden="true" />}
            </Button>
            <Button size="xs" variant="secondary" isPending={resume.isPending} onPress={() => resume.mutate()}>
              <Terminal aria-hidden="true" />Terminal Resume
            </Button>
          </div>
        ) : <p className="run-detail__empty">没有可恢复的 Session</p>}
        {resume.isSuccess ? <p className="run-detail__action-status">Terminal 已打开</p> : null}
        {actionError ? <p className="run-detail__action-error" role="alert">{actionError}</p> : null}
      </section>

      {(run.has_stdout_log || run.has_stderr_log) ? (
        <section className="run-detail__section">
          <div className="run-detail__section-heading">
            <h3>日志</h3>
            <div className="run-detail__log-actions">
              {run.has_stdout_log ? (
                <Button size="xs" variant={logStream === 'stdout' ? 'secondary' : 'quiet'} onPress={() => setLogStream('stdout')}>stdout</Button>
              ) : null}
              {run.has_stderr_log ? (
                <Button size="xs" variant={logStream === 'stderr' ? 'secondary' : 'quiet'} onPress={() => setLogStream('stderr')}>stderr</Button>
              ) : null}
            </div>
          </div>
          {log.isPending && logStream ? <div className="run-detail__log-state">正在读取日志…</div> : null}
          {log.isError ? <div className="run-detail__log-state is-error">{log.error.message}</div> : null}
          {log.data ? (
            <pre className="run-detail__log"><code>{log.data.content || '日志为空'}</code></pre>
          ) : null}
          {log.data?.truncated ? <small className="run-detail__log-note">仅显示最后 32 KiB</small> : null}
        </section>
      ) : null}
    </article>
  )
}
