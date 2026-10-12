import { Html, Line } from '@react-three/drei'
import { useThree } from '@react-three/fiber'
import { useCallback, useEffect, useRef, type KeyboardEvent } from 'react'

import type { Geodetic } from '../geometry/projection'
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
import { draped, type Flat } from './drape'
import { flatOf, groundAtPointer, placeOf, useGroundTool } from './groundTool'
import { usePalette } from './palette'
import type { Site } from './site'

/** Above the ground, so the line is not lost among the terrain's facets. */
const LIFT_M = 1
/** A press that moves less than this is a click, not a drag. */
const CLICK_PX = 4
/** How far an arrow key moves the chosen vertex; ten times with Shift. */
const NUDGE_M = 1
const ARROWS: Readonly<Record<string, Flat>> = {
  ArrowUp: { x: 0, z: -1 },
  ArrowDown: { x: 0, z: 1 },
  ArrowLeft: { x: -1, z: 0 },
  ArrowRight: { x: 1, z: 0 },
}

type GroundAt = (clientX: number, clientY: number) => Geodetic | null

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
 * shows dashed; a click on the first vertex closes it.
 */
export function GeofenceEditing({ site, origin }: Props) {
  const editing = useGeofenceEditor((state) => state.editing)
  const change = useGeofenceEditor((state) => state.change)
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
      {flats.map((flat, index) => (
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

const LOOKS = {
  vertex: 'size-3.5 border-2 border-primary bg-surface',
  chosen: 'size-4 border-2 border-surface bg-primary',
  middle: 'size-2.5 border border-primary bg-surface opacity-80 hover:opacity-100',
} as const

interface HandleProps {
  readonly at: readonly [number, number, number]
  readonly label: string
  readonly look: keyof typeof LOOKS
  readonly groundAt: GroundAt
  readonly onGrab: () => void
  readonly onMove: (to: Geodetic) => void
  /** The press is over: `moved` false for a click. */
  readonly onLetGo: (moved: boolean) => void
  readonly onFocus?: () => void
  readonly onKeyDown?: (event: KeyboardEvent<HTMLButtonElement>) => void
  /** Enter or Space on the handle, which presses no pointer. */
  readonly onKeyboardClick?: () => void
}

/**
 * A handle over the scene, a button on the page: it keeps the pointer while dragged, so
 * the camera never moves under a drag, and takes the keyboard's focus.
 */
function Handle({
  at,
  label,
  look,
  groundAt,
  onGrab,
  onMove,
  onLetGo,
  onFocus,
  onKeyDown,
  onKeyboardClick,
}: HandleProps) {
  const press = useRef<{ x: number; y: number; moved: boolean } | null>(null)
  const letGo = () => {
    const pressed = press.current
    if (pressed === null) return
    press.current = null
    onLetGo(pressed.moved)
  }
  return (
    <Html position={[...at]} center zIndexRange={[30, 21]}>
      <button
        type="button"
        aria-label={label}
        className={`${LOOKS[look]} shadow-card focus-visible:outline-primary block cursor-grab touch-none rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 active:cursor-grabbing`}
        onPointerDown={(event) => {
          if (event.button !== 0) return
          event.currentTarget.setPointerCapture(event.pointerId)
          press.current = { x: event.clientX, y: event.clientY, moved: false }
          onGrab()
        }}
        onPointerMove={(event) => {
          const pressed = press.current
          if (pressed === null) return
          const distance = Math.hypot(event.clientX - pressed.x, event.clientY - pressed.y)
          if (!pressed.moved && distance < CLICK_PX) return
          pressed.moved = true
          const to = groundAt(event.clientX, event.clientY)
          if (to !== null) onMove(to)
        }}
        onPointerUp={letGo}
        onLostPointerCapture={letGo}
        onFocus={onFocus}
        onKeyDown={onKeyDown}
        onClick={(event) => {
          // A pointer's click was the press; only the keyboard's comes with no detail.
          if (event.detail === 0) onKeyboardClick?.()
        }}
      />
    </Html>
  )
}
