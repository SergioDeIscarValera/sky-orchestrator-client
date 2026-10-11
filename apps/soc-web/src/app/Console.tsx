import { RouterProvider } from '@tanstack/react-router'
import { useState } from 'react'

import { useLiveState } from '../fleets/data'
import { TelemetryContext, useLiveTelemetry } from '../telemetry/context'
import { createTelemetryStore } from '../telemetry/store'
import { createConsoleRouter } from './router'
import { Shell } from './Shell'

/** The console of one open organization, its view in the URL (NFR-UX-03), kept live. */
export function Console() {
  useLiveState()
  const [telemetry] = useState(createTelemetryStore)
  useLiveTelemetry(telemetry)
  const [router] = useState(() => createConsoleRouter(Shell))
  return (
    <TelemetryContext value={telemetry}>
      <RouterProvider router={router} />
    </TelemetryContext>
  )
}
