import assert from 'node:assert/strict'
import test from 'node:test'

import {
  projectInboxButtonLabel,
  projectInboxMarkup,
  projectInboxPresentation,
} from '../ui/src/project-inbox.mjs'

const session = {
  id: 'source-session-1', source: 'codex', external_session_id: 'session-123',
  root_external_session_id: 'root-123', agent: 'codex-main',
  worktree: '/repo/.worktree/feature-a', branch: 'feature/a',
  last_seen_at: '2026-08-20T09:30:00.000Z',
}

test('Project Inbox presents source identity and local context without inferring a Project', () => {
  const presentation = projectInboxPresentation(session)
  assert.deepEqual({ ...presentation, lastSeen: '<local>' }, {
    id: 'source-session-1', source: 'codex', sessionId: 'session-123',
    rootSessionId: 'root-123', agent: 'codex-main',
    context: '/repo/.worktree/feature-a · feature/a', lastSeen: '<local>',
  })
  assert.match(presentation.lastSeen, /08\/20/)
  assert.equal(projectInboxButtonLabel(2), '项目 2')
  assert.equal(projectInboxButtonLabel(0), '项目')
})

test('Project Inbox markup separates Project assignment from Task attribution and escapes values', () => {
  const markup = projectInboxMarkup({
    sessions: [{ ...session, external_session_id: '<script>bad()</script>' }],
    projects: [{ id: 'project-a', name: 'Project <A>' }],
  })
  assert.match(markup, /项目待认领/)
  assert.match(markup, /branch 名不会自动合并项目/)
  assert.match(markup, /data-project-assign="source-session-1"/)
  assert.match(markup, /Project &lt;A&gt;/)
  assert.doesNotMatch(markup, /<script>/)
  assert.doesNotMatch(markup, /Task Attribution/)
})
