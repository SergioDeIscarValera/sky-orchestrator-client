import '@testing-library/jest-dom/vitest'

import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

afterEach(() => {
  if (typeof window === 'undefined') return
  cleanup()
  window.localStorage.clear()
  delete document.documentElement.dataset.theme
})
