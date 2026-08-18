import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'

import {
  ActivityCell,
  AgentsCell,
  BranchCell,
  ExecutionContextCell,
  ExecutionsCell,
  NoteCell,
  SessionCell,
  StatusCell,
  TaskBar,
  TaskCell,
  WorkfolderCell,
  WorktreeCell,
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
  workfolder: '/Users/me/project',
  workfolder_display: '~/project',
  worktree: '/Users/me/project/.worktree/feature-svar',
  worktree_display: '~/project/.worktree/feature-svar',
  branch: 'feature/svar',
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
  assert.match(html, /data-task-toggle-id="root"/)
  assert.match(html, /class="task-label is-summary"/)
  assert.match(html, /aria-expanded="true"/)
  assert.match(html, /title="Ship &lt;SVAR&gt; safely"/)
  assert.match(html, /aria-label="打开任务详情：Ship &lt;SVAR&gt; safely；当前已展开"/)
  assert.match(html, /Ship &lt;SVAR&gt; safely/)
  assert.doesNotMatch(html, /<SVAR>|<script/)
})

test('status and session cells preserve menu and complete-copy contracts', () => {
  const status = markup(StatusCell)
  const session = markup(SessionCell)
  assert.match(status, /data-status-task-id="root"/)
  assert.match(status, /aria-haspopup="listbox"/)
  assert.match(status, /class="progress-ring"/)
  assert.match(status, /aria-label="Ship &lt;SVAR&gt; safely：未完成 1 \/ 4，已完成 75%"/)
  assert.match(session, />019fa297…aaab</)
  assert.match(session, /data-copy-session-id="019fa297-4567-7bf0-a69a-84fd23b3aaab"/)
  assert.match(session, /aria-label="复制 Session ID 019fa297-4567-7bf0-a69a-84fd23b3aaab"/)
  assert.match(session, /class="session-copy-icon"/)
})

test('context cells expose shortened text and complete keyboard tooltip values', () => {
  const workfolder = markup(WorkfolderCell)
  const worktree = markup(WorktreeCell)
  const branch = markup(BranchCell)
  assert.match(workfolder, /data-full-path="\/Users\/me\/project"/)
  assert.match(workfolder, /tabindex="0"/)
  assert.match(workfolder, />~\/project</)
  assert.match(worktree, /data-full-path="\/Users\/me\/project\/.worktree\/feature-svar"/)
  assert.match(branch, /data-full-path="feature\/svar"/)
})

test('execution context keeps workfolder, worktree, and branch in one scannable cell', () => {
  const context = markup(ExecutionContextCell)
  assert.match(context, /class="context-path execution-context-cell"/)
  assert.match(context, /class="execution-context-location"[^>]*>~\/project\/.worktree\/feature-svar</)
  assert.match(context, /class="execution-context-branch"[^>]*>feature\/svar</)
  assert.match(context, /工作目录：\/Users\/me\/project；Worktree：\/Users\/me\/project\/\.worktree\/feature-svar；Branch：feature\/svar/)
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
