import { QueryClientProvider, type QueryClient } from '@tanstack/react-query'
import {
  createContext,
  type PropsWithChildren,
  useContext,
  useEffect,
  useState,
} from 'react'

import { createDashboardApi, type DashboardApi } from '@/lib/api/dashboard-api'
import {
  DashboardEventSource,
  type DashboardConnectionState,
  type EventSourceFactory,
} from '@/lib/events/dashboard-event-source'
import { createDashboardQueryClient } from '@/lib/query/client'

const DashboardApiContext = createContext<DashboardApi | null>(null)
const DashboardConnectionContext = createContext<DashboardConnectionState>('connecting')

export function AppProviders({
  children,
  api: providedApi,
  queryClient: providedQueryClient,
  createEventSource,
}: PropsWithChildren<{
  api?: DashboardApi
  queryClient?: QueryClient
  createEventSource?: EventSourceFactory | null
}>) {
  const [api] = useState(() => providedApi ?? createDashboardApi())
  const [queryClient] = useState(() => providedQueryClient ?? createDashboardQueryClient())
  const [connectionState, setConnectionState] = useState<DashboardConnectionState>('connecting')

  useEffect(() => {
    const factory = createEventSource === undefined
      ? (typeof EventSource === 'function' ? (url: string) => new EventSource(url) : null)
      : createEventSource
    if (!factory) {
      setConnectionState('closed')
      return undefined
    }
    const events = new DashboardEventSource({
      queryClient,
      createEventSource: factory,
      onStateChange: setConnectionState,
    })
    events.start()
    return () => events.close()
  }, [createEventSource, queryClient])

  return (
    <DashboardApiContext.Provider value={api}>
      <DashboardConnectionContext.Provider value={connectionState}>
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      </DashboardConnectionContext.Provider>
    </DashboardApiContext.Provider>
  )
}

export function useDashboardApi() {
  const api = useContext(DashboardApiContext)
  if (!api) throw new Error('useDashboardApi must be used inside AppProviders')
  return api
}

export function useDashboardConnection() {
  return useContext(DashboardConnectionContext)
}
