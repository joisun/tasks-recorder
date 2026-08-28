import { realpath, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'

import { isCodexModelSlug, isCodexReasoningLevel } from './codex-model-selection.mjs'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const ETAG = /^[0-9a-f]{64}$/
const SANDBOXES = new Set(['read-only', 'workspace-write', 'danger-full-access'])
const SPEC_KEYS = new Set(['job_id', 'definition_etag', 'title', 'prompt', 'workspace', 'cadence', 'timezone_mode', 'thread_mode', 'sandbox_mode', 'model', 'reasoning_effort', 'timeout_seconds'])

function fail() { return Object.assign(new Error('CODEX_INVOCATION_INVALID'), { code: 'CODEX_INVOCATION_INVALID' }) }
function string(value, max) { return typeof value === 'string' && value.length > 0 && value.length <= max }
function object(value) { return value && typeof value === 'object' && !Array.isArray(value) }
function validCadence(value) {
  if (!object(value) || value.timezone_mode !== 'system' || !['once', 'hourly', 'daily', 'weekly', 'monthly'].includes(value.kind)) return false
  const integer = (item, min, max) => Number.isInteger(item) && item >= min && item <= max
  if (value.kind === 'once') return typeof value.at === 'string' && Number.isFinite(Date.parse(value.at))
  if (value.kind === 'hourly') return integer(value.minute, 0, 59)
  if (!integer(value.hour, 0, 23) || !integer(value.minute, 0, 59)) return false
  if (value.kind === 'daily') return true
  if (value.kind === 'weekly') return Array.isArray(value.weekdays) && value.weekdays.length > 0 && value.weekdays.every((day) => integer(day, 1, 7))
  return integer(value.day, 1, 31)
}
async function canonicalFile(value) {
  if (!string(value, 4096) || !isAbsolute(value)) throw fail()
  try {
    const path = await realpath(value); const metadata = await stat(path)
    if (!isAbsolute(path) || !metadata.isFile() || (metadata.mode & 0o111) === 0) throw fail()
    return path
  } catch (error) { throw error?.code === 'CODEX_INVOCATION_INVALID' ? error : fail() }
}
async function canonicalDirectory(value) {
  if (!string(value, 4096) || !isAbsolute(value)) throw fail()
  try {
    const path = await realpath(value)
    if (!isAbsolute(path) || !(await stat(path)).isDirectory()) throw fail()
    return path
  } catch (error) { throw error?.code === 'CODEX_INVOCATION_INVALID' ? error : fail() }
}
function validateSnapshot(spec) {
  if (!object(spec) || Object.keys(spec).length !== SPEC_KEYS.size || Object.keys(spec).some((key) => !SPEC_KEYS.has(key))) throw fail()
  if (!string(spec.job_id, 36) || !UUID.test(spec.job_id) || !string(spec.definition_etag, 64) || !ETAG.test(spec.definition_etag)
    || !string(spec.title, 512) || !string(spec.prompt, 64 * 1024) || !validCadence(spec.cadence)
    || spec.timezone_mode !== 'system' || spec.thread_mode !== 'new' || !SANDBOXES.has(spec.sandbox_mode)
    || !Number.isSafeInteger(spec.timeout_seconds) || spec.timeout_seconds < 60 || spec.timeout_seconds > 86400) throw fail()
  if (spec.model !== null && (!string(spec.model, 128) || !isCodexModelSlug(spec.model))) throw fail()
  if (spec.reasoning_effort !== null && (!string(spec.reasoning_effort, 16) || !isCodexReasoningLevel(spec.reasoning_effort))) throw fail()
}

export async function buildCodexInvocation(claimedSpec, { codexPath } = {}) {
  validateSnapshot(claimedSpec)
  const [command, cwd] = await Promise.all([canonicalFile(codexPath), canonicalDirectory(claimedSpec.workspace)])
  const args = [
    'exec', '--json', '--color', 'never', '--skip-git-repo-check',
    '--sandbox', claimedSpec.sandbox_mode, '--cd', cwd,
    '-c', 'approval_policy="never"',
  ]
  if (claimedSpec.model !== null) args.push('--model', claimedSpec.model)
  if (claimedSpec.reasoning_effort !== null) args.push('-c', `model_reasoning_effort="${claimedSpec.reasoning_effort}"`)
  args.push('-')
  return Object.freeze({ command, args: Object.freeze(args), cwd, stdin: claimedSpec.prompt, timeout_ms: claimedSpec.timeout_seconds * 1000 })
}
