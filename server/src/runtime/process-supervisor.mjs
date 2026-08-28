import { spawn } from 'node:child_process'

import { createRuntimeEnvironment } from './runtime-environment.mjs'

const DEFAULT_FORCE_KILL_MS = 2_000
const DEFAULT_MAXIMUM_LINE_BYTES = 256 * 1024

export function createProcessSupervisor({
  spawnImpl = spawn,
  processEnvironment = process.env,
  runtimeEnvironment = createRuntimeEnvironment({ env: processEnvironment }),
  clock = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  forceKillAfterMs = DEFAULT_FORCE_KILL_MS,
  maximumLineBytes = DEFAULT_MAXIMUM_LINE_BYTES,
} = {}) {
  if (typeof spawnImpl !== 'function' || typeof clock !== 'function'
    || typeof setTimer !== 'function' || typeof clearTimer !== 'function') {
    throw new TypeError('process supervisor dependencies are invalid')
  }
  positive(forceKillAfterMs, 'forceKillAfterMs')
  positive(maximumLineBytes, 'maximumLineBytes')

  return Object.freeze({
    start({
      invocation,
      parseEvent,
      emit,
      onSpawn,
      signal,
      logs = null,
    } = {}) {
      validateStart({ invocation, parseEvent, emit, onSpawn, signal, logs })
      return supervise({
        invocation,
        parseEvent,
        emit,
        onSpawn,
        signal,
        logs,
        spawnImpl,
        runtimeEnvironment,
        clock,
        setTimer,
        clearTimer,
        forceKillAfterMs,
        maximumLineBytes,
      })
    },
  })
}

