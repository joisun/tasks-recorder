import { isAbsolute, relative, resolve, sep } from 'node:path'

import { skillsThreadConfig } from '../codex-capability-policy.mjs'

const FINAL_MESSAGE_BYTES = 8 * 1024
const FILE_CHANGE_KINDS = new Set(['add', 'update', 'delete'])

export function createCodexInteractiveSessionFactory({
  createClient,
  resolveCapabilityLaunch = async () => ({ disabledFeatures: [], configOverrides: [] }),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  if (typeof createClient !== 'function' || typeof setTimer !== 'function'
    || typeof clearTimer !== 'function' || typeof resolveCapabilityLaunch !== 'function') {
    throw new TypeError('Codex interactive session requires createClient')
  }

  return Object.freeze({
    create(options) {
      return createSession({
        ...options, createClient, resolveCapabilityLaunch, setTimer, clearTimer,
      })
    },
  })
}

function createSession({
  launch, run, signal, emit, onSpawn, createClient, resolveCapabilityLaunch,
  setTimer, clearTimer,
}) {
  if (typeof launch?.executable !== 'string' || !run || typeof run !== 'object'
    || typeof run.workspace !== 'string' || typeof run.prompt !== 'string'
    || !signal || typeof emit !== 'function' || typeof onSpawn !== 'function') {
    throw new TypeError('Codex interactive session options are invalid')
  }

  const capabilities = normalizedCapabilities(run.capabilities)
  let client = null
  let unsubscribe = () => {}
  let threadId = null
  let turnId = null
  let turnRevision = 0
  let finalMessage = ''
  const fileChanges = new Map()
  let settled = false
  let resolveCompletion
  const completion = new Promise((resolve) => { resolveCompletion = resolve })

  const handleNotification = ({ method, params }) => {
    if (method === 'turn/started') {
      const nextTurnId = params?.turn?.id
      if (params?.threadId !== threadId || typeof nextTurnId !== 'string') return
      if (turnId !== nextTurnId) {
        turnId = nextTurnId
        turnRevision += 1
        safeEmit(emit, { type: 'turn_started', payload: { turn_revision: turnRevision } })
      }
      return
    }
    if (method === 'item/agentMessage/delta') {
      if (params?.threadId !== threadId || params?.turnId !== turnId
        || typeof params?.itemId !== 'string' || typeof params?.delta !== 'string') return
      finalMessage = appendBounded(finalMessage, params.delta, FINAL_MESSAGE_BYTES)
      safeEmit(emit, {
        type: 'assistant_delta',
        payload: {
          turn_revision: turnRevision,
          item_id: params.itemId,
          delta: params.delta,
        },
      })
      return
    }
    if (method === 'item/started' || method === 'item/completed') {
      if (params?.threadId !== threadId || params?.turnId !== turnId
        || typeof params?.item?.id !== 'string') return
      const item = params.item
      if (method === 'item/completed' && item.type === 'agentMessage'
        && typeof item.text === 'string') {
        finalMessage = appendBounded('', item.text, FINAL_MESSAGE_BYTES)
      }
      if (method === 'item/completed' && item.type === 'fileChange'
        && item.status === 'completed' && Array.isArray(item.changes)) {
        for (const candidate of item.changes) {
          const change = containedFileChange(candidate, run.workspace)
          if (change && (fileChanges.has(change.path) || fileChanges.size < 128)) {
            fileChanges.set(change.path, change)
          }
        }
      }
      const label = activityLabel(item)
      if (label) {
        safeEmit(emit, {
          type: method === 'item/started' ? 'activity_started' : 'activity_completed',
          payload: {
            turn_revision: turnRevision,
            item_id: item.id,
            label,
            ...(method === 'item/completed' ? { state: activityState(item) } : {}),
          },
        })
      }
      return
    }
    if (method === 'turn/completed') {
      if (params?.threadId !== threadId || params?.turn?.id !== turnId) return
      finish(turnResult(params.turn, {
        threadId,
        finalMessage,
        fileChanges: [...fileChanges.values()],
      }))
    }
  }
  const onAbort = () => finish(failedResult(sessionError('RUN_CANCELED')))
  const timeout = setTimer(() => finish(timeoutResult()), run.timeout_seconds * 1_000)
  timeout?.unref?.()
  signal.addEventListener('abort', onAbort, { once: true })
  if (signal.aborted) onAbort()

  async function start() {
    if (settled) return completion
    try {
      const capabilityLaunch = await resolveCapabilityLaunch({
        executable: launch.executable,
        cwd: run.workspace,
        capabilities,
      })
      if (settled) return completion
      client = createClient({
        executable: launch.executable,
        cwd: run.workspace,
        signal,
        disabledFeatures: capabilityLaunch.disabledFeatures,
        configOverrides: capabilityLaunch.configOverrides,
      })
      unsubscribe = client.onNotification(handleNotification)
      const spawned = await client.started
      onSpawn({ pid: spawned.pid })
      await client.request('initialize', {
        clientInfo: { name: 'tasks-recorder', title: 'Tasks Recorder', version: 'source' },
      })
      const threadConfig = capabilities.skills === 'disabled'
        ? skillsThreadConfig(await client.request('skills/list', {
          cwds: [run.workspace],
          forceReload: true,
        }), { cwd: run.workspace })
        : null
      const startedThread = await client.request('thread/start', compact({
        cwd: run.workspace,
        model: run.model,
        approvalPolicy: 'never',
        sandbox: run.sandbox_mode,
        ephemeral: false,
        config: threadConfig,
      }))
      threadId = startedThread?.thread?.id
      if (typeof threadId !== 'string' || threadId.length === 0) {
        throw sessionError('RUNTIME_PROTOCOL_INVALID')
      }
      safeEmit(emit, { type: 'session', payload: { session_id: threadId } })
      safeEmit(emit, {
        type: 'user_message',
        payload: { kind: 'prompt', text: run.prompt },
      })
      const startedTurn = await client.request('turn/start', compact({
        threadId,
        input: [{ type: 'text', text: run.prompt }],
        cwd: run.workspace,
        model: run.model,
        effort: run.reasoning_effort,
      }))
      const startedTurnId = startedTurn?.turn?.id
      if (typeof startedTurnId !== 'string' || startedTurnId.length === 0) {
        throw sessionError('RUNTIME_PROTOCOL_INVALID')
      }
      if (turnId === null) {
        turnId = startedTurnId
        turnRevision += 1
        safeEmit(emit, { type: 'turn_started', payload: { turn_revision: turnRevision } })
      }
    } catch (error) {
      finish(failedResult(error))
    }
    return completion
  }

  async function steer({ expectedTurnRevision, text } = {}) {
    assertCurrentTurn(expectedTurnRevision)
    if (typeof text !== 'string' || text.trim() === '') {
      throw sessionError('INTERVENTION_INVALID')
    }
    await client.request('turn/steer', {
      threadId,
      expectedTurnId: turnId,
      input: [{ type: 'text', text }],
    })
    safeEmit(emit, {
      type: 'intervention_accepted',
      payload: { turn_revision: turnRevision, text: text.trim() },
    })
    return { accepted: true, turnRevision }
  }

  async function interrupt({ expectedTurnRevision } = {}) {
    assertCurrentTurn(expectedTurnRevision)
    await client.request('turn/interrupt', { threadId, turnId })
    return { accepted: true, turnRevision }
  }

  function assertCurrentTurn(expectedTurnRevision) {
    if (settled || threadId === null || turnId === null || turnRevision < 1) {
      throw sessionError('RUN_NOT_ACTIVE')
    }
    if (expectedTurnRevision !== turnRevision) throw sessionError('TURN_CHANGED')
  }

  function finish(result) {
    if (settled) return
    settled = true
    clearTimer(timeout)
    signal.removeEventListener('abort', onAbort)
    unsubscribe()
    client?.close()
    resolveCompletion(result)
  }

  return Object.freeze({
    start,
    steer,
    interrupt,
    close: () => finish(failedResult(sessionError('RUN_CANCELED'))),
    completion,
    get turnRevision() { return turnRevision },
    get steerable() { return !settled && turnRevision > 0 },
  })
}

function normalizedCapabilities(value) {
  const mode = (field) => value?.[field] === 'disabled' ? 'disabled' : 'inherit'
  return { skills: mode('skills'), integrations: mode('integrations') }
}

function turnResult(turn, { threadId, finalMessage, fileChanges }) {
  const succeeded = turn?.status === 'completed'
  return {
    status: succeeded ? 'succeeded' : (turn?.status === 'interrupted' ? 'canceled' : 'failed'),
    exit_code: succeeded ? 0 : null,
    error_code: succeeded ? null : (turn?.status === 'interrupted' ? 'RUN_CANCELED' : 'RUNTIME_PROCESS_FAILED'),
    session_id: threadId,
    final_message: finalMessage || null,
    usage: null,
    file_changes: fileChanges,
  }
}

function failedResult(error) {
  return {
    status: error?.code === 'RUN_CANCELED' ? 'canceled' : 'failed',
    exit_code: null,
    error_code: error?.code ?? 'RUNTIME_PROTOCOL_ERROR',
    session_id: null,
    final_message: null,
    usage: null,
    file_changes: [],
  }
}

function timeoutResult() {
  return {
    status: 'timed_out',
    exit_code: null,
    error_code: 'RUNTIME_TIMEOUT',
    session_id: null,
    final_message: null,
    usage: null,
    file_changes: [],
  }
}

function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, nested]) => nested !== null && nested !== undefined))
}

