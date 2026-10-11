import { RouterProvider } from '@tanstack/react-router'
import { useState } from 'react'

import { createConsoleRouter } from './router'
import { Shell } from './Shell'

/** The console of one open organization, its view in the URL (NFR-UX-03). */
export function Console() {
  const [router] = useState(() => createConsoleRouter(Shell))
  return <RouterProvider router={router} />
}
