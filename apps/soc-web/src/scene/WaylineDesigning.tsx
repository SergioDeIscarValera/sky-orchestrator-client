import { Html, Line } from '@react-three/drei'
import { useThree, type ThreeEvent } from '@react-three/fiber'
import { MapPin } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

import { useSettings } from '../config/settings'
import { circlePoints } from '../geometry/circle'
import { cover } from '../geometry/grid'
import type { Primitive } from '../geometry/bake'
import { eastNorth, type Geodetic } from '../geometry/projection'
import { formatLength } from '../plans/format'
import { bakeSketch } from '../plans/waylineBake'
import { clicked, primitiveChosen, useWaylineDesigner } from '../plans/waylineDesigner'
import { CANVAS_SETTINGS } from './canvas'
import { draped, type Flat } from './drape'
import { flatOf, groundAtPointer, placeOf, useGroundTool } from './groundTool'
import { usePalette } from './palette'
import type { Site } from './site'
import { Dots } from './Dots'
import { WaylineHandles } from './WaylineHandles'
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
 * what is drawn laid over the ground, what is being drawn in the accent colour, and its
 * bake at its heights above the takeoff. The ground's clicks go to the tool taken up; with
 * none, a click on what is drawn opens it in its editor, its handles over it.
 */
export function WaylineDesigning({ site, origin }: Props) {
  const designing = useWaylineDesigner((state) => state.designing)
  const change = useWaylineDesigner((state) => state.change)
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

  useEffect(() => {
    if (!open) return
    return useGroundTool.getState().hold(({ clientX, clientY }) => {
      const at = groundAt(clientX, clientY)
      if (at !== null) change((current) => clicked(current, at))
    })
  }, [open, groundAt, change])

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
  const baked = bakeSketch(sketch, { origin, maxArcSpacingM: settings.maxArcSpacingM })
  const takeoff = sketch.takeoff
  // The wayline's own path: from its takeoff straight to its first waypoint, the climb being
  // the operation's (M4).
  // The wayline climbs straight up from its takeoff to its height (FR-WAY-01): shown as
  // soon as both are given, before anything is drawn; the bake starts there after.
  const climb =
    takeoff !== null && sketch.defaultHeightM !== null && sketch.defaultHeightM > 0
      ? [{ ...takeoff, heightM: sketch.defaultHeightM }]
      : null
  const flown = baked !== null && baked.waypoints.length > 0 ? baked.waypoints : climb
  const path =
    flown === null || takeoff === null
      ? null
      : flownPath(
          { referencePoint: takeoff, takeoffSecurityHeightM: null, waypoints: flown },
          origin,
          site,
        )
  const top = path?.waypoints[0]
  const topHeightM = flown?.[0]?.heightM
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
    const open = designing.selected === index
    const colour = open ? palette.accent : palette.gridMajor
    // With no tool, what is drawn is chosen by a click; a tool's clicks go to the ground.
    const choose =
      designing.tool === null
        ? (event: ThreeEvent<MouseEvent>) => {
            event.stopPropagation()
            change((current) => primitiveChosen(current, index))
          }
        : undefined
    const line = (points: readonly Flat[], closing: boolean, dashed: boolean) => (
      <Line
        key={key}
        name={`drawn ${String(index + 1)}`}
        points={lay(points, closing)}
        color={colour}
        lineWidth={open ? 2 : 1.5}
        dashed={dashed}
        dashSize={3}
        gapSize={2}
        depthTest={false}
        renderOrder={open ? 9 : 8}
        onClick={choose}
      />
    )
    switch (primitive.kind) {
      case 'route':
        return line(primitive.points.map(flat), false, true)
      case 'points':
        return <Dots key={key} points={primitive.points.map(onGround)} colour={colour} size={7} />
      case 'circle':
        return line(circlePoints(origin, primitive, settings.maxArcSpacingM).map(flat), false, true)
      case 'grid':
        return line(primitive.area.map(flat), true, false)
    }
  }

  return (
    <group>
      {sketch.primitives.map(drawnLine)}
      {pending.length > 0 && (
        <>
          {/* Points of interest are points: only a route or a grid's area is a line. */}
          {pending.length > 1 && designing.tool !== 'points' && (
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
      {covered.length > 0 && (
        <Dots
          points={covered.flatMap((line) =>
            line.map(({ x, z }) => [x, site.ground(x, z) + LIFT_M, z] as const),
          )}
          colour={palette.accent}
          size={5}
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
      {path !== null && <Dots points={path.waypoints} colour={palette.accent} size={7} />}
      {top !== undefined && topHeightM !== undefined && (
        <Html position={[...top]} center zIndexRange={[19, 0]} className="pointer-events-none">
          <span className="rounded-pill bg-surface text-heading shadow-card block translate-x-1/2 px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap tabular-nums">
            {formatLength(topHeightM)}
          </span>
        </Html>
      )}
      <WaylineHandles
        designing={designing}
        site={site}
        origin={origin}
        groundAt={groundAt}
        change={change}
      />
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
