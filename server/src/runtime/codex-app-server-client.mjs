import { spawn } from 'node:child_process'

import { createRuntimeEnvironment } from './runtime-environment.mjs'

export function createCodexAppServerClient({
  executable,
  cwd,
  env = {},
  spawnImpl = spawn,
  runtimeEnvironment = createRuntimeEnvironment({ env: process.env }),
  requestTimeoutMs = 10_000,
  maximumLineBytes = 256 * 1024,
  shutdownGraceMs = 2_000,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  if (typeof executable !== 'string' || executable.length === 0
    || typeof cwd !== 'string' || cwd.length === 0
    || typeof spawnImpl !== 'function'
    || typeof runtimeEnvironment?.childEnvironment !== 'function'
    || !Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1
    || !Number.isSafeInteger(maximumLineBytes) || maximumLineBytes < 1
    || !Number.isSafeInteger(shutdownGraceMs) || shutdownGraceMs < 1
    || typeof setTimer !== 'function' || typeof clearTimer !== 'function') {
    throw new TypeError('Codex app-server client options are invalid')
  }

  const child = spawnImpl(executable, ['app-server', '--listen', 'stdio://'], {
    cwd,
    env: runtimeEnvironment.childEnvironment(env),
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const pending = new Map()
  const notificationListeners = new Set()
  let nextId = 0
  let buffer = Buffer.alloc(0)
  let isClosed = false
  let childClosed = false
  let forceKillTimer = null
  let resolveStarted
  let rejectStarted
  let startSettled = false
  const started = new Promise((resolve, reject) => {
    resolveStarted = resolve
    rejectStarted = reject
  })

  child.stdout.on('data', (chunk) => {
    if (isClosed) return
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    buffer = buffer.byteLength === 0 ? Buffer.from(bytes) : Buffer.concat([buffer, bytes])
    let newline = buffer.indexOf(0x0a)
    while (newline !== -1) {
      if (newline > maximumLineBytes) {
        terminate('RUNTIME_PROTOCOL_FRAME_TOO_LARGE')
        return
      }
      const line = buffer.subarray(0, newline).toString('utf8')
      buffer = buffer.subarray(newline + 1)
      consume(line)
      newline = buffer.indexOf(0x0a)
    }
    if (buffer.byteLength > maximumLineBytes) terminate('RUNTIME_PROTOCOL_FRAME_TOO_LARGE')
  })
  child.stderr?.resume?.()
  child.once('spawn', () => {
    if (startSettled) return
    startSettled = true
    if (!Number.isSafeInteger(child.pid) || child.pid < 1) {
      rejectStarted(protocolError('RUNTIME_PROCESS_PID_INVALID'))
      settleClosed()
      return
    }
    resolveStarted({ pid: child.pid })
  })
  child.once('error', () => {
    if (!startSettled) {
      startSettled = true
      rejectStarted(protocolError('RUNTIME_PROTOCOL_CLOSED'))
    }
    settleClosed()
  })
  child.once('close', () => {
    childClosed = true
    if (forceKillTimer !== null) clearTimer(forceKillTimer)
    forceKillTimer = null
    settleClosed()
  })

  function consume(line) {
    if (line.trim() === '') return
    let message
    try { message = JSON.parse(line) } catch { return }
    if (typeof message?.method === 'string' && !Object.hasOwn(message, 'id')) {
      const notification = Object.freeze({ method: message.method, params: message.params ?? {} })
      for (const listener of notificationListeners) {
        try { listener(notification) } catch {}
      }
      return
    }
    if (!Number.isSafeInteger(message?.id)) return
    const request = pending.get(message.id)
    if (!request) return
    pending.delete(message.id)
    clearTimer(request.timer)
    if (Object.hasOwn(message, 'error')) {
      request.reject(protocolError(protocolFailureCode(message.error)))
    } else {
      request.resolve(message.result)
    }
  }

  function notify(method, params = {}) {
    if (isClosed) throw protocolError('RUNTIME_PROTOCOL_CLOSED')
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
    } catch {
      throw protocolError('RUNTIME_PROTOCOL_CLOSED')
    }
  }

  function onNotification(listener) {
    if (typeof listener !== 'function') throw new TypeError('notification listener is required')
    notificationListeners.add(listener)
    return () => notificationListeners.delete(listener)
  }

  function request(method, params = {}) {
    if (isClosed) return Promise.reject(protocolError('RUNTIME_PROTOCOL_CLOSED'))
    const id = ++nextId
    return new Promise((resolve, reject) => {
      const timer = setTimer(() => {
        if (!pending.delete(id)) return
        reject(protocolError('RUNTIME_PROTOCOL_TIMEOUT'))
      }, requestTimeoutMs)
      timer?.unref?.()
      pending.set(id, { resolve, reject, timer })
      try {
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
      } catch {
        const current = pending.get(id)
        pending.delete(id)
        clearTimer(current?.timer)
        reject(protocolError('RUNTIME_PROTOCOL_CLOSED'))
      }
    })
  }

  function close() {
    if (isClosed) return
    settleClosed()
    interruptChild()
  }

  function terminate(code) {
    if (isClosed) return
    settleClosed(code)
    interruptChild()
  }

  function interruptChild() {
    if (childClosed) return
    try { child.kill('SIGINT') } catch {}
    forceKillTimer = setTimer(() => {
      forceKillTimer = null
      if (childClosed) return
      try { child.kill('SIGKILL') } catch {}
    }, shutdownGraceMs)
    forceKillTimer?.unref?.()
  }

  function settleClosed(errorCode = 'RUNTIME_PROTOCOL_CLOSED') {
    if (isClosed) return
    isClosed = true
    for (const request of pending.values()) {
      clearTimer(request.timer)
      request.reject(protocolError(errorCode))
    }
    pending.clear()
    notificationListeners.clear()
  }

  return Object.freeze({
    request,
    notify,
    onNotification,
    started,
    close,
    get closed() { return isClosed },
  })
}

function protocolError(code) {
  return Object.assign(new Error(code), { code })
}

function protocolFailureCode(value) {
  let serialized = ''
  try { serialized = JSON.stringify(value).slice(0, 8 * 1024) } catch {}
  return serialized.includes('activeTurnNotSteerable')
    ? 'TURN_NOT_STEERABLE'
    : 'RUNTIME_PROTOCOL_ERROR'
}