function supervise({
  invocation,
  parseEvent,
  emit,
  onSpawn,
  signal,
  logs,
  spawnImpl,
  runtimeEnvironment,
  clock,
  setTimer,
  clearTimer,
  forceKillAfterMs,
  maximumLineBytes,
}) {
  const startedAt = clockMilliseconds(clock)
  if (signal.aborted) {
    return Promise.resolve(processResult({
      status: 'canceled',
      errorCode: 'RUN_CANCELED',
      startedAt,
      clock,
    }))
  }

  return new Promise((resolve) => {
    let child
    try {
      child = spawnImpl(invocation.command, [...invocation.args], {
        cwd: invocation.cwd,
        env: runtimeEnvironment.childEnvironment(invocation.env),
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch {
      Promise.resolve(logs?.close?.())
        .catch(() => undefined)
        .then(() => resolve(processResult({
          status: 'failed',
          errorCode: 'RUNTIME_SPAWN_FAILED',
          startedAt,
          clock,
        })))
      return
    }

    let settled = false
    let timeoutTimer = null
    let forceTimer = null
    let desiredStatus = null
    let desiredErrorCode = null
    let sessionId = null
    let finalMessage = null
    let usage = null
    const fileChanges = new Map()
    const logWrites = new Set()
    let logFailure = false

    const finish = async ({ status, errorCode = null, exitCode = null }) => {
      if (settled) return
      settled = true
      clearTimer(timeoutTimer)
      clearTimer(forceTimer)
      signal.removeEventListener('abort', abort)
      try {
        await drainLogWrites()
        await logs?.close?.()
      } catch {
        logFailure = true
      }
      resolve(processResult({
        status: logFailure ? 'failed' : status,
        errorCode: logFailure ? 'RUN_LOG_WRITE_FAILED' : errorCode,
        exitCode,
        startedAt,
        clock,
        sessionId,
        finalMessage,
        usage,
        fileChanges: [...fileChanges.values()],
      }))
    }

    const terminate = (status, errorCode) => {
      if (settled || desiredStatus !== null) return
      desiredStatus = status
      desiredErrorCode = errorCode
      try { child.kill('SIGINT') } catch {}
      forceTimer = setTimer(() => {
        if (settled) return
        try { child.kill('SIGKILL') } catch {}
        finish({ status: desiredStatus, errorCode: desiredErrorCode })
      }, forceKillAfterMs)
      forceTimer?.unref?.()
    }

    const abort = () => terminate('canceled', 'RUN_CANCELED')
    signal.addEventListener('abort', abort, { once: true })

    const consume = createLineConsumer({
      maximumLineBytes,
      onLine(line) {
        let events
        try {
          events = parseEvent(line)
        } catch {
          return
        }
        if (!Array.isArray(events)) return
        for (const event of events) {
          collectEvent(event, {
            emit,
            setSessionId: (value) => { sessionId = value },
            setFinalMessage: (value) => { finalMessage = value },
            setUsage: (value) => { usage = value },
            fileChanges,
          })
        }
      },
    })

    child.once('spawn', () => {
      if (settled) return
      if (!Number.isSafeInteger(child.pid) || child.pid < 1) {
        finish({ status: 'failed', errorCode: 'RUNTIME_PROCESS_PID_INVALID' })
        return
      }
      try {
        onSpawn({ pid: child.pid })
      } catch {
        terminate('failed', 'RUN_START_PERSIST_FAILED')
        return
      }
      try {
        child.stdin.end(invocation.stdin ?? '')
      } catch {
        terminate('failed', 'RUNTIME_STDIN_FAILED')
      }
    })
    child.once('error', () => {
      finish({ status: 'failed', errorCode: 'RUNTIME_SPAWN_FAILED' })
    })
    child.once('close', (code, closeSignal) => {
      consume.finish()
      if (desiredStatus !== null) {
        finish({
          status: desiredStatus,
          errorCode: desiredErrorCode,
          exitCode: Number.isInteger(code) ? code : null,
        })
        return
      }
      const succeeded = code === 0 && !closeSignal
      finish({
        status: succeeded ? 'succeeded' : 'failed',
        errorCode: succeeded ? null : 'RUNTIME_PROCESS_FAILED',
        exitCode: Number.isInteger(code) ? code : null,
      })
    })
    child.stdout?.on('data', (chunk) => {
      consume.write(chunk)
      queueLogWrite(logs?.writeStdout, chunk)
    })
    if (logs?.writeStderr) {
      child.stderr?.on('data', (chunk) => {
        queueLogWrite(logs.writeStderr, chunk)
      })
    } else {
      child.stderr?.resume?.()
    }
    child.stdin?.once?.('error', (error) => {
      if (error?.code !== 'EPIPE') terminate('failed', 'RUNTIME_STDIN_FAILED')
    })

    timeoutTimer = setTimer(
      () => terminate('timed_out', 'RUNTIME_TIMEOUT'),
      invocation.timeout_ms,
    )
    timeoutTimer?.unref?.()

    function queueLogWrite(writer, chunk) {
      if (typeof writer !== 'function') return
      let write
      try {
        write = Promise.resolve(writer(chunk))
      } catch {
        logFailure = true
        return
      }
      logWrites.add(write)
      write.catch(() => { logFailure = true }).finally(() => logWrites.delete(write))
    }

    async function drainLogWrites() {
      while (logWrites.size > 0) await Promise.allSettled([...logWrites])
    }
  })
}

function createLineConsumer({ maximumLineBytes, onLine }) {
  let pending = Buffer.alloc(0)
  let discarding = false

  function write(chunk) {
    const source = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    let offset = 0
    while (offset < source.byteLength) {
      const newline = source.indexOf(0x0a, offset)
      if (discarding) {
        if (newline === -1) return
        discarding = false
        offset = newline + 1
        continue
      }
      const piece = newline === -1
        ? source.subarray(offset)
        : source.subarray(offset, newline)
      if (pending.byteLength + piece.byteLength > maximumLineBytes) {
        pending = Buffer.alloc(0)
        if (newline === -1) {
          discarding = true
          return
        }
      } else if (newline === -1) {
        pending = pending.byteLength === 0
          ? Buffer.from(piece)
          : Buffer.concat([pending, piece])
        return
      } else {
        const line = pending.byteLength === 0
          ? piece
          : Buffer.concat([pending, piece])
        pending = Buffer.alloc(0)
        onLine(line.toString('utf8'))
      }
      offset = newline + 1
    }
  }

  function finish() {
    if (!discarding && pending.byteLength > 0) onLine(pending.toString('utf8'))
    pending = Buffer.alloc(0)
  }

  return { write, finish }
}

function collectEvent(event, state) {
  if (!event || typeof event !== 'object') return
  try { state.emit(event) } catch {}
  if (event.type === 'session' && typeof event.payload?.session_id === 'string') {
    state.setSessionId(event.payload.session_id)
  }
  if (event.type === 'text_delta' && typeof event.payload?.text === 'string') {
    state.setFinalMessage(event.payload.text)
  }
  if (event.type === 'usage' && event.payload && typeof event.payload === 'object') {
    state.setUsage(event.payload)
  }
  if (event.type === 'file_change' && Array.isArray(event.payload?.changes)) {
    for (const change of event.payload.changes) {
      if (typeof change?.path === 'string') state.fileChanges.set(change.path, change)
    }
  }
}

function processResult({
  status,
  errorCode,
  exitCode = null,
  startedAt,
  clock,
  sessionId = null,
  finalMessage = null,
  usage = null,
  fileChanges = [],
}) {
  return {
    status,
    exit_code: exitCode,
    error_code: errorCode,
    duration_ms: Math.max(0, clockMilliseconds(clock) - startedAt),
    session_id: sessionId,
    final_message: finalMessage,
    usage,
    file_changes: fileChanges,
  }
}

function validateStart({ invocation, parseEvent, emit, onSpawn, signal, logs }) {
  if (!invocation || typeof invocation !== 'object'
    || typeof invocation.command !== 'string' || invocation.command.length === 0
    || !Array.isArray(invocation.args)
    || invocation.args.some((value) => typeof value !== 'string')
    || typeof invocation.cwd !== 'string' || invocation.cwd.length === 0
    || !Number.isSafeInteger(invocation.timeout_ms) || invocation.timeout_ms < 1
    || typeof parseEvent !== 'function' || typeof emit !== 'function'
    || typeof onSpawn !== 'function' || !signal?.addEventListener
    || (logs !== null && (typeof logs?.writeStdout !== 'function'
      || typeof logs?.writeStderr !== 'function' || typeof logs?.close !== 'function'))) {
    throw new TypeError('process supervisor start options are invalid')
  }
}

function clockMilliseconds(clock) {
  const value = clock()
  const milliseconds = value instanceof Date ? value.getTime() : Number(value)
  if (!Number.isFinite(milliseconds)) throw new TypeError('clock is invalid')
  return milliseconds
}

function positive(value, field) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${field} must be a positive integer`)
  }
}
