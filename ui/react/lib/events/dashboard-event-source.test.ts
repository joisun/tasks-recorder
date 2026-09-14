import { QueryClient } from '@tanstack/react-query'
import { afterEach, expect, test, vi } from 'vitest'

import { DashboardEventSource } from './dashboard-event-source'
import { queryKeys } from '../query/keys'

class FakeEventSource {
  readonly listeners = new Map<string, Set<EventListener>>()
  close = vi.fn()

  addEventListener(type: string, listener: EventListener) {
    const listeners = this.listeners.get(type) ?? new Set<EventListener>()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }

  removeEventListener(type: string, listener: EventListener) {
    this.listeners.get(type)?.delete(listener)
  }

  emit(type: string) {
    for (const listener of this.listeners.get(type) ?? []) listener(new Event(type))
  }
}

afterEach(() => vi.useRealTimers())

test('one changed revision invalidates the server-backed dashboard queries', () => {
  const queryClient = new QueryClient()
  const invalidate = vi.spyOn(queryClient, 'invalidateQueries').mockResolvedValue()
  const source = new FakeEventSource()
  const events = new DashboardEventSource({
    queryClient,
    createEventSource: () => source,
  })

  events.start()
  source.emit('changed')

  expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.snapshot })
  expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.tasks })
  expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.executions })
  expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.schedules })
  expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.allRuns, predicate: expect.any(Function) })
})

test('continuous changed revisions are coalesced into one refresh per interval', () => {
  vi.useFakeTimers()
  const queryClient = new QueryClient()
  const invalidate = vi.spyOn(queryClient, 'invalidateQueries').mockResolvedValue()
  const source = new FakeEventSource()
  const events = new DashboardEventSource({
    queryClient,
    createEventSource: () => source,
    refreshIntervalMs: 2_000,
  })

  events.start()
  source.emit('changed')
  source.emit('changed')
  source.emit('changed')

  expect(invalidate).toHaveBeenCalledTimes(5)
  vi.advanceTimersByTime(1_999)
  expect(invalidate).toHaveBeenCalledTimes(5)
  vi.advanceTimersByTime(1)
  expect(invalidate).toHaveBeenCalledTimes(10)
})

test('connection state follows the native stream and close removes every listener', () => {
  const source = new FakeEventSource()
  const onStateChange = vi.fn()
  const events = new DashboardEventSource({
    queryClient: new QueryClient(),
    createEventSource: () => source,
    onStateChange,
  })

  events.start()
  source.emit('open')
  source.emit('error')
  events.close()
  source.emit('open')

  expect(onStateChange.mock.calls.map(([state]) => state)).toEqual([
    'connecting', 'open', 'connecting', 'closed',
  ])
  expect(source.close).toHaveBeenCalledOnce()
  expect([...source.listeners.values()].every((listeners) => listeners.size === 0)).toBe(true)
})


test('reconnecting refreshes missed schedule changes without repeatedly reloading terminal conversations', () => {
  const client = new QueryClient()
  const invalidate = vi.spyOn(client, 'invalidateQueries').mockResolvedValue()
  const source = new FakeEventSource()
  const events = new DashboardEventSource({ queryClient: client, createEventSource: () => source, refreshIntervalMs: 0 })
  events.start()
  source.emit('open')
  invalidate.mockClear()
  source.emit('error')
  source.emit('open')
  expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.schedules })
  const filter = invalidate.mock.calls.find(([options]) => options?.queryKey === queryKeys.allRuns)?.[0]
  expect(filter?.predicate?.({ queryKey: queryKeys.run('a') } as never)).toBe(true)
  expect(filter?.predicate?.({ queryKey: queryKeys.runConversation('a') } as never)).toBe(false)
  events.close()
})
