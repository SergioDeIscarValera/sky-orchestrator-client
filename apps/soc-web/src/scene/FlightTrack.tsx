import { useThree } from '@react-three/fiber'
import { useEffect, useLayoutEffect, useMemo, useState } from 'react'
import { Line2 } from 'three/addons/lines/Line2.js'
import { LineGeometry } from 'three/addons/lines/LineGeometry.js'
import { LineMaterial } from 'three/addons/lines/LineMaterial.js'

import { aircraftKey, type Flight } from '../backend/backend'
import { useAircraftColours } from '../fleets/colours'
import type { Geodetic } from '../geometry/projection'
import { useFlightTrack } from '../operations/data'
import type { TelemetrySample } from '../telemetry/sample'
import { useTrack } from '../telemetry/context'
import type { Track } from '../telemetry/store'
import { usePalette } from './palette'
import type { Site } from './site'
import { trackSpots, type Vertex } from './track'

/** The track's width in pixels, and its order over the terrain: above a planned flight's line (FR-SCN-04). */
const TRACK_WIDTH_PX = 3
const TRACK_RENDER_ORDER = 10

interface Props {
  readonly flight: Flight
  /** The takeoff point the flight's heights are above: the reference point of its planned flight. */
  readonly takeoff: Geodetic
  readonly origin: Geodetic
  readonly site: Site
}

/**
 * A flight's track (FR-TEL-05, FR-SCN-04): its stored samples joined in time order, then, while the
 * flight has not ended, the live samples after the last stored one, so the line reaches the aircraft.
 * In the aircraft's own colour, never picked: a click over it reaches the ground beneath.
 */
export function FlightTrack({ flight, takeoff, origin, site }: Props) {
  const ended = flight.endedAt !== null
  const stored = useFlightTrack(flight.id, ended)
  const track = useTrack(flight.gatewaySn, flight.aircraftSn)
  const colourOf = useAircraftColours()
  const palette = usePalette()
  const size = useThree((state) => state.size)
  const invalidate = useThree((state) => state.invalidate)
  const colour =
    palette.aircraft[
      colourOf(aircraftKey(flight.gatewaySn, flight.aircraftSn)) %
        Math.max(1, palette.aircraft.length)
    ] ?? palette.accent

  // The vertices change with the stored track (every refresh) and with the live samples (each one).
  const spots = useMemo(
    () =>
      trackSpots(
        { origin, ground: site.ground, takeoff },
        stored.data ?? [],
        ended || track === undefined ? [] : latestSamples(track),
      ),
    [stored.data, ended, track, origin, site, takeoff],
  )
  // Built once per change of vertices; the geometry it replaces is disposed below (gpuMemory.ts).
  const geometry = useMemo(() => lineGeometry(spots), [spots])
  // One line and one material for the track's life: only the geometry is replaced.
  const [{ line, material }] = useState(() => {
    const lineMaterial = new LineMaterial({ linewidth: TRACK_WIDTH_PX })
    lineMaterial.depthTest = false
    const object = new Line2(undefined, lineMaterial)
    object.raycast = () => undefined
    object.renderOrder = TRACK_RENDER_ORDER
    return { line: object, material: lineMaterial }
  })

  useLayoutEffect(() => {
    material.color.set(colour)
    // The width is in pixels, so the material needs the viewport's, as drei's Line takes it.
    material.resolution.set(size.width, size.height)
    invalidate()
  }, [material, colour, size, invalidate])

  useLayoutEffect(() => {
    invalidate()
  }, [geometry, invalidate])

  // The geometry a change replaces is disposed as the change lands, and the last one at unmount.
  useEffect(
    () => () => {
      geometry.dispose()
    },
    [geometry],
  )

  useEffect(
    () => () => {
      material.dispose()
    },
    [material],
  )

  if (spots.length < 2) return null
  return (
    <primitive object={line} name="flight track" dispose={null}>
      <primitive object={geometry} attach="geometry" dispose={null} />
    </primitive>
  )
}

/** The samples a track holds of a flight in the air: its latest two, the store keeps no more. */
function latestSamples(track: Track): TelemetrySample[] {
  return track.previous === null
    ? [track.latest.sample]
    : [track.previous.sample, track.latest.sample]
}

/** The line through `spots` as one geometry; a line of fewer than two points has none to draw. */
function lineGeometry(spots: readonly Vertex[]): LineGeometry {
  const geometry = new LineGeometry()
  if (spots.length >= 2) geometry.setPositions(new Float32Array(spots.flat()))
  return geometry
}
