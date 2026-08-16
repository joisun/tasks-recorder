import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

function requireLocalOrigin(value) {
  const url = new URL(value)
  if (
    url.protocol !== 'http:'
    || url.hostname !== '127.0.0.1'
    || url.username !== ''
    || url.password !== ''
    || !['', '/'].includes(url.pathname)
    || url.search !== ''
    || url.hash !== ''
  ) {
    throw new Error('tasks-recorder service URL must be an http://127.0.0.1 origin')
  }
  return url.origin
}

async function resolveServerBaseUrl(env = process.env) {
  if (env.AGENT_TASKS_SERVER_URL) return requireLocalOrigin(env.AGENT_TASKS_SERVER_URL)
  const config = JSON.parse(await readFile(
    join(homedir(), '.config', 'tasks-recorder', 'config.json'),
    'utf8',
  ))
  const host = config.server_host ?? '127.0.0.1'
  const port = config.server_port ?? 43127
  if (host !== '127.0.0.1') throw new Error('tasks-recorder service must use 127.0.0.1')
  return requireLocalOrigin(`http://${host}:${port}`)
}

const LIFECYCLE_EVENTS = new Set([
  'session-start',
  'turn-start',
  'tool-use',
  'subagent-start',
  'subagent-stop',
  'session-end',
])

async function request(path, { method = 'GET', body } = {}, env = process.env) {
  const response = await fetch(`${await resolveServerBaseUrl(env)}${path}`, {
    method,
    headers: {
      Accept: 'application/json',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(1_500),
  })
  const result = await response.json().catch(() => null)
  if (!response.ok) {
    throw new Error(`tasks-recorder request failed with HTTP ${response.status}`)
  }
  if (result === null) throw new Error('tasks-recorder returned invalid JSON')
  return result
}

export async function sendLifecycle(event, input, env = process.env) {
  if (!LIFECYCLE_EVENTS.has(event)) throw new TypeError('tasks-recorder lifecycle event is invalid')
  return request(`/api/v1/lifecycle/${event}`, { method: 'POST', body: input }, env)
}

export async function fetchSessionContext(sessionId, env = process.env) {
  if (typeof sessionId !== 'string' || sessionId.trim() === '') {
    throw new TypeError('sessionId must be a non-empty string')
  }
  return request(`/api/v1/sessions/${encodeURIComponent(sessionId.trim())}/context`, {}, env)
}

export async function sendHeartbeat(input, env = process.env) {
  return request('/api/v1/heartbeat', { method: 'POST', body: input }, env)
}
