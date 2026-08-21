import { createHash } from 'node:crypto'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

function statePath(source, sessionId) {
  if (typeof source !== 'string' || source.trim() === '') throw new TypeError('source is required')
  if (typeof sessionId !== 'string' || sessionId.trim() === '') {
    throw new TypeError('session_id is required')
  }
  const directory = join(homedir(), '.config', 'tasks-recorder', 'adapter-state', 'generic')
  const name = createHash('sha256').update(`${source}\u0000${sessionId}`).digest('hex')
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

async function writeState(source, sessionId, state) {
  const target = statePath(source, sessionId)
  await mkdir(target.directory, { recursive: true, mode: 0o700 })
  await chmod(target.directory, 0o700)
  const temporary = `${target.path}.${process.pid}.tmp`
  await writeFile(temporary, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 })
  await chmod(temporary, 0o600)
  await rename(temporary, target.path)
  await chmod(target.path, 0o600)
  return state
}

export function explicitTurn(input) {
  const value = input?.turn_id
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

export async function initializeTurnState(source, sessionId) {
  return writeState(source, sessionId, { counter: 0, turn_key: null })
}

export async function startTurn(source, sessionId) {
  const exact = statePath(source, sessionId)
  const current = await readState(exact.path) ?? { counter: 0, turn_key: null }
  const counter = current.counter + 1
  return writeState(source, sessionId, { counter, turn_key: `turn-${counter}` })
}

export async function currentTurn(source, sessionId) {
  return readState(statePath(source, sessionId).path)
}

export async function clearTurnState(source, sessionId) {
  await rm(statePath(source, sessionId).path, { force: true })
}

