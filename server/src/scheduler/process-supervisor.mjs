import { spawn } from 'node:child_process'
import { createCodexJsonlCollector } from './codex-jsonl.mjs'

function positive(value, field) { if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${field} must be a positive safe integer`); return value }
function safeCode(value, fallback) { return /^[A-Z][A-Z0-9_]{1,95}$/.test(value?.code) ? value.code : fallback }
function validPid(value) { return Number.isSafeInteger(value) && value > 1 }
function groupKill(killImpl, pid, signal) { try { killImpl(-pid, signal); return null } catch (caught) { return caught?.code === 'ESRCH' ? null : safeCode(caught, 'RUNNER_PROCESS_KILL_FAILED') } }

export function superviseProcess({
  command, args, cwd, stdin, timeoutMs, graceMs = 5_000, logs, onHeartbeat = async () => {}, heartbeatMs = 15_000, heartbeatDeadlineMs = 5_000,
  spawnImpl = spawn, killImpl = process.kill, collector = null, signalEmitter = process,
} = {}) {
  const protocolCollector = collector ?? createCodexJsonlCollector({ workspace: cwd })
  if (typeof command !== 'string' || !Array.isArray(args) || args.some((arg) => typeof arg !== 'string') || typeof cwd !== 'string' || typeof stdin !== 'string' || !logs || typeof logs.writeStdout !== 'function' || typeof logs.writeStderr !== 'function' || typeof logs.close !== 'function' || typeof spawnImpl !== 'function' || typeof killImpl !== 'function' || typeof onHeartbeat !== 'function' || typeof protocolCollector?.write !== 'function' || typeof protocolCollector?.finish !== 'function' || !signalEmitter?.on || !signalEmitter?.off) throw new TypeError('process supervisor options are invalid')
  const timeout = positive(timeoutMs, 'timeoutMs'); const grace = positive(graceMs, 'graceMs'); const heartbeat = positive(heartbeatMs, 'heartbeatMs'); const heartbeatDeadline = positive(heartbeatDeadlineMs, 'heartbeatDeadlineMs')
  return new Promise((resolve) => {
    const started = Date.now(); let child
    try { child = spawnImpl(command, args, { cwd, shell: false, detached: true, stdio: ['pipe', 'pipe', 'pipe'] }) } catch (caught) { Promise.resolve(logs.close()).catch(() => {}).then(() => resolve({ status: 'failed', error_code: safeCode(caught, 'CODEX_SPAWN_FAILED'), thread_id: null, final_message: null, file_changes: [], exit_code: null, duration_ms: 0 })); return }
    if (!validPid(child?.pid)) { Promise.resolve(logs.close()).catch(() => {}).then(() => resolve({ status: 'failed', error_code: 'CODEX_PROCESS_PID_INVALID', thread_id: null, final_message: null, file_changes: [], exit_code: null, duration_ms: Date.now() - started })); return }
    let settled = false; let terminating = false; let desiredStatus = null; let desiredError = null; let timeoutTimer = null; let graceTimer = null; let heartbeatTimer = null; let heartbeatAbort = null; let heartbeatDeadlineTimer = null; let heartbeatBusy = false
    const listeners = new Map()
    const clean = () => { clearTimeout(timeoutTimer); clearTimeout(graceTimer); clearInterval(heartbeatTimer); clearTimeout(heartbeatDeadlineTimer); heartbeatAbort?.abort(); for (const [signal, listener] of listeners) signalEmitter.off(signal, listener) }
    const finalize = async ({ status, errorCode = null, exitCode = null, signal = null } = {}) => {
      if (settled) return; settled = true; clean(); let parsed
      try { parsed = protocolCollector.finish() } catch { parsed = { thread_id: null, final_message: null, file_changes: [] } }
      try { await logs.close() } catch { status = 'failed'; errorCode = 'RUNNER_LOG_WRITE_FAILED' }
      resolve({ status, error_code: errorCode, thread_id: parsed.thread_id ?? null, final_message: parsed.final_message ?? null, file_changes: parsed.file_changes ?? [], exit_code: Number.isInteger(exitCode) ? exitCode : null, signal: typeof signal === 'string' ? signal : null, duration_ms: Date.now() - started })
    }
    const beginTermination = (status, code) => {
      if (settled || terminating) return
      terminating = true; desiredStatus = status; desiredError = code
      if (!validPid(child.pid)) { finalize({ status: 'failed', errorCode: 'CODEX_PROCESS_PID_INVALID' }); return }
      const killError = groupKill(killImpl, child.pid, 'SIGTERM')
      if (killError) { finalize({ status: 'failed', errorCode: killError }); return }
      graceTimer = setTimeout(() => { if (!settled) { const later = groupKill(killImpl, child.pid, 'SIGKILL'); finalize({ status: later ? 'failed' : desiredStatus, errorCode: later ?? desiredError, signal: later ? null : 'SIGKILL' }) } }, grace)
      graceTimer.unref?.()
    }
    const write = (stream, writer, chunk) => {
      stream.pause?.()
      Promise.resolve(writer(chunk)).then(() => stream.resume?.(), () => { stream.resume?.(); beginTermination('failed', 'RUNNER_LOG_WRITE_FAILED') })
    }
    const runHeartbeat = () => {
      if (settled || terminating || heartbeatBusy) return
      heartbeatBusy = true; heartbeatAbort = new AbortController()
      heartbeatDeadlineTimer = setTimeout(() => heartbeatAbort?.abort(), heartbeatDeadline); heartbeatDeadlineTimer.unref?.()
      Promise.resolve(onHeartbeat({ signal: heartbeatAbort.signal, deadlineMs: heartbeatDeadline })).catch(() => {}).finally(() => { clearTimeout(heartbeatDeadlineTimer); heartbeatDeadlineTimer = null; heartbeatAbort = null; heartbeatBusy = false })
    }
    const normalClose = (exitCode, signal) => {
      if (desiredStatus !== null) return finalize({ status: desiredStatus, errorCode: desiredError, exitCode, signal })
      return finalize({ status: exitCode === 0 && !signal ? 'succeeded' : 'failed', errorCode: exitCode === 0 && !signal ? null : 'CODEX_PROCESS_FAILED', exitCode, signal })
    }
    timeoutTimer = setTimeout(() => beginTermination('timed_out', 'CODEX_TIMEOUT'), timeout); timeoutTimer.unref?.()
    heartbeatTimer = setInterval(runHeartbeat, heartbeat); heartbeatTimer.unref?.()
    for (const signal of ['SIGINT', 'SIGTERM']) { const listener = () => beginTermination('canceled', null); listeners.set(signal, listener); signalEmitter.on(signal, listener) }
    child.once('error', (caught) => finalize({ status: 'failed', errorCode: safeCode(caught, 'CODEX_SPAWN_FAILED') }))
    child.once('close', normalClose)
    child.stdout?.on('data', (chunk) => { try { protocolCollector.write(chunk) } catch { beginTermination('failed', 'CODEX_JSONL_INVALID') }; write(child.stdout, logs.writeStdout, chunk) })
    child.stderr?.on('data', (chunk) => write(child.stderr, logs.writeStderr, chunk))
    child.stdin?.once('error', (caught) => { if (caught?.code !== 'EPIPE') beginTermination('failed', 'CODEX_STDIN_FAILED') })
    try { child.stdin?.end(stdin) } catch { beginTermination('failed', 'CODEX_STDIN_FAILED') }
  })
}
