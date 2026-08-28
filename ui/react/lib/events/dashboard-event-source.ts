import type { QueryClient } from '@tanstack/react-query'

import { queryKeys } from '../query/keys'

export type DashboardConnectionState = 'connecting' | 'open' | 'closed'

export interface EventSourceLike {
  addEventListener(type: string, listener: EventListener): void
  removeEventListener(type: string, listener: EventListener): void
  close(): void
}

export type EventSourceFactory = (url: string) => EventSourceLike

export class DashboardEventSource {
  readonly #queryClient: QueryClient
  readonly #createEventSource: EventSourceFactory
  readonly #onStateChange: (state: DashboardConnectionState) => void
  #source: EventSourceLike | null = null
  #listeners: Array<[string, EventListener]> = []

  constructor({
    queryClient,
    createEventSource = (url) => new EventSource(url),
    onStateChange = () => undefined,
  }: {
    queryClient: QueryClient
    createEventSource?: EventSourceFactory
    onStateChange?: (state: DashboardConnectionState) => void
  }) {
    this.#queryClient = queryClient
    this.#createEventSource = createEventSource
    this.#onStateChange = onStateChange
  }

  start() {
    if (this.#source) return
    this.#onStateChange('connecting')
    const source = this.#createEventSource('/api/v1/events')
    this.#source = source

    this.#listen('open', () => this.#onStateChange('open'))
    this.#listen('error', () => this.#onStateChange('connecting'))
    this.#listen('changed', () => {
      void this.#queryClient.invalidateQueries({ queryKey: queryKeys.snapshot })
      void this.#queryClient.invalidateQueries({ queryKey: queryKeys.tasks })
      void this.#queryClient.invalidateQueries({ queryKey: queryKeys.executions })
    })
  }

  close() {
    if (!this.#source) return
    for (const [type, listener] of this.#listeners) {
      this.#source.removeEventListener(type, listener)
    }
    this.#listeners = []
    this.#source.close()
    this.#source = null
    this.#onStateChange('closed')
  }

  #listen(type: string, listener: EventListener) {
    if (!this.#source) return
    this.#source.addEventListener(type, listener)
    this.#listeners.push([type, listener])
  }
}