function appendBounded(current, delta, maximumBytes) {
  const next = `${current}${delta}`
  if (Buffer.byteLength(next) <= maximumBytes) return next
  const bytes = Buffer.from(next)
  return bytes.subarray(bytes.byteLength - maximumBytes).toString('utf8').replace(/^\uFFFD/, '')
}

function containedFileChange(change, workspace) {
  if (!change || typeof change !== 'object' || !FILE_CHANGE_KINDS.has(change.kind)
    || typeof change.path !== 'string' || change.path.length === 0
    || Buffer.byteLength(change.path) > 2048) return null
  const root = resolve(workspace)
  const absolute = isAbsolute(change.path) ? resolve(change.path) : resolve(root, change.path)
  const child = relative(root, absolute)
  if (child === '' || isAbsolute(child) || child === '..' || child.startsWith(`..${sep}`)) return null
  return { path: child.split(sep).join('/'), kind: change.kind }
}

function activityLabel(item) {
  if (item.type === 'commandExecution' && typeof item.command === 'string') {
    return `Command · ${item.command.slice(0, 160)}`
  }
  if (item.type === 'fileChange') {
    const count = Array.isArray(item.changes) ? item.changes.length : 0
    return count === 1 ? '1 file changed' : `${count} files changed`
  }
  if (item.type === 'mcpToolCall' && typeof item.tool === 'string') {
    return `${item.server || 'MCP'} · ${item.tool}`.slice(0, 180)
  }
  if (item.type === 'webSearch') return 'Web search'
  if (item.type === 'imageView') return 'View image'
  return null
}

function activityState(item) {
  if (item.status === 'failed' || item.status === 'declined') return 'failed'
  return 'completed'
}

function safeEmit(emit, event) {
  try { emit(event) } catch {}
}

function sessionError(code) {
  return Object.assign(new Error(code), { code })
}
