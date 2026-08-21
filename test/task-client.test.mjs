import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'

import { createTaskClient } from '../mcp/src/task-client.mjs'
import { taskInput } from './helpers.mjs'

async function recordingServer() {
  const requests = []
  const server = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    requests.push({
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization,
      body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null,
    })
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ ok: true, tasks: [], candidates: [] }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    requests,
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  }
}

test('task client maps every operation to the token-free versioned HTTP contract', async () => {
  const recorder = await recordingServer()
  const client = createTaskClient({ baseUrl: recorder.url, timeoutMs: 1_000 })
  try {
    await client.context({ session_id: 'session-1', workfolder: '/workspace' })
    await client.list({ status: 'active', branch: 'feature/a' })
    await client.show('task-a')
    await client.upsert(taskInput({ id: 'task-a' }))
    await client.complete({ id: 'task-a', session_id: 'session-1', workfolder: '/workspace' })
    await client.render()
    await client.check()
    await client.updateStatus({
      id: 'task-a',
      status: 'blocked',
      expected_updated_at: '2026-08-12T08:00:00.000Z',
    })

    assert.deepEqual(
      recorder.requests.map(({ method, url }) => [method, url]),
      [
        ['POST', '/api/v1/context'],
        ['GET', '/api/v1/tasks?status=active&branch=feature%2Fa'],
        ['GET', '/api/v1/tasks/task-a'],
        ['PUT', '/api/v1/tasks/task-a'],
        ['POST', '/api/v1/tasks/task-a/complete'],
        ['POST', '/api/v1/render'],
        ['GET', '/api/v1/check'],
        ['PATCH', '/api/v1/tasks/task-a/status'],
      ],
    )
    assert.ok(recorder.requests.every(({ authorization }) => authorization === undefined))
    assert.equal(recorder.requests[3].body.id, 'task-a')
    assert.deepEqual(recorder.requests.at(-1).body, {
      status: 'blocked',
      expected_updated_at: '2026-08-12T08:00:00.000Z',
    })
  } finally {
    await recorder.close()
  }
})

test('task client preserves domain codes and normalizes connectivity errors', async () => {
  const unavailable = createTaskClient({
    baseUrl: 'http://127.0.0.1:1',
    fetchImpl: async () => { throw new Error('low-level connection detail') },
  })
  await assert.rejects(
    unavailable.list({}),
    (error) => error.code === 'SERVICE_UNAVAILABLE'
      && !error.message.includes('low-level connection detail'),
  )

  const domain = createTaskClient({
    baseUrl: 'http://127.0.0.1:1',
    fetchImpl: async () => new Response(JSON.stringify({
      ok: false,
      error: { code: 'TASK_NOT_FOUND', message: 'task missing', details: { id: 'missing' } },
    }), { status: 404, headers: { 'Content-Type': 'application/json' } }),
  })
  await assert.rejects(
    domain.show('missing'),
    (error) => error.code === 'TASK_NOT_FOUND' && error.details.id === 'missing',
  )
})

test('task client maps tree, execution, and lifecycle contracts without credentials', async () => {
  const recorder = await recordingServer()
  const client = createTaskClient({ baseUrl: recorder.url, timeoutMs: 1_000 })
  try {
    assert.equal(typeof client.syncTree, 'function')
    await client.syncTree({ session_id: 'session-1', root: {}, children: [] })
    await client.updateTask({ id: 'task-a', expected_revision: 1, patch: { title: 'A' } })
    await client.archiveTask({ id: 'task-a', expected_revision: 2 })
    await client.deleteTask({ id: 'task-a', expected_revision: 3 })
    await client.restoreTask({ id: 'task-a', expected_revision: 4 })
    await client.taskEvents('task-a')
    await client.sessionStart({ root_session_id: 'session-1' })
    await client.turnStart({ root_session_id: 'session-1' })
    await client.toolUse({ root_session_id: 'session-1' })
    await client.subagentStart({ root_session_id: 'session-1' })
    await client.subagentStop({ root_session_id: 'session-1' })
    await client.sessionEnd({ root_session_id: 'session-1' })
    await client.sessionContext('session-1')
    await client.listExecutions({ root_session_id: 'session-1', unassigned: true })
    await client.assignExecution({ id: 'execution-1', task_id: 'task-a', expected_task_id: null })
    await client.classifyExecution({
      id: 'execution-1', classification: 'non_work',
      expected_classification: 'work', expected_task_id: 'task-a',
    })
    await client.updateExecutionAssignments({ changes: [] })
    await client.importExecutions({ source: 'codex', dry_run: true, records: [] })
    await client.workContext({ execution_id: 'execution-1' })
    await client.workFocus({ execution_id: 'execution-1', task_id: 'task-a' })
    await client.registerIntent({
      execution_id: 'execution-1', external_agent_key: 'child-1', task_id: 'task-a',
    })
    await client.workCheckpoint({ execution_id: 'execution-1', task_id: 'task-a' })
    await client.correctAttribution({ segment_id: 'segment-1', task_id: 'task-a' })
    await client.mutateTask({ action: 'create', task: { id: 'task-b' } })
    await client.syncStructure({ project_id: 'project-a', main_task: {}, children: [] })

    assert.deepEqual(recorder.requests.map(({ method, url }) => [method, url]), [
      ['POST', '/api/v1/tasks/sync-tree'],
      ['PATCH', '/api/v1/tasks/task-a'],
      ['POST', '/api/v1/tasks/task-a/archive'],
      ['POST', '/api/v1/tasks/task-a/delete'],
      ['POST', '/api/v1/tasks/task-a/restore'],
      ['GET', '/api/v1/tasks/task-a/events'],
      ['POST', '/api/v1/lifecycle/session-start'],
      ['POST', '/api/v1/lifecycle/turn-start'],
      ['POST', '/api/v1/lifecycle/tool-use'],
      ['POST', '/api/v1/lifecycle/subagent-start'],
      ['POST', '/api/v1/lifecycle/subagent-stop'],
      ['POST', '/api/v1/lifecycle/session-end'],
      ['GET', '/api/v1/sessions/session-1/context'],
      ['GET', '/api/v1/executions?root_session_id=session-1&unassigned=true'],
      ['PATCH', '/api/v1/executions/execution-1/task'],
      ['PATCH', '/api/v1/executions/execution-1/classification'],
      ['PATCH', '/api/v1/executions/tasks'],
      ['POST', '/api/v1/import/executions'],
      ['POST', '/api/v1/work/context'],
      ['POST', '/api/v1/work/focus'],
      ['POST', '/api/v1/work/intents'],
      ['POST', '/api/v1/work/checkpoint'],
      ['PATCH', '/api/v1/segments/segment-1/attribution'],
      ['POST', '/api/v1/tasks/mutate'],
      ['POST', '/api/v1/tasks/sync-structure'],
    ])
    assert.ok(recorder.requests.every(({ authorization }) => authorization === undefined))
  } finally {
    await recorder.close()
  }
})
