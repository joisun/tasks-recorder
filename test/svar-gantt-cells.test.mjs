import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'

import {
  ActivityCell,
  AgentsCell,
  BranchCell,
  ExecutionsCell,
  NoteCell,
  SessionCell,
  StatusCell,
  TaskBar,
  TaskCell,
  WorkspaceCell,
} from '../ui/src/svar-gantt-cells.mjs'

const summary = {
  id: 'root',
  text: 'Ship <SVAR> safely',
  type: 'summary',
  open: true,
  status: 'active',
  source: {
    title: 'Ship <SVAR> safely',
    progress: { remaining: 1, total: 4, completed: 3, ratio: 0.75 },
  },
  session_id: '019fa297-4567-7bf0-a69a-84fd23b3aaab',
  workspace: '/Users/me/project',
  workspace_display: '~/project',
  branch: 'feature/svar',
  resume_available: true,
  note: 'Finish renderer integration',
  active_agent_count: 2,
  execution_count: 5,
  activity: { text: '15m', tone: 'default', minutes: 15 },
}

function markup(Component, row = summary, extra = {}) {
  return renderToStaticMarkup(Component({ row, ...extra }))
}

test('task cell exposes safe details and keyboard tree behavior', () => {
  const html = markup(TaskCell)
  assert.match(html, /data-task-details-id="root"/)
  assert.match(html, /data-resume-task-id="root"/)
  assert.match(html, /aria-label="在终端继续会话：Ship &lt;SVAR&gt; safely"/)
  assert.match(html, /data-task-toggle-id="root"/)
  assert.match(html, /class="task-label is-summary"/)
  assert.match(html, /aria-expanded="true"/)
  assert.match(html, /title="Ship &lt;SVAR&gt; safely"/)
  assert.match(html, /aria-label="打开任务详情：Ship &lt;SVAR&gt; safely；当前已展开"/)
  assert.match(html, /Ship &lt;SVAR&gt; safely/)
  assert.doesNotMatch(html, /<SVAR>|<script/)
})

test('Project rows never expose a session resume action', () => {
  const html = markup(TaskCell, { ...summary, entity_type: 'project', resume_available: false })
  assert.doesNotMatch(html, /data-resume-task-id/)
})

test('status and session cells preserve menu and complete-copy contracts', () => {
  const status = markup(StatusCell)
  const session = markup(SessionCell)
  assert.match(status, /data-status-task-id="root"/)
  assert.match(status, /aria-haspopup="menu"/)
  assert.match(status, /class="status-control is-group-progress"/)
  assert.match(status, /class="group-progress-bar status-active"/)
  assert.match(status, />3\/4</)
  assert.match(status, /aria-label="Ship &lt;SVAR&gt; safely：已完成 3\/4，75%"/)
  assert.match(session, />019fa297…aaab</)
  assert.match(session, /data-copy-session-id="019fa297-4567-7bf0-a69a-84fd23b3aaab"/)
  assert.match(session, /aria-label="复制 Session ID 019fa297-4567-7bf0-a69a-84fd23b3aaab"/)
  assert.match(session, /class="session-copy-icon"/)
})

test('Project status uses a compact progress bar without visible runtime metadata', () => {
  const html = markup(StatusCell, {
    ...summary,
    entity_type: 'project', running_execution_count: 2,
    blocked_count: 1, live_state: 'running',
    source: { ...summary.source, progress: { completed: 3, total: 5, remaining: 2, ratio: 0.6 } },
  })
  assert.match(html, /status-control is-group-progress is-readonly live-running/)
  assert.match(html, /class="group-progress-bar status-active"/)
  assert.match(html, />3\/5</)
  assert.doesNotMatch(html, />2 running</)
  assert.match(html, /aria-label="Ship &lt;SVAR&gt; safely：已完成 3\/5，60%；2 running；1 个阻塞"/)
  assert.doesNotMatch(html, /data-status-task-id/)
})

test('Subtask status uses a compact status dot', () => {
  const html = markup(StatusCell, {
    id: 'leaf', text: 'Leaf', entity_type: 'subtask', status: 'active', source: {
      title: 'Leaf', status: 'active', progress: null,
    },
  })
  assert.match(html, /class="status-control entity-subtask"/)
  assert.match(html, /class="status-dot status-active"/)
  assert.match(html, />进行中</)
  assert.doesNotMatch(html, /progress-ring|group-progress-bar/)
})

test('leaf Main Task keeps the full-size hierarchy ring', () => {
  const html = markup(StatusCell, {
    id: 'main-leaf', text: 'Main leaf', entity_type: 'main_task', status: 'active', source: {
      title: 'Main leaf', status: 'active', progress: null,
    },
  })
  assert.match(html, /class="status-control"/)
  assert.match(html, /class="progress-ring kind-status status-active"/)
  assert.doesNotMatch(html, /entity-subtask/)
})

test('Workspace and Branch expose one tooltip and independent copy controls', () => {
  const workspace = markup(WorkspaceCell)
  const branch = markup(BranchCell)
  assert.match(workspace, /data-full-path="\/Users\/me\/project"/)
  assert.match(workspace, /tabindex="0"/)
  assert.doesNotMatch(workspace, /title=/)
  assert.match(workspace, /class="context-value"[^>]*>~\/project</)
  assert.match(workspace, /data-copy-context-value="\/Users\/me\/project"/)
  assert.match(workspace, /data-copy-context-label="Workspace"/)
  assert.match(workspace, /aria-label="复制 Workspace"/)
  assert.match(branch, /data-full-path="feature\/svar"/)
  assert.match(branch, /data-copy-context-value="feature\/svar"/)
  assert.match(branch, /data-copy-context-label="Branch"/)
  assert.match(branch, /aria-label="复制 Branch"/)
})

test('remaining cells and task bar render semantic text without raw HTML paths', () => {
  const malicious = {
    ...summary,
    note: '<img src=x onerror=alert(1)>',
    text: '<script>bad()</script>',
    $x: 540,
    $w: 16,
  }
  const taskApi = {
    getState: () => ({ scrollLeft: 0, _chartWidth: 600 }),
  }
  const combined = [
    markup(NoteCell, malicious),
    markup(AgentsCell),
    markup(ExecutionsCell),
    markup(ActivityCell),
    renderToStaticMarkup(TaskBar({ data: malicious, api: taskApi, labelsVisible: true })),
  ].join('')
  assert.match(combined, /2 agents/)
  assert.match(combined, /5 executions/)
  assert.match(combined, />15m</)
  assert.match(combined, /&lt;img src=x onerror=alert\(1\)&gt;/)
  assert.match(combined, /&lt;script&gt;bad\(\)&lt;\/script&gt;/)
  assert.match(combined, /label-left/)
  assert.match(combined, /svar-task-bar is-summary status-active/)
  assert.doesNotMatch(combined, /<img|<script/)
})
