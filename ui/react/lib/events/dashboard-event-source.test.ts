import { QueryClient } from '@tanstack/react-query'
import { expect, test, vi } from 'vitest'

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
