import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

import { createJournalEventClient } from './journal-client.mjs'

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

async function journalOptions(env) {
  const dataDirectory = join(homedir(), '.config', 'tasks-recorder')
  let config = {}
  try {
    config = JSON.parse(await readFile(join(dataDirectory, 'config.json'), 'utf8'))
  } catch {
    // Environment overrides and defaults keep lifecycle delivery fail-open before install.
  }
  const configuredSpool = config.spool_dir ?? 'spool'
  return {
    baseUrl: await resolveServerBaseUrl(env),
    spoolDirectory: isAbsolute(configuredSpool)
      ? configuredSpool
      : join(dataDirectory, configuredSpool),
    spoolOptions: {
      maxBytes: config.spool_max_bytes ?? 4 * 1024 * 1024,
      maxFiles: config.spool_max_files ?? 512,
      maxAgeMs: config.spool_max_age_ms ?? 7 * 24 * 60 * 60 * 1000,
    },
  }
}

export async function sendJournalEvent(envelope, env = process.env) {
  try {
    const client = createJournalEventClient(await journalOptions(env))
    return client.deliver(envelope)
  } catch {
    return {
      ok: true,
      delivered: false,
      spooled: false,
      dropped: true,
      error_code: 'JOURNAL_CLIENT_UNAVAILABLE',
    }
  }
}
