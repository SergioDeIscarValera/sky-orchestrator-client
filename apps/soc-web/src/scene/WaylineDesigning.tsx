import { Html, Line } from '@react-three/drei'
import { useThree } from '@react-three/fiber'
import { MapPin } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

import { useSettings } from '../config/settings'
import { circlePoints } from '../geometry/circle'
import { cover } from '../geometry/grid'
import { locate, type Point } from '../geometry/planar'
import type { Primitive } from '../geometry/bake'
import { eastNorth, type Geodetic } from '../geometry/projection'
import { useGeofences } from '../plans/data'
import { judge } from '../plans/waylineBake'
import { clicked, useWaylineDesigner } from '../plans/waylineDesigner'
import { CANVAS_SETTINGS } from './canvas'
import { draped, type Flat } from './drape'
import { flatOf, groundAtPointer, placeOf, useGroundTool } from './groundTool'
import { usePalette } from './palette'
import type { Site } from './site'
import { Dots } from './Dots'
import { flownPath } from './waylinePath'

/** Above the ground, as the geofences' lines. */
const LIFT_M = 1

interface Props {
  readonly site: Site
  /** The scene's origin: the frame the wayline is baked on (ADR-0014). */
  readonly origin: Geodetic
}

/**
 * The wayline open in the designer, on the terrain (FR-WAY-01 to FR-WAY-07): its takeoff,
 * what is drawn laid over the ground, what is being drawn in the accent colour, and the
 * bake flown at its heights above the takeoff, its waypoints that break a rule in the
 * danger colour. The ground's clicks go to the tool taken up.
 */
