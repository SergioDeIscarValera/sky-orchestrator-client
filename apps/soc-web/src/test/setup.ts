import { afterEach } from 'vitest'

// Files that run in Node test no DOM, so they skip Testing Library's cost.
if (typeof window !== 'undefined') {
  const [{ cleanup, configure }] = await Promise.all([
    import('@testing-library/react'),
    import('@testing-library/jest-dom/vitest'),
  ])
  // A panel's first open loads its module in the test run, which a loaded machine makes slower than
  // the one-second default: the wait is a bound on failure, not a speed target, so it is five seconds.
  configure({ asyncUtilTimeout: 5_000 })
  afterEach(() => {
    cleanup()
    window.localStorage.clear()
    delete document.documentElement.dataset.theme
    document.documentElement.removeAttribute('style')
    window.history.replaceState(null, '', '/')
  })
}
