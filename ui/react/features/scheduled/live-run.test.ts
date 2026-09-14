import { act, renderHook, waitFor } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import type { DashboardApi } from '@/lib/api/dashboard-api'
import type { RunRecord } from '@/lib/api/types'
import { useLiveRun } from './live-run'

class Source {
  listeners = new Map<string, EventListener[]>()
  close = vi.fn()
  addEventListener(type: string, listener: EventListener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }
  emit(type: string, sequence = 0, payload = {}) {
    const event = new MessageEvent(type, { data: JSON.stringify({ runId: 'run-a', sequence, type: 'assistant_delta', payload }), lastEventId: String(sequence) })
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }
}
const run = { id: 'run-a', status: 'running', interactive: true, turn_revision: 1, thread_id: 'thread-a' } as RunRecord
function mount(overrides: Partial<DashboardApi> = {}, onTerminal = vi.fn()) {
  const sources: Source[] = []
  const urls: string[] = []
  const api = { scheduledRun: vi.fn(async () => ({ run })), ...overrides } as unknown as DashboardApi
  const createSource = (url: string) => { urls.push(url); const source = new Source(); sources.push(source); return source }
  const hook = renderHook(() => useLiveRun({ run, api, createSource, onTerminal }))
  return { ...hook, sources, urls, onTerminal }
}

test('manual reconnect resumes from the last sequence without losing draft or duplicating messages', () => {
  const { result, sources, urls } = mount()
  act(() => {
    sources[0].emit('open')
    sources[0].emit('run', 1, { item_id: 'a', delta: 'Hello' })
    result.current.setDraft('new guidance')
  })
  act(() => result.current.reconnect())
  expect(sources[0].close).toHaveBeenCalledOnce()
  expect(urls[1]).toBe('/api/v1/runs/run-a/events?after=1')
  act(() => { sources[1].emit('open'); sources[1].emit('run', 1, { item_id: 'a', delta: 'Hello' }) })
  expect(result.current.entries).toHaveLength(1)
  expect(result.current.draft).toBe('new guidance')
})

test('a lost terminal event is recovered by reading authoritative Run state', async () => {
  const { result, sources, onTerminal } = mount({ scheduledRun: vi.fn(async () => ({ run: { ...run, status: 'succeeded' as const } })) })
  act(() => sources[0].emit('error'))
  await waitFor(() => expect(result.current.connection).toBe('closed'))
  expect(onTerminal).toHaveBeenCalledWith('succeeded')
})

test('successful send preserves text typed while the request was in flight', async () => {
  let resolve!: (value: never) => void
  const { result, sources } = mount({ steerRun: vi.fn(() => new Promise<never>((done) => { resolve = done })) })
  act(() => { sources[0].emit('open'); result.current.setDraft('first') })
  let pending!: Promise<void>
  act(() => { pending = result.current.steer() })
  act(() => result.current.setDraft('second'))
  await act(async () => { resolve({} as never); await pending })
  expect(result.current.draft).toBe('second')
  expect(result.current.submitting).toBe(false)
})
