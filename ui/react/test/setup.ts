import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

afterEach(() => cleanup())

class TestResizeObserver implements ResizeObserver {
  disconnect() {}
  observe() {}
  unobserve() {}
}

globalThis.ResizeObserver = TestResizeObserver

const storedPreferences = new Map<string, string>()
const preferenceStorage: Storage = {
  get length() { return storedPreferences.size },
  clear: () => storedPreferences.clear(),
  getItem: (key) => storedPreferences.get(key) ?? null,
  key: (index) => [...storedPreferences.keys()][index] ?? null,
  removeItem: (key) => { storedPreferences.delete(key) },
  setItem: (key, value) => { storedPreferences.set(key, value) },
}

Object.defineProperty(window, 'localStorage', {
  configurable: true,
  value: preferenceStorage,
})

if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => []
}
