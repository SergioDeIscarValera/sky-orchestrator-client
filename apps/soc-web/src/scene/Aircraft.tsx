import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useLayoutEffect, useMemo } from 'react'

import { useSettings } from '../config/settings'
import type { Geodetic } from '../geometry/projection'
import { useTelemetryStore } from '../telemetry/context'
import {
  createAircraftParts,
  disposeAircraft,
  drawnAt,
  paintAircraft,
  writeAircraft,
  type Drawn,
} from './aircraft'
import { FIELD_OF_VIEW_DEG } from './camera'
import { usePalette } from './palette'

/** More aircraft than a farm flies at once. */
const CAPACITY = 32

/**
 * The organization's aircraft, gliding from sample to sample (FR-SCN-04,
 * FR-TEL-02). A frame is drawn when a sample arrives, when one crosses a
 * freshness threshold, and while an aircraft glides; none otherwise (NFR-RES-01).
 */
export function Aircraft({ origin }: { readonly origin: Geodetic | null }) {
  const store = useTelemetryStore()
  const settings = useSettings()
  const palette = usePalette()
  const invalidate = useThree((state) => state.invalidate)
  const parts = useMemo(() => createAircraftParts(CAPACITY), [])

  useEffect(
    () => () => {
      disposeAircraft(parts)
    },
    [parts],
  )

  useLayoutEffect(() => {
    paintAircraft(parts, palette)
    invalidate()
  }, [parts, palette, invalidate])

  useEffect(() => {
    let timers: ReturnType<typeof setTimeout>[] = []
    const schedule = () => {
      for (const timer of timers) clearTimeout(timer)
      timers = []
      const now = performance.now()
      for (const track of store.getState().tracks.values()) {
        for (const threshold of [settings.telemetryStaleAfterMs, settings.telemetryLostAfterMs]) {
          const wait = track.latest.receivedAt + threshold - now
          if (wait > 0) timers.push(setTimeout(invalidate, wait))
        }
      }
      invalidate()
    }
    schedule()
    const stop = store.subscribe(schedule)
    return () => {
      stop()
      for (const timer of timers) clearTimeout(timer)
    }
  }, [store, settings, invalidate])

  useFrame((state) => {
    const now = performance.now()
    const aircraft: { key: string; drawn: Drawn }[] = []
    if (origin !== null) {
      for (const [key, track] of store.getState().tracks) {
        const drawn = drawnAt(track, origin, now, settings)
        if (drawn !== null) aircraft.push({ key, drawn })
      }
    }
    writeAircraft(
      parts,
      aircraft,
      state.camera.position,
      FIELD_OF_VIEW_DEG,
      state.size.height,
      palette,
    )
    if (aircraft.some(({ drawn }) => drawn.gliding)) invalidate()
  })

  return <primitive object={parts.group} />
}
