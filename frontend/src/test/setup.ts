import '@testing-library/jest-dom/vitest'
import { afterEach, vi } from 'vitest'
import { cleanup } from '@testing-library/react'

// React 19: userEvent and RTL wrap updates in act(); without this flag React
// warns "testing environment is not configured to support act(...)". The
// ambient declaration supplies the global React's types don't.
declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true

Object.defineProperty(window, 'scrollTo', { value: vi.fn(), writable: true })

afterEach(() => {
  cleanup()
  window.localStorage.clear()
})
