import { useEffect, useState } from 'react'

import { sampler } from './sampler'
import { CARD } from '../app/styles'
import { useTelemetryStore } from '../telemetry/context'
import type { TelemetryStore } from '../telemetry/store'

const REFRESH_MS = 500

interface Reading {
  readonly frames: number
  readonly p95: number | null
  readonly deliveryP95: number | null
  readonly drawCalls: number
  readonly triangles: number
  readonly geometries: number
  readonly textures: number
  readonly gpuBytes: number | null
}

function read(telemetry: TelemetryStore): Reading {
  return {
    frames: sampler.frames,
    p95: sampler.frameTimeP95Ms(),
    deliveryP95: telemetry.getState().deliveryP95(),
    drawCalls: sampler.drawCalls,
    triangles: sampler.triangles,
    geometries: sampler.geometries,
    textures: sampler.textures,
    gpuBytes: sampler.gpuMemory()?.bytes ?? null,
  }
}

const MEBIBYTE = 1024 * 1024

/**
 * The developer overlay, with `?stats` (NFR-OBS-05, NFR-PERF-01); the sampler is then on window
 * too.
 */
export function StatsOverlay() {
  const telemetry = useTelemetryStore()
  const [reading, setReading] = useState(() => read(telemetry))

  useEffect(() => {
    Object.assign(window, { socScene: sampler })
    const timer = window.setInterval(() => {
      setReading(read(telemetry))
    }, REFRESH_MS)
    return () => {
      window.clearInterval(timer)
    }
  }, [telemetry])

  return (
    <dl
      aria-label="Scene statistics"
      className={`${CARD} text-muted pointer-events-none absolute bottom-4 left-24 grid grid-cols-[auto_auto] gap-x-3 px-4 py-3 text-xs tabular-nums`}
    >
      <dt>frames</dt>
      <dd>{reading.frames}</dd>
      <dt>p95</dt>
      <dd>{reading.p95 === null ? '–' : `${reading.p95.toFixed(1)} ms`}</dd>
      <dt>delivery p95</dt>
      <dd>{reading.deliveryP95 === null ? '–' : `${reading.deliveryP95.toFixed(1)} ms`}</dd>
      <dt>draw calls</dt>
      <dd>{reading.drawCalls}</dd>
      <dt>triangles</dt>
      <dd>{reading.triangles}</dd>
      <dt>geometries</dt>
      <dd>{reading.geometries}</dd>
      <dt>textures</dt>
      <dd>{reading.textures}</dd>
      <dt>GPU memory</dt>
      <dd>{reading.gpuBytes === null ? '–' : `${(reading.gpuBytes / MEBIBYTE).toFixed(1)} MB`}</dd>
    </dl>
  )
}
