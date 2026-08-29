import { useEffect, useRef, useState } from 'react'

import { DashboardApiError, type DashboardApi } from '@/lib/api/dashboard-api'
import type { RunEvent, RunRecord, RunStatus } from '@/lib/api/types'

const ACTIVE_STATUSES = new Set<RunStatus>(['queued', 'claimed', 'running'])
const TERMINAL_STATUSES = new Set<RunStatus>([
  'succeeded',
  'failed',
  'timed_out',
  'skipped_overlap',
  'canceled',
  'lost',
  'interrupted',
])
const MAXIMUM_MESSAGE_CHARACTERS = 64 * 1024

export type LiveConnection = 'idle' | 'connecting' | 'connected' | 'disconnected' | 'unavailable' | 'closed'

export type LiveEntry =
  | { kind: 'message'; itemId: string; text: string }
  | { kind: 'activity'; itemId: string; label: string; state: string }

export interface LiveRunState {
  connection: LiveConnection
  turnRevision: number | null
  entries: LiveEntry[]
  sessionId: string | null
  resetNotice: string
  draft: string
  submitting: boolean
  stopping: boolean
  controlError: string
}

interface RunEventSource {
  addEventListener(type: string, listener: EventListener): void
  close(): void
}

export type RunEventSourceFactory = (url: string) => RunEventSource

function initialState(run: RunRecord): LiveRunState {
  return {
    connection: 'idle',
    turnRevision: Number.isSafeInteger(run.turn_revision) ? run.turn_revision : null,
    entries: [],
    sessionId: run.thread_id,
    resetNotice: '',
    draft: '',
    submitting: false,
    stopping: false,
    controlError: '',
  }
}

function stringPayload(payload: Record<string, unknown>, key: string) {
  return typeof payload[key] === 'string' ? payload[key] as string : null
}

export function applyLiveRunEvent(state: LiveRunState, event: RunEvent): LiveRunState {
  const payload = event.payload ?? {}
  if (event.type === 'turn_started') {
    const revision = payload.turn_revision
    if (!Number.isSafeInteger(revision) || Number(revision) < 1) return state
    return { ...state, turnRevision: Number(revision), controlError: '' }
  }
  if (event.type === 'session') {
    const sessionId = stringPayload(payload, 'session_id')
    return sessionId ? { ...state, sessionId } : state
  }
  if (event.type === 'assistant_delta') {
    const itemId = stringPayload(payload, 'item_id')
    const delta = stringPayload(payload, 'delta')
    if (!itemId || delta === null) return state
    const index = state.entries.findIndex((entry) => entry.kind === 'message' && entry.itemId === itemId)
    if (index < 0) {
      return {
        ...state,
        entries: [...state.entries, {
          kind: 'message',
          itemId,
          text: delta.slice(-MAXIMUM_MESSAGE_CHARACTERS),
        }],
      }
    }
    const current = state.entries[index]
    if (current.kind !== 'message') return state
    const entries = [...state.entries]
    entries[index] = {
      ...current,
      text: `${current.text}${delta}`.slice(-MAXIMUM_MESSAGE_CHARACTERS),
    }
    return { ...state, entries }
  }
  if (event.type === 'activity_started' || event.type === 'activity_completed') {
    const itemId = stringPayload(payload, 'item_id')
    if (!itemId) return state
    const label = stringPayload(payload, 'label') ?? 'Agent activity'
    const nextState = event.type === 'activity_completed'
      ? stringPayload(payload, 'state') ?? 'completed'
      : 'running'
    const index = state.entries.findIndex((entry) => entry.kind === 'activity' && entry.itemId === itemId)
    if (index < 0) {
      return { ...state, entries: [...state.entries, { kind: 'activity', itemId, label, state: nextState }] }
    }
    const current = state.entries[index]
    if (current.kind !== 'activity') return state
    const entries = [...state.entries]
    entries[index] = { ...current, label, state: nextState }
    return { ...state, entries }
  }
  if (event.type === 'intervention_accepted') return { ...state, controlError: '' }
  return state
}

function controlError(error: unknown) {
  if (error instanceof DashboardApiError) {
    if (error.code === 'TURN_CHANGED') return '当前 Turn 已变化，请基于最新消息重新发送。'
    if (error.code === 'TURN_NOT_STEERABLE') return 'Agent 当前阶段暂不接受追加指令，请稍后重试。'
    if (error.code === 'RUN_NOT_ACTIVE') return '这个 Run 已结束，请使用 Terminal Resume。'
    if (error.code === 'RUNTIME_PROTOCOL_UNAVAILABLE') return '当前 Runtime 不支持 Live Session protocol。'
  }
  return error instanceof Error ? error.message : '操作失败，请重试。'
}

function isRunEvent(value: unknown): value is RunEvent {
  if (!value || typeof value !== 'object') return false
  const event = value as Partial<RunEvent>
  return typeof event.runId === 'string'
    && Number.isSafeInteger(event.sequence)
    && typeof event.type === 'string'
    && Boolean(event.payload && typeof event.payload === 'object')
}

