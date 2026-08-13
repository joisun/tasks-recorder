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

export async function sendHeartbeat(input, env = process.env) {
  const response = await fetch(`${await resolveServerBaseUrl(env)}/api/v1/heartbeat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(1_500),
  })
  if (!response.ok) throw new Error(`tasks-recorder heartbeat failed with HTTP ${response.status}`)
}
