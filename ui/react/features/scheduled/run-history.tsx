import type { RunDispatchRecord, RunRecord } from '@/lib/api/types'
import {
  compactDateTime,
  runDuration,
  runStatusLabel,
  triggerLabel,
} from './schedule-format'

function runTimestamp(run: RunRecord) {
  return Date.parse(run.finished_at ?? run.started_at ?? run.created_at) || 0
}

function dispatchTimestamp(dispatch: RunDispatchRecord) {
  return Date.parse(dispatch.last_attempted_at ?? dispatch.requested_at ?? '') || 0
}

export function RunHistory({
  runs,
  dispatches,
  selectedRunId,
  onSelect,
}: {
  runs: RunRecord[]
  dispatches: RunDispatchRecord[]
  selectedRunId: string | null
  onSelect: (runId: string) => void
}) {
  const rows = [
    ...runs.map((run) => ({ kind: 'run' as const, timestamp: runTimestamp(run), run })),
    ...dispatches.map((dispatch) => ({
      kind: 'dispatch' as const,
      timestamp: dispatchTimestamp(dispatch),
      dispatch,
    })),
  ].sort((left, right) => right.timestamp - left.timestamp)

  if (!rows.length) {
    return <div className="run-history__empty">还没有执行记录</div>
  }

  return (
    <div className="run-history">
      <table role="grid" aria-label="执行历史">
        <thead>
          <tr>
            <th>状态</th>
            <th>开始</th>
            <th>耗时</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            if (row.kind === 'dispatch') {
              const { dispatch } = row
              return (
                <tr key={`dispatch-${dispatch.id}`} data-kind="dispatch">
                  <td>
                    <span className="run-history__status">
                      <i data-status={dispatch.status} aria-hidden="true" />
                      {runStatusLabel(dispatch.status)}
                    </span>
                    <small>{triggerLabel(dispatch.trigger)} · 未创建 Run</small>
                  </td>
                  <td>{compactDateTime(dispatch.last_attempted_at ?? dispatch.requested_at)}</td>
                  <td>—</td>
                </tr>
              )
            }

            const { run } = row
            return (
              <tr
                key={run.id}
                aria-label={`${runStatusLabel(run.status)}，${compactDateTime(run.started_at ?? run.created_at)}，${runDuration(run.started_at, run.finished_at)}`}
                aria-selected={run.id === selectedRunId}
                data-selected={run.id === selectedRunId || undefined}
                tabIndex={0}
                onClick={() => onSelect(run.id)}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' && event.key !== ' ') return
                  event.preventDefault()
                  onSelect(run.id)
                }}
              >
                <td>
                  <span className="run-history__status">
                    <i data-status={run.status} aria-hidden="true" />
                    {runStatusLabel(run.status)}
                  </span>
                  <small>{triggerLabel(run.trigger)}{run.reviewed_at ? '' : ' · 未读'}</small>
                </td>
                <td>{compactDateTime(run.started_at ?? run.created_at)}</td>
                <td>{runDuration(run.started_at, run.finished_at)}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
