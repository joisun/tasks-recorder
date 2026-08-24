import React from 'react'

import {
  progressPresentation,
  labelPlacement,
  sessionIdPresentation,
} from './dashboard-state.mjs'

const h = React.createElement
const STATUS_LABELS = {
  active: '进行中',
  waiting: '等待中',
  blocked: '已阻塞',
  planned: '待安排',
  done: '已完成',
  canceled: '已取消',
}

function rowTitle(row) {
  return row?.text || row?.source?.title || '未命名任务'
}

export function TaskCell({ row }) {
  const summary = row.type === 'summary'
  const project = row.entity_type === 'project'
  const title = rowTitle(row)
  const expandedText = row.open ? '当前已展开' : '当前已折叠'
  if (project || row.history_context) {
    return h('span', {
      className: `task-label is-summary${project ? ' is-project' : ' is-context'}`,
      title,
      'aria-label': `${project ? '项目' : '历史上下文'}：${title}；${expandedText}`,
    }, title)
  }
  return h('button', {
    className: `task-label${summary ? ' is-summary' : ''}`,
    type: 'button',
    title,
    'data-task-details-id': row.id,
    ...(summary ? {
      'data-task-toggle-id': row.id,
      'aria-expanded': Boolean(row.open),
      'aria-label': `打开任务详情：${title}；${expandedText}`,
    } : {
      'aria-label': `打开任务详情：${title}`,
    }),
  }, title)
}

export function StatusCell({ row }) {
  const statusLabel = STATUS_LABELS[row.status] ?? row.status ?? '未知状态'
  const task = {
    ...row.source,
    title: rowTitle(row),
    status: row.source?.status ?? row.status,
    rollup_state: row.source?.rollup_state ?? row.status,
  }
  const presentation = progressPresentation(task, statusLabel)
  const isSubtask = row.entity_type === 'subtask'
  const hierarchyClass = isSubtask ? ' entity-subtask' : ''
  const groupProgressClass = presentation.indicator === 'bar' ? ' is-group-progress' : ''
  const indicator = h('span', {
    className: isSubtask
      ? `status-dot status-${presentation.state}`
      : presentation.indicator === 'bar'
        ? `group-progress-bar status-${presentation.state}`
        : `progress-ring kind-${presentation.kind} status-${presentation.state}`,
    style: { '--progress': `${Math.round(presentation.ratio * 100)}%` },
    'aria-hidden': 'true',
    key: 'indicator',
  })
  if (row.entity_type === 'project') {
    const running = Number.isInteger(row.running_execution_count) ? row.running_execution_count : 0
    const blocked = Number.isInteger(row.blocked_count) ? row.blocked_count : 0
    const liveLabel = running > 0 ? `${running} running` : null
    return h('span', {
      className: `status-control${groupProgressClass} is-readonly live-${row.live_state ?? 'none'}${hierarchyClass}`,
      'aria-label': `${presentation.ariaLabel}${liveLabel ? `；${liveLabel}` : ''}${blocked ? `；${blocked} 个阻塞` : ''}`,
    }, [
      indicator,
      h('span', { className: 'progress-text', key: 'text' }, presentation.text),
    ])
  }
  if (row.historical || row.history_context) {
    return h('span', {
      className: `status-control${groupProgressClass} is-readonly${hierarchyClass}`,
      'aria-label': presentation.ariaLabel,
    }, [indicator, h('span', { className: 'progress-text', key: 'text' }, presentation.text)])
  }
  return h('button', {
    className: `status-control${groupProgressClass}${hierarchyClass}`,
    type: 'button',
    'data-status-task-id': row.id,
    'aria-haspopup': 'menu',
    'aria-expanded': 'false',
    'aria-label': presentation.ariaLabel,
    disabled: Boolean(row.statusPending),
  }, [indicator, h('span', { className: 'progress-text', key: 'text' }, presentation.text)])
}

