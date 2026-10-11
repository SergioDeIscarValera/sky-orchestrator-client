import { afterEach } from 'vitest'

// Files that run in Node test no DOM, so they skip Testing Library's cost.
if (typeof window !== 'undefined') {
  const [{ cleanup }] = await Promise.all([
    import('@testing-library/react'),
    import('@testing-library/jest-dom/vitest'),
  ])
  afterEach(() => {
    cleanup()
    window.localStorage.clear()
    delete document.documentElement.dataset.theme
    document.documentElement.removeAttribute('style')
    window.history.replaceState(null, '', '/')
  })
}
