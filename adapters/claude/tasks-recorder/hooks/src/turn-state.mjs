import { createHash } from 'node:crypto'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

function requiredSessionId(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError('session_id must be a non-empty string')
  }
  return value.trim()
}

function paths(sessionId) {
  const directory = join(homedir(), '.config', 'tasks-recorder', 'adapter-state', 'claude')
  const name = createHash('sha256').update(requiredSessionId(sessionId)).digest('hex')
  return { directory, path: join(directory, `${name}.json`) }
}

async function readState(path) {
  try {
    const value = JSON.parse(await readFile(path, 'utf8'))
    if (!Number.isSafeInteger(value.counter) || value.counter < 0) return null
    if (value.turn_key !== null && typeof value.turn_key !== 'string') return null
    return value
  } catch {
    return null
  }
}

async function writeState(sessionId, state) {
  const target = paths(sessionId)
  await mkdir(target.directory, { recursive: true, mode: 0o700 })
  await chmod(target.directory, 0o700)
  const temporary = `${target.path}.${process.pid}.tmp`
  await writeFile(temporary, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 })
  await chmod(temporary, 0o600)
  await rename(temporary, target.path)
  await chmod(target.path, 0o600)
  return state
}

export async function initializeTurnState(sessionId) {
  return writeState(sessionId, { counter: 0, turn_key: null })
}

export async function startTurn(sessionId) {
  const target = paths(sessionId)
  const current = await readState(target.path) ?? { counter: 0, turn_key: null }
  const counter = current.counter + 1
  return writeState(sessionId, { counter, turn_key: `turn-${counter}` })
}

export async function currentTurn(sessionId) {
  const target = paths(sessionId)
  return readState(target.path)
}

export async function clearTurnState(sessionId) {
  await rm(paths(sessionId).path, { force: true })
}