export function SessionCell({ row }) {
  const session = sessionIdPresentation(row.session_id)
  if (session.empty) return h('span', { className: 'session-id-cell is-empty' }, '—')
  return h('span', { className: 'session-id-cell', title: session.full }, [
    h('span', { className: 'session-id-value', key: 'value' }, session.display),
    h('button', {
      className: 'session-copy',
      type: 'button',
      'data-copy-session-id': session.full,
      'aria-label': `复制 Session ID ${session.full}`,
      title: '复制 Session ID',
      key: 'copy',
    }, [
      h('span', { className: 'session-copy-icon', 'aria-hidden': 'true', key: 'icon' }),
      h('span', { className: 'session-copy-check', 'aria-hidden': 'true', key: 'check' }, '✓'),
    ]),
  ])
}

function ContextCell({ full, display, label }) {
  if (typeof full !== 'string' || full === '') {
    return h('span', { className: 'context-path is-empty' }, '—')
  }
  return h('span', {
    className: 'context-path context-value-cell',
    tabIndex: 0,
    'aria-label': `${label}：${full}`,
    'data-full-path': full,
  }, [
    h('span', { className: 'context-value', key: 'value' }, display || full),
    h('button', {
      className: 'context-copy',
      type: 'button',
      'data-copy-context-value': full,
      'data-copy-context-label': label,
      'aria-label': `复制 ${label}`,
      key: 'copy',
    }, [
      h('span', { className: 'session-copy-icon', 'aria-hidden': 'true', key: 'icon' }),
      h('span', { className: 'session-copy-check', 'aria-hidden': 'true', key: 'check' }, '✓'),
    ]),
  ])
}

export function WorkspaceCell({ row }) {
  return h(ContextCell, {
    full: row.workspace,
    display: row.workspace_display,
    label: 'Workspace',
  })
}

export function BranchCell({ row }) {
  return h(ContextCell, { full: row.branch, display: row.branch, label: 'Branch' })
}

export function NoteCell({ row }) {
  return row.note
    ? h('span', { className: 'task-note', title: row.note }, row.note)
    : h('span', { className: 'task-note is-empty' }, '—')
}

export function AgentsCell({ row }) {
  const count = Number.isInteger(row.active_agent_count) ? row.active_agent_count : 0
  const text = `${count} ${count === 1 ? 'agent' : 'agents'}`
  return h('span', {
    className: `execution-summary${count > 0 ? ' has-active-agents' : ''}`,
    title: `最近 Agent：${row.agent || 'Unknown'}；当前 ${text}`,
  }, [
    h('span', { className: 'agent-dot', 'aria-hidden': 'true', key: 'dot' }),
    text,
  ])
}

export function ExecutionsCell({ row }) {
  const count = Number.isInteger(row.execution_count) ? row.execution_count : 0
  const text = `${count} ${count === 1 ? 'execution' : 'executions'}`
  return h('span', {
    className: 'execution-count',
    'aria-label': `${rowTitle(row)}：${text}`,
  }, text)
}

export function ActivityCell({ row }) {
  const activity = row.activity ?? { text: '—', tone: 'default' }
  return h('span', {
    className: `activity-time${activity.tone === 'default' ? '' : ` is-${activity.tone}`}`,
    ...(activity.title ? { title: activity.title } : {}),
  }, activity.text)
}

export function TaskBar({ data, api, labelsVisible = false }) {
  const state = api?.getState?.() ?? {}
  const placement = labelPlacement({
    text: rowTitle(data),
    barLeft: Number.isFinite(data.$x) ? data.$x : 0,
    barWidth: Number.isFinite(data.$w) ? data.$w : 0,
    scrollLeft: Number.isFinite(state.scrollLeft) ? state.scrollLeft : 0,
    clientWidth: Number.isFinite(state._chartWidth) ? state._chartWidth : 0,
  })
  return h('div', {
    className: `svar-task-bar${data.type === 'summary' ? ' is-summary' : ''} status-${data.status} entity-${data.entity_type ?? 'task'} visual-${data.visual_mode ?? 'legacy'} label-${placement}`,
    'data-task-bar-id': data.id,
  }, labelsVisible ? h('span', { className: 'svar-task-bar-label' }, rowTitle(data)) : null)
}
