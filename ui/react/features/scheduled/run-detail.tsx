import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Clipboard, FileText, RefreshCw, Square, Terminal } from 'lucide-react'
import { useMemo, useState } from 'react'

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
import { LiveSession, SessionConversation } from './live-session'

const LOG_TAIL_BYTES = 32 * 1024
const ACTIVE_STATUSES = new Set(['queued', 'claimed', 'running'])

function shortSessionId(value: string) {
  if (value.length <= 20) return value
  return `${value.slice(0, 8)}…${value.slice(-8)}`
}

export function RunDetail({ api, run }: { api: DashboardApi; run: RunRecord }) {
  const queryClient = useQueryClient()
  const [logStream, setLogStream] = useState<'stdout' | 'stderr' | null>(null)
  const [copied, setCopied] = useState(false)
  const [actionError, setActionError] = useState('')
  const active = ACTIVE_STATUSES.has(run.status)
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
  const fileOpen = useMutation({
    mutationFn: (path: string) => api.openRunFile(run.id, path),
  })
  const cancel = useMutation({
    mutationFn: () => api.cancelRun(run.id),
    onMutate: () => setActionError(''),
    onError: (error) => setActionError(error instanceof Error ? error.message : '停止失败'),
    onSuccess: async (response) => {
      queryClient.setQueryData(queryKeys.run(run.id), response)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.runs(run.job_id) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.schedules }),
      ])
    },
  })
  const conversation = useQuery({
    queryKey: queryKeys.runConversation(run.id),
    queryFn: () => api.scheduledRunConversation(run.id),
    enabled: !active && Boolean(run.thread_id),
  })
  const historicalEntries = useMemo(() => {
    const entries = (conversation.data?.messages ?? []).map((message) => ({
      kind: 'message' as const,
      itemId: message.id,
      role: message.role,
      text: message.text,
    }))
    if (entries.length || !run.final_message) return entries
    return [{
      kind: 'message' as const,
      itemId: 'final-message',
      role: 'assistant' as const,
      text: run.final_message,
    }]
  }, [conversation.data?.messages, run.final_message])

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
          {active && !run.interactive ? (
            <Button
              className="run-detail__stop"
              isPending={cancel.isPending}
              size="xs"
              variant="quiet"
              onPress={() => cancel.mutate()}
            >
              <Square aria-hidden="true" />停止
            </Button>
          ) : null}
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

      {!active ? (
        <section className="live-session" aria-label="Session 对话">
          <header className="live-session__header">
            <h3>Session 对话</h3>
            <div className="live-session__header-actions">
              <span>{conversation.data?.truncated ? '仅展示最近消息' : 'Codex 本地 Session'}</span>
              {conversation.isError && <Button size="xs" variant="quiet" isPending={conversation.isFetching} onPress={() => void conversation.refetch()}><RefreshCw aria-hidden="true" />重新读取</Button>}
              {!run.reviewed_at ? (
                <Button size="xs" variant="quiet" isPending={reviewed.isPending} onPress={() => reviewed.mutate()}>
                  <Check aria-hidden="true" />标记已读
                </Button>
              ) : <span>已读</span>}
            </div>
          </header>
          <SessionConversation
            entries={historicalEntries}
            emptyText={!run.thread_id
              ? '此 Run 没有可恢复的 Session'
              : conversation.isPending
                ? '正在读取对话…'
                : conversation.isError
                  ? 'Codex 本地 Session 暂不可用'
                  : 'Session 中没有可展示的对话'}
          />
          {conversation.isError && run.final_message ? (
            <p className="live-session__notice">本地 Session 不可用，当前显示 Run final message。</p>
          ) : null}
        </section>
      ) : null}

      {run.error_code ? (
        <section className="run-detail__section">
          <div className="run-detail__section-heading"><h3>错误</h3></div>
          <code className="run-detail__error">{run.error_code === 'RUNTIME_PROTOCOL_CLOSED' ? 'Codex 执行连接已关闭，本次任务已结束。可查看退出码后重新运行。' : run.error_code === 'RUNTIME_PROTOCOL_FRAME_TOO_LARGE' ? 'Codex 单条消息超过接收上限，本次运行已中断。Session 已保留时可在 Terminal 恢复。' : run.error_code === 'RUNTIME_TIMEOUT' ? '执行超过任务设置的时间上限。请检查超时配置，或从已保存的 Session 继续。' : run.error_code}</code>
        </section>
      ) : null}

      <section className="run-detail__section">
        <div className="run-detail__section-heading"><h3>产出文件</h3><span>{run.file_changes.length}</span></div>
        {run.file_changes.length ? (
          <ul className="run-detail__files">
            {run.file_changes.map((file) => (
              <li key={`${file.kind}-${file.path}`}
                title={['delete', 'deleted', 'removed'].includes(file.kind) ? '文件已删除，无法打开' : file.path}>
                <FileText aria-hidden="true" />
                <Button
                  className="run-detail__file-open"
                  aria-label={`打开文件 ${file.path}`}
                  isDisabled={fileOpen.isPending || ['delete', 'deleted', 'removed'].includes(file.kind)}
                  size="xs"
                  variant="quiet"
                  onPress={() => fileOpen.mutate(file.path)}
                ><code>{file.path}</code></Button>
                <span>{file.kind}</span>
              </li>
            ))}
          </ul>
        ) : <p className="run-detail__empty">没有记录文件变更</p>}
        {fileOpen.isPending || fileOpen.isSuccess ? (
          <p className="run-detail__action-status" role="status">
            {fileOpen.isPending ? '正在请求系统打开…' : `已请求系统打开：${fileOpen.data?.path}`}
          </p>
        ) : null}
        {fileOpen.isError ? (
          <p className="run-detail__action-error" role="alert">
            {fileOpen.error instanceof Error ? fileOpen.error.message : '无法打开文件'}
          </p>
        ) : null}
      </section>

      <section className="run-detail__section">
        <div className="run-detail__section-heading"><h3>Session</h3></div>
        {run.thread_id ? (
          <div className="run-detail__session">
            <code>{shortSessionId(run.thread_id)}</code>
            <Button aria-label="复制 Session ID" isIconOnly size="xs" variant="quiet" onPress={() => void copySession()}>
              {copied ? <Check aria-hidden="true" /> : <Clipboard aria-hidden="true" />}
            </Button>
            <Button size="xs" variant="secondary" isPending={resume.isPending} isDisabled={active} onPress={() => resume.mutate()}>
              <Terminal aria-hidden="true" />Terminal Resume
            </Button>
          </div>
        ) : <p className="run-detail__empty">{active ? '等待 Codex 创建 Session…' : '任务在创建 Session 前结束，无法恢复；可重新运行。'}</p>}
        {active && run.thread_id ? <p className="run-detail__empty">Session 已保存，运行结束后可在 Terminal 恢复。</p> : null}
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
