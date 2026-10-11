import { RouterProvider } from '@tanstack/react-router'
import { useState } from 'react'

import { useLiveState } from '../fleets/data'
import { createConsoleRouter } from './router'
import { Shell } from './Shell'

/** The console of one open organization, its view in the URL (NFR-UX-03), kept live. */
export function Console() {
  useLiveState()
  const [router] = useState(() => createConsoleRouter(Shell))
  return <RouterProvider router={router} />
}