export function useLiveRun({
  run,
  api,
  onTerminal,
  createSource,
  retryMs = 1_000,
}: {
  run: RunRecord
  api: DashboardApi
  onTerminal?: (status: RunStatus) => void
  createSource?: RunEventSourceFactory
  retryMs?: number
}) {
  const [state, setState] = useState(() => initialState(run))
  const terminalHandler = useRef(onTerminal)
  terminalHandler.current = onTerminal
  const active = run.interactive && ACTIVE_STATUSES.has(run.status)

  useEffect(() => {
    setState(initialState(run))
  }, [run.id])

  useEffect(() => {
    if (!Number.isSafeInteger(run.turn_revision)) return
    setState((current) => current.turnRevision === null
      ? { ...current, turnRevision: run.turn_revision }
      : current)
  }, [run.turn_revision])

  useEffect(() => {
    if (!active) {
      setState((current) => ({ ...current, connection: 'closed' }))
      return undefined
    }
    const factory = createSource ?? (
      typeof EventSource === 'function'
        ? (url: string) => new EventSource(url) as RunEventSource
        : null
    )
    if (!factory) {
      setState((current) => ({ ...current, connection: 'unavailable' }))
      return undefined
    }

    let source: RunEventSource | null = null
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    let latestSequence = 0
    let stopped = false

    const closeSource = () => {
      source?.close()
      source = null
    }

    const connect = () => {
      if (stopped || source) return
      setState((current) => ({ ...current, connection: 'connecting' }))
      const after = latestSequence > 0 ? `?after=${latestSequence}` : ''
      const current = factory(`/api/v1/runs/${encodeURIComponent(run.id)}/events${after}`)
      source = current
      current.addEventListener('open', () => {
        if (source === current && !stopped) {
          setState((value) => ({ ...value, connection: 'connected' }))
        }
      })
      current.addEventListener('reset', ((message: MessageEvent<string>) => {
        if (source !== current || stopped) return
        try {
          const payload = JSON.parse(message.data) as { run_id?: unknown }
          if (payload.run_id !== run.id) return
        } catch {
          return
        }
        setState((value) => ({
          ...value,
          entries: [],
          resetNotice: '较早的实时消息已过期；终态摘要与日志不受影响。',
        }))
      }) as EventListener)
      current.addEventListener('run', ((message: MessageEvent<string>) => {
        if (source !== current || stopped) return
        let event: unknown
        try { event = JSON.parse(message.data) } catch { return }
        if (!isRunEvent(event) || event.runId !== run.id) return
        const sequence = Number(message.lastEventId || event.sequence)
        if (!Number.isSafeInteger(sequence) || sequence <= latestSequence || event.sequence !== sequence) return
        latestSequence = sequence
        setState((value) => applyLiveRunEvent(value, event))
        if (event.type !== 'status') return
        const status = stringPayload(event.payload, 'state') as RunStatus | null
        if (!status || !TERMINAL_STATUSES.has(status)) return
        stopped = true
        closeSource()
        setState((value) => ({ ...value, connection: 'closed', stopping: false }))
        terminalHandler.current?.(status)
      }) as EventListener)
      current.addEventListener('error', () => {
        if (source !== current || stopped) return
        closeSource()
        setState((value) => ({ ...value, connection: 'disconnected' }))
        retryTimer = setTimeout(() => {
          retryTimer = null
          connect()
        }, retryMs)
      })
    }

    connect()
    return () => {
      stopped = true
      if (retryTimer !== null) clearTimeout(retryTimer)
      closeSource()
    }
  }, [active, createSource, retryMs, run.id])

  const setDraft = (draft: string) => setState((current) => ({ ...current, draft }))

  async function steer() {
    const text = state.draft.trim()
    if (!active || state.connection !== 'connected' || !state.turnRevision
      || !text || state.submitting) return
    setState((current) => ({ ...current, submitting: true, controlError: '' }))
    try {
      await api.steerRun(run.id, { expected_turn_revision: state.turnRevision, text })
      setState((current) => ({ ...current, draft: '', submitting: false }))
    } catch (error) {
      setState((current) => ({ ...current, submitting: false, controlError: controlError(error) }))
    }
  }

  async function stop() {
    if (!active || !state.turnRevision || state.stopping) return
    setState((current) => ({ ...current, stopping: true, controlError: '' }))
    try {
      await api.stopRun(run.id, { expected_turn_revision: state.turnRevision })
    } catch (error) {
      setState((current) => ({ ...current, stopping: false, controlError: controlError(error) }))
    }
  }

  return {
    ...state,
    active,
    canSteer: active && state.connection === 'connected' && Boolean(state.turnRevision)
      && Boolean(state.draft.trim()) && !state.submitting,
    canStop: active && Boolean(state.turnRevision) && !state.stopping,
    setDraft,
    steer,
    stop,
  }
}
