import { Html, Line } from '@react-three/drei'
import { useThree } from '@react-three/fiber'
import { useCallback, useEffect, type KeyboardEvent } from 'react'

import type { Geodetic } from '../geometry/projection'
import { useWaylines } from '../plans/data'
import { measure } from '../plans/geofenceDrawing'
import {
  chosen,
  closed,
  dragged,
  grabbed,
  grabbedEdge,
  placed,
  released,
  useGeofenceEditor,
} from '../plans/geofenceEditor'
import { CANVAS_SETTINGS } from './canvas'
import { CeilingVolume } from './CeilingVolume'
import { draped, type Flat } from './drape'
import { flatOf, groundAtPointer, placeOf, useGroundTool } from './groundTool'
import { HandleButton, type GroundAt, type HandleButtonProps } from './HandleButton'
import { usePalette } from './palette'
import type { Site } from './site'

/** Above the ground, so the line is not lost among the terrain's facets. */
const LIFT_M = 1
/** How far an arrow key moves the chosen vertex; ten times with Shift. */
const NUDGE_M = 1
const ARROWS: Readonly<Record<string, Flat>> = {
  ArrowUp: { x: 0, z: -1 },
  ArrowDown: { x: 0, z: 1 },
  ArrowLeft: { x: -1, z: 0 },
  ArrowRight: { x: 1, z: 0 },
}

interface Props {
  readonly site: Site
  /** The scene's origin: the local frame the drawing is measured on (ADR-0014). */
  readonly origin: Geodetic
}

/**
 * The geofence open in the editor, drawn on the terrain (FR-GEO-01): its outline laid
 * over the ground, the edges that keep it from being simple in the danger colour, a
 * handle on each vertex to drag, and while shaping one on each edge's middle to bend
 * it. While placing, a click on the ground adds a vertex and the ring's closing edge
 * shows dashed; a click on the first vertex closes it. Generated, it has no handles, and
 * the waylines it is generated round show dashed under it (FR-GEO-03).
 */
