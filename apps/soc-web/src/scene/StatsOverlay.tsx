import { useEffect, useState } from 'react'

import { sampler } from './sampler'
import { CARD } from '../app/styles'

const REFRESH_MS = 500

interface Reading {
  readonly frames: number
  readonly p95: number | null
  readonly drawCalls: number
  readonly triangles: number
  readonly geometries: number
  readonly textures: number
}

function read(): Reading {
  return {
    frames: sampler.frames,
    p95: sampler.frameTimeP95Ms(),
    drawCalls: sampler.drawCalls,
    triangles: sampler.triangles,
    geometries: sampler.geometries,
    textures: sampler.textures,
  }
}

/** The developer overlay, with `?stats` (NFR-OBS-05); the sampler is then on window too. */
export function StatsOverlay() {
  const [reading, setReading] = useState(read)

  useEffect(() => {
    Object.assign(window, { socScene: sampler })
    const timer = window.setInterval(() => {
      setReading(read())
    }, REFRESH_MS)
    return () => {
      window.clearInterval(timer)
    }
  }, [])

  return (
    <dl
      aria-label="Scene statistics"
      className={`${CARD} text-muted pointer-events-none absolute bottom-4 left-24 grid grid-cols-[auto_auto] gap-x-3 px-4 py-3 text-xs tabular-nums`}
    >
      <dt>frames</dt>
      <dd>{reading.frames}</dd>
      <dt>p95</dt>
      <dd>{reading.p95 === null ? '–' : `${reading.p95.toFixed(1)} ms`}</dd>
      <dt>draw calls</dt>
      <dd>{reading.drawCalls}</dd>
      <dt>triangles</dt>
      <dd>{reading.triangles}</dd>
      <dt>geometries</dt>
      <dd>{reading.geometries}</dd>
      <dt>textures</dt>
      <dd>{reading.textures}</dd>
    </dl>
  )
}