export function WaylineDesigning({ site, origin }: Props) {
  const designing = useWaylineDesigner((state) => state.designing)
  const change = useWaylineDesigner((state) => state.change)
  const geofences = useGeofences()
  const settings = useSettings()
  const palette = usePalette()
  const camera = useThree((state) => state.camera)
  const canvas = useThree((state) => state.gl.domElement)
  const invalidate = useThree((state) => state.invalidate)
  const open = designing !== null
  const aiming = designing?.tool !== null && designing?.tool !== undefined

  const groundAt = useCallback(
    (clientX: number, clientY: number): Geodetic | null => {
      const rect = canvas.getBoundingClientRect()
      const hit = groundAtPointer(camera, rect, clientX, clientY, site, CANVAS_SETTINGS.camera.far)
      return hit === null ? null : placeOf(origin, hit)
    },
    [camera, canvas, site, origin],
  )

  // The takeoff is refused outside the geofence the wayline is designed for (FR-WAY-01).
  const fenceId = designing?.geofenceId ?? null
  const fenceRing = geofences.data?.find(({ id }) => id === fenceId)?.polygon ?? null
  useEffect(() => {
    if (!open) return
    const ring =
      fenceRing === null
        ? null
        : fenceRing.map((vertex): Point => {
            const placed = eastNorth(origin, vertex)
            return [placed.eastM, placed.northM]
          })
    const admits = (at: Geodetic) => {
      if (ring === null) return true
      const placed = eastNorth(origin, at)
      return locate(ring, [placed.eastM, placed.northM]) === 'inside'
    }
    return useGroundTool.getState().hold(({ clientX, clientY }) => {
      const at = groundAt(clientX, clientY)
      if (at !== null) change((current) => clicked(current, at, admits))
    })
  }, [open, groundAt, change, fenceRing, origin])

  useEffect(() => {
    if (!aiming) return
    canvas.classList.add('cursor-crosshair')
    return () => {
      canvas.classList.remove('cursor-crosshair')
    }
  }, [aiming, canvas])

  // A circle follows the pointer once its centre is placed: its radius previewed live as
  // it changes (FR-WAY-04).
  const [hover, setHover] = useState<Geodetic | null>(null)
  const sizing = designing?.tool === 'circle' && designing.pending.length === 1
  useEffect(() => {
    if (!sizing) return
    let frame = 0
    const follow = (event: PointerEvent) => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        setHover(groundAt(event.clientX, event.clientY))
      })
    }
    canvas.addEventListener('pointermove', follow)
    return () => {
      cancelAnimationFrame(frame)
      canvas.removeEventListener('pointermove', follow)
    }
  }, [sizing, canvas, groundAt])

  useEffect(() => {
    invalidate()
  }, [designing, hover, invalidate])

  if (designing === null) return null
  const { sketch, pending } = designing
  const step = site.spacingM === null ? Infinity : site.spacingM / 2
  const lay = (points: readonly Flat[], closing: boolean) =>
    draped(points, site.ground, step, LIFT_M, closing)
  const flat = (at: Geodetic) => flatOf(origin, at)
  const onGround = (at: Geodetic): [number, number, number] => {
    const { x, z } = flat(at)
    return [x, site.ground(x, z) + LIFT_M, z]
  }
  const fence = geofences.data?.find(({ id }) => id === designing.geofenceId) ?? null
  const { baked, violations } = judge(sketch, {
    origin,
    maxArcSpacingM: settings.maxArcSpacingM,
    fence: fence === null ? null : { polygon: fence.polygon, maxHeightM: fence.maxHeightM },
  })
  const breaking = new Set(
    violations.flatMap(({ waypointIndex }) => (waypointIndex === undefined ? [] : [waypointIndex])),
  )
  const path = baked === null ? null : flownPath(baked, origin, site)
  const [centre] = pending
  const sized =
    sizing && centre !== undefined && hover !== null
      ? (() => {
          const { eastM, northM } = eastNorth(centre, hover)
          const radiusM = Math.hypot(eastM, northM)
          if (radiusM === 0) return null
          const startBearingDeg = ((Math.atan2(eastM, northM) * 180) / Math.PI + 360) % 360
          const circle = { centre, radiusM, clockwise: designing.clockwise, startBearingDeg }
          return circlePoints(origin, circle, settings.maxArcSpacingM).map(flat)
        })()
      : null
  // A grid's coverage, previewed live as its corners and spacings change (FR-WAY-05).
  const { lineSpacingM, pointSpacingM } = designing
  const covered =
    designing.tool === 'grid' &&
    pending.length >= 3 &&
    lineSpacingM !== null &&
    lineSpacingM > 0 &&
    pointSpacingM !== null &&
    pointSpacingM > 0
      ? cover({
          area: pending.map((at) => {
            const placed = eastNorth(origin, at)
            return [placed.eastM, placed.northM] as const
          }),
          lineSpacingM,
          pointSpacingM,
        }).lines.map((line) => line.map(([east, north]) => ({ x: east, z: -north })))
      : []

  const drawnLine = (primitive: Primitive, index: number) => {
    const key = `drawn-${String(index)}`
    switch (primitive.kind) {
      case 'route':
        return (
          <Line
            key={key}
            points={lay(primitive.points.map(flat), false)}
            color={palette.gridMajor}
            lineWidth={1.5}
            dashed
            dashSize={3}
            gapSize={2}
            depthTest={false}
            renderOrder={8}
          />
        )
      case 'points':
        return (
          <Dots
            key={key}
            points={primitive.points.map(onGround)}
            colour={palette.gridMajor}
            size={7}
          />
        )
      case 'circle': {
        const ring = circlePoints(origin, primitive, settings.maxArcSpacingM).map(flat)
        return (
          <Line
            key={key}
            points={lay(ring, false)}
            color={palette.gridMajor}
            lineWidth={1.5}
            dashed
            dashSize={3}
            gapSize={2}
            depthTest={false}
            renderOrder={8}
          />
        )
      }
      case 'grid':
        return (
          <Line
            key={key}
            points={lay(primitive.area.map(flat), true)}
            color={palette.gridMajor}
            lineWidth={1.5}
            depthTest={false}
            renderOrder={8}
          />
        )
    }
  }

  return (
    <group>
      {fence !== null && (
        <Line
          points={lay(fence.polygon.map(flat), true)}
          color={palette.gridMajor}
          lineWidth={1}
          depthTest={false}
          renderOrder={7}
        />
      )}
      {sketch.primitives.map(drawnLine)}
      {pending.length > 0 && (
        <>
          {pending.length > 1 && (
            <Line
              points={lay(pending.map(flat), designing.tool === 'grid')}
              color={palette.accent}
              lineWidth={2}
              depthTest={false}
              renderOrder={10}
            />
          )}
          <Dots points={pending.map(onGround)} colour={palette.accent} size={8} />
        </>
      )}
      {sized !== null && (
        <Line
          points={lay(sized, false)}
          color={palette.accent}
          lineWidth={1.5}
          dashed
          dashSize={3}
          gapSize={2}
          depthTest={false}
          renderOrder={10}
        />
      )}
      {covered.map((line, index) =>
        line.length < 2 ? null : (
          <Line
            key={`covered-${String(index)}`}
            points={lay(line, false)}
            color={palette.accent}
            lineWidth={1}
            depthTest={false}
            renderOrder={10}
          />
        ),
      )}
      {path !== null && path.points.length >= 2 && (
        <Line
          points={path.points}
          color={palette.accent}
          lineWidth={2.5}
          depthTest={false}
          renderOrder={11}
        />
      )}
      {path !== null && (
        <>
          <Dots
            points={path.waypoints.filter((_, index) => !breaking.has(index))}
            colour={palette.accent}
            size={7}
          />
          <Dots
            points={path.waypoints.filter((_, index) => breaking.has(index))}
            colour={palette.danger}
            size={9}
          />
        </>
      )}
      {sketch.takeoff !== null && (
        <Html
          position={onGround(sketch.takeoff)}
          center
          zIndexRange={[19, 0]}
          className="pointer-events-none"
        >
          <span className="text-primary block -translate-y-1/2" aria-label="Takeoff">
            <MapPin size={22} aria-hidden />
          </span>
        </Html>
      )}
    </group>
  )
}