export function GeofenceEditing({ site, origin }: Props) {
  const editing = useGeofenceEditor((state) => state.editing)
  const change = useGeofenceEditor((state) => state.change)
  const waylines = useWaylines()
  const palette = usePalette()
  const camera = useThree((state) => state.camera)
  const canvas = useThree((state) => state.gl.domElement)
  const invalidate = useThree((state) => state.invalidate)
  const open = editing !== null
  const placing = editing?.phase === 'placing'

  const groundAt = useCallback<GroundAt>(
    (clientX, clientY) => {
      const rect = canvas.getBoundingClientRect()
      const far = CANVAS_SETTINGS.camera.far
      const hit = groundAtPointer(camera, rect, clientX, clientY, site, far)
      return hit === null ? null : placeOf(origin, hit)
    },
    [camera, canvas, site, origin],
  )

  // The ground's clicks are the editor's while a geofence is open: placing, each adds a
  // vertex; shaping, one lets go of the chosen vertex.
  useEffect(() => {
    if (!open) return
    return useGroundTool.getState().hold(({ clientX, clientY }) => {
      const at = groundAt(clientX, clientY)
      change((current) => {
        if (current.phase === 'shaping') return { ...current, picked: null }
        return at === null ? current : placed(current, at)
      })
    })
  }, [open, groundAt, change])

  useEffect(() => {
    if (!placing) return
    canvas.classList.add('cursor-crosshair')
    return () => {
      canvas.classList.remove('cursor-crosshair')
    }
  }, [placing, canvas])

  useEffect(() => {
    invalidate()
  }, [editing, invalidate])

  if (editing === null) return null
  const shaping = editing.phase === 'shaping'
  // Generated, the shape follows the waylines and the margin: nothing to move by hand.
  const handled = editing.generating === null
  const chosenIds = editing.generating?.waylineIds ?? []
  const followed = (waylines.data ?? []).filter(({ id }) => chosenIds.includes(id))
  const flats = editing.drawing.vertices.map((vertex) => flatOf(origin, vertex))
  const step = site.spacingM === null ? Infinity : site.spacingM / 2
  const lay = (points: readonly Flat[], closing: boolean) =>
    draped(points, site.ground, step, LIFT_M, closing)
  const lifted = (flat: Flat): [number, number, number] => [
    flat.x,
    site.ground(flat.x, flat.z) + LIFT_M,
    flat.z,
  ]
  const edgeOf = (edge: number): readonly [Flat, Flat] | null => {
    const from = flats[edge]
    const to = flats[(edge + 1) % flats.length]
    return from === undefined || to === undefined ? null : [from, to]
  }
  const offending = [...new Set(measure(editing.drawing, origin).problems.flatMap((p) => p.edges))]
  const outline = lay(flats, shaping)
  const closingEdge = !shaping && flats.length >= 3 ? edgeOf(flats.length - 1) : null

  const nudge = (index: number) => (event: KeyboardEvent<HTMLButtonElement>) => {
    const arrow = ARROWS[event.key]
    const from = flats[index]
    if (arrow === undefined || from === undefined) return
    event.preventDefault()
    const metres = event.shiftKey ? NUDGE_M * 10 : NUDGE_M
    const to = placeOf(origin, { x: from.x + arrow.x * metres, z: from.z + arrow.z * metres })
    change((current) => released(dragged(grabbed(current, index), to)))
  }

  return (
    <group>
      <CeilingVolume
        ring={flats}
        site={site}
        ceilingM={editing.drawing.maxHeightM}
        colour={palette.accent}
      />
      {outline.length >= 2 && (
        <Line
          points={outline}
          color={palette.accent}
          lineWidth={2.5}
          depthTest={false}
          renderOrder={10}
        />
      )}
      {closingEdge !== null && (
        <Line
          points={lay(closingEdge, false)}
          color={palette.accent}
          lineWidth={1.5}
          dashed
          dashSize={4}
          gapSize={3}
          depthTest={false}
          renderOrder={10}
        />
      )}
      {offending.map((edge) => {
        const ends = edgeOf(edge)
        return ends === null ? null : (
          <Line
            key={`offending-${String(edge)}`}
            points={lay(ends, false)}
            color={palette.danger}
            lineWidth={4}
            depthTest={false}
            renderOrder={11}
          />
        )
      })}
      {followed.map((wayline) => (
        <Line
          key={`wayline-${wayline.id}`}
          points={lay(
            [wayline.takeoff, ...wayline.waypoints.map(({ position }) => position)].map(
              (position) => flatOf(origin, position),
            ),
            false,
          )}
          color={palette.gridMajor}
          lineWidth={1.5}
          dashed
          dashSize={3}
          gapSize={3}
          depthTest={false}
          renderOrder={9}
        />
      ))}
      {handled &&
        flats.map((flat, index) => (
          <Handle
            key={`vertex-${String(index)}`}
            at={lifted(flat)}
            label={`Vertex ${String(index + 1)}`}
            look={editing.picked === index ? 'chosen' : 'vertex'}
            groundAt={groundAt}
            onGrab={() => {
              change((current) => grabbed(current, index))
            }}
            onMove={(to) => {
              change((current) => dragged(current, to))
            }}
            onLetGo={(moved) => {
              change((current) => {
                const after = released(current)
                const closes = !moved && index === 0 && after.phase === 'placing'
                return closes ? closed(after) : after
              })
            }}
            onFocus={() => {
              change((current) => (current.held === null ? chosen(current, index) : current))
            }}
            onKeyDown={nudge(index)}
          />
        ))}
      {shaping &&
        handled &&
        flats.map((_, edge) => {
          const ends = edgeOf(edge)
          if (ends === null) return null
          const [from, to] = ends
          const middle = { x: (from.x + to.x) / 2, z: (from.z + to.z) / 2 }
          const bend = () => placeOf(origin, middle)
          return (
            <Handle
              key={`middle-${String(edge)}`}
              at={lifted(middle)}
              label={`Bend edge ${String(edge + 1)}`}
              look="middle"
              groundAt={groundAt}
              onGrab={() => {
                change((current) => grabbedEdge(current, edge, bend()))
              }}
              onMove={(to) => {
                change((current) => dragged(current, to))
              }}
              onLetGo={() => {
                change(released)
              }}
              onKeyboardClick={() => {
                change((current) => released(grabbedEdge(current, edge, bend())))
              }}
            />
          )
        })}
    </group>
  )
}

function Handle({
  at,
  ...button
}: { readonly at: readonly [number, number, number] } & HandleButtonProps) {
  return (
    <Html position={[...at]} center zIndexRange={[30, 21]}>
      <HandleButton {...button} />
    </Html>
  )
}
