import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { detectAgent } from '../hooks/src/hook-context.mjs'
import { taskInput, temporaryApi } from './helpers.mjs'

const projectRoot = new URL('..', import.meta.url).pathname

function runHook(script, input, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      cwd: projectRoot,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr }))
    child.stdin.end(JSON.stringify(input))
  })
}

test('detectAgent identifies Codex and Claude transcript roots', () => {
  assert.equal(detectAgent({ transcript_path: '/Users/me/.codex/sessions/a.jsonl' }), 'Codex')
  assert.equal(detectAgent({ transcript_path: '/Users/me/.claude/projects/a.jsonl' }), 'Claude')
  assert.equal(detectAgent({ transcript_path: null }), 'Unknown')
})

test('UserPromptSubmit adds task synchronization context for concrete work of any duration', async () => {
  const result = await runHook('hooks/user-prompt-task-sync.mjs', {
    hook_event_name: 'UserPromptSubmit', session_id: 'session-1',
    cwd: '/workspace/example', transcript_path: '/Users/me/.codex/sessions/a.jsonl',
    prompt: 'fix the type error',
  })
  assert.equal(result.code, 0)
  const output = JSON.parse(result.stdout)
  const context = output.hookSpecificOutput.additionalContext
  assert.match(context, /short, medium, and long/i)
  assert.match(context, /agent_tasks_context/)
  assert.match(context, /"agent":"Codex"/)
})

test('PostToolUse heartbeat silently advances the current bound task', async () => {
  let current = new Date('2026-08-12T08:00:00.000Z')
  const fixture = await temporaryApi({ clock: () => current })
  try {
    fixture.store.upsert(taskInput())
    current = new Date('2026-08-12T08:01:00.000Z')
    const dataDirectory = join(fixture.directory, '.config', 'tasks-recorder')
    await mkdir(dataDirectory, { recursive: true })
    await writeFile(join(dataDirectory, 'config.json'), JSON.stringify({ output_dir: fixture.directory }))
    const result = await runHook('hooks/task-heartbeat.mjs', {
      hook_event_name: 'PostToolUse', session_id: 'session-1', cwd: '/workspace/example',
      transcript_path: '/Users/me/.codex/sessions/a.jsonl', tool_name: 'Bash',
    }, {
      HOME: fixture.directory,
      AGENT_TASKS_SERVER_URL: fixture.url,
      AGENT_TASKS_DATABASE_PATH: fixture.databasePath,
    })
    assert.equal(result.code, 0)
    assert.equal(result.stdout, '')
    assert.equal(fixture.store.show('example-task').sessions[0].last_seen_at, '2026-08-12T08:01:00.000Z')
    assert.equal(fixture.hub.current().revision, 1)
  } finally {
    await fixture.cleanup()
  }
})

test('PostToolUse heartbeat fails open when taskd is unavailable', async () => {
  const result = await runHook('hooks/task-heartbeat.mjs', {
    hook_event_name: 'PostToolUse', session_id: 'session-1', cwd: '/workspace/example',
    transcript_path: '/Users/me/.codex/sessions/a.jsonl', tool_name: 'Bash',
  }, {
    AGENT_TASKS_SERVER_URL: 'http://127.0.0.1:1',
  })
  assert.equal(result.code, 0)
  assert.equal(result.stdout, '')
})

test('Stop requests final synchronization without auto-proceed wording', async () => {
  const result = await runHook('hooks/stop-task-check.mjs', {
    hook_event_name: 'Stop', session_id: 'session-1', cwd: '/workspace/example',
    transcript_path: '/Users/me/.codex/sessions/a.jsonl', stop_hook_active: false,
  })
  assert.equal(result.code, 0)
  const output = JSON.parse(result.stdout)
  assert.equal(output.decision, 'block')
  assert.match(output.reason, /concrete Agent work/i)
  assert.doesNotMatch(output.reason, /proceed with the task automatically/i)
  assert.doesNotMatch(output.reason, /do not record one-off questions or tiny work/i)
})
