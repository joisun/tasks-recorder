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
  const title = rowTitle(row)
  const expandedText = row.open ? '当前已展开' : '当前已折叠'
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
  const task = { ...row.source, title: rowTitle(row) }
  const presentation = progressPresentation(task, statusLabel)
  return h('button', {
    className: presentation.ring ? 'progress-control' : `status-pill status-${row.status}`,
    type: 'button',
    'data-status-task-id': row.id,
    'aria-haspopup': 'listbox',
    'aria-expanded': 'false',
    'aria-label': presentation.ariaLabel,
    disabled: Boolean(row.statusPending),
  }, presentation.ring
    ? [
        h('span', {
          className: 'progress-ring',
          style: { '--progress': `${Math.round(presentation.ratio * 100)}%` },
          'aria-hidden': 'true',
          key: 'ring',
        }),
        h('span', { className: 'progress-text', key: 'text' }, presentation.text),
      ]
    : presentation.text)
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

function ContextCell({ row, field, displayField = field }) {
  const full = row[field]
  if (typeof full !== 'string' || full === '') {
    return h('span', { className: 'context-path is-empty' }, '—')
  }
  return h('span', {
    className: 'context-path',
    tabIndex: 0,
    title: full,
    'aria-label': `完整路径：${full}`,
    'data-full-path': full,
  }, row[displayField] || full)
}

export function WorkfolderCell({ row }) {
  return h(ContextCell, { row, field: 'workfolder', displayField: 'workfolder_display' })
}

export function WorktreeCell({ row }) {
  return h(ContextCell, { row, field: 'worktree', displayField: 'worktree_display' })
}

export function BranchCell({ row }) {
  return h(ContextCell, { row, field: 'branch' })
}

export function ExecutionContextCell({ row }) {
  const workfolder = row.workfolder_display || row.workfolder || '—'
  const worktree = row.worktree_display || row.worktree || workfolder
  const branch = row.branch || '未绑定分支'
  const description = `工作目录：${row.workfolder || '—'}；Worktree：${row.worktree || '—'}；Branch：${row.branch || '—'}`
  return h('span', {
    className: 'context-path execution-context-cell',
    tabIndex: 0,
    title: description,
    'aria-label': description,
    'data-full-path': description,
  }, [
    h('span', { className: 'execution-context-location', key: 'location' }, worktree),
    h('span', { className: 'execution-context-branch', key: 'branch' }, branch),
  ])
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
    className: `svar-task-bar${data.type === 'summary' ? ' is-summary' : ''} status-${data.status} label-${placement}`,
    'data-task-bar-id': data.id,
  }, labelsVisible ? h('span', { className: 'svar-task-bar-label' }, rowTitle(data)) : null)
}
