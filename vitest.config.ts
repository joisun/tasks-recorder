import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./ui/react', import.meta.url)),
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./ui/react/test/setup.ts'],
    include: ['ui/react/**/*.test.{ts,tsx}'],
    restoreMocks: true,
  },
})
