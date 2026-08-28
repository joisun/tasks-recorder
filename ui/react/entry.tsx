import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { AppProviders } from './app/app-providers'
import { DashboardApp } from './app/dashboard-app'

const root = document.getElementById('root')
if (!root) throw new Error('React Dashboard root is missing')

createRoot(root).render(
  <StrictMode>
    <AppProviders>
      <DashboardApp />
    </AppProviders>
  </StrictMode>,
)
