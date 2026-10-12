import type { KeyboardEvent } from 'react'

import type { Primitive } from '../geometry/bake'
import type { Geodetic } from '../geometry/projection'
import {
  dragged,
  grabbed,
  grabbedMiddle,
  handleChosen,
  handleMoved,
  released,
  rimOf,
  type Designing,
  type Handle,
} from '../plans/waylineDesigner'
import type { Flat } from './drape'
import { flatOf, placeOf } from './groundTool'
import type { GroundAt } from './HandleButton'
import { SceneHandle } from './SceneHandle'
import type { Site } from './site'

/** Above the ground, as the lines are, so a handle sits on what it moves. */
const LIFT_M = 1
/** How far an arrow key moves the chosen handle; ten times with Shift. */
const NUDGE_M = 1
const ARROWS: Readonly<Record<string, Flat>> = {
  ArrowUp: { x: 0, z: -1 },
  ArrowDown: { x: 0, z: 1 },
  ArrowLeft: { x: -1, z: 0 },
  ArrowRight: { x: 1, z: 0 },
}

interface Props {
  readonly designing: Designing
  readonly site: Site
  readonly origin: Geodetic
  readonly groundAt: GroundAt
  readonly change: (step: (designing: Designing) => Designing) => void
}

const same = (a: Handle | null, b: Handle) =>
  a !== null &&
  a.kind === b.kind &&
  (a.kind !== 'point' || b.kind !== 'point' || a.index === b.index)

/** The points a primitive's handles move, and whether they close a ring. */
function pointsOf(primitive: Primitive): {
  readonly points: readonly Geodetic[]
  readonly ring: boolean
} {
  switch (primitive.kind) {
    case 'route':
      return { points: primitive.points, ring: false }
    case 'points':
      return { points: primitive.points, ring: false }
    case 'grid':
      return { points: primitive.area, ring: true }
    case 'circle':
      return { points: [], ring: false }
  }
}

const NAMES = { route: 'Point', points: 'Point', grid: 'Corner', circle: '' } as const
const BENDS = { route: 'Bend leg', grid: 'Bend edge' } as const

/**
 * The handles of the wayline open in the designer, while no tool is taken up (FR-WAY-01
 * to FR-WAY-06): the takeoff's, and those of the primitive open in its editor. A route's
 * or points' points and a grid's corners drag, a route's legs and a grid's edges bend from
 * their middle, a circle moves by its centre and is sized by its rim. A handle chosen
 * moves a metre at each arrow key, ten with Shift.
 */
export function WaylineHandles({ designing, site, origin, groundAt, change }: Props) {
  if (designing.tool !== null) return null
  const { sketch, selected, picked } = designing
  const lifted = (at: Geodetic): [number, number, number] => {
    const { x, z } = flatOf(origin, at)
    return [x, site.ground(x, z) + LIFT_M, z]
  }
  const nudge = (handle: Handle, from: Geodetic) => (event: KeyboardEvent<HTMLButtonElement>) => {
    const arrow = ARROWS[event.key]
    if (arrow === undefined) return
    event.preventDefault()
    const metres = event.shiftKey ? NUDGE_M * 10 : NUDGE_M
    const { x, z } = flatOf(origin, from)
    const to = placeOf(origin, { x: x + arrow.x * metres, z: z + arrow.z * metres })
    change((current) => handleMoved(current, handle, to))
  }
  const handle = (key: string, label: string, which: Handle, at: Geodetic) => (
    <SceneHandle
      key={key}
      at={lifted(at)}
      label={label}
      look={same(picked, which) ? 'chosen' : 'vertex'}
      groundAt={groundAt}
      onGrab={() => {
        change((current) => grabbed(current, which))
      }}
      onMove={(to) => {
        change((current) => dragged(current, to))
      }}
      onLetGo={() => {
        change(released)
      }}
      onFocus={() => {
        change((current) => (current.held === null ? handleChosen(current, which) : current))
      }}
      onKeyDown={nudge(which, at)}
    />
  )

  const primitive = selected === null ? undefined : sketch.primitives[selected]
  const takeoff =
    sketch.takeoff === null
      ? []
      : [handle('takeoff', 'Takeoff', { kind: 'takeoff' }, sketch.takeoff)]
  if (primitive === undefined) return <>{takeoff}</>
  if (primitive.kind === 'circle') {
    return (
      <>
        {takeoff}
        {handle('centre', 'Centre', { kind: 'centre' }, primitive.centre)}
        {handle('rim', 'Radius', { kind: 'rim' }, rimOf(primitive))}
      </>
    )
  }
  const { points, ring } = pointsOf(primitive)
  const name = NAMES[primitive.kind]
  const vertices = points.map((point, index) =>
    handle(
      `point-${String(index)}`,
      `${name} ${String(index + 1)}`,
      { kind: 'point', index },
      point,
    ),
  )
  const bend = primitive.kind === 'points' ? null : BENDS[primitive.kind]
  const edges = bend === null ? 0 : ring ? points.length : points.length - 1
  const middles = Array.from({ length: edges }, (_, edge) => {
    const from = points[edge]
    const to = points[(edge + 1) % points.length]
    if (from === undefined || to === undefined) return null
    const a = flatOf(origin, from)
    const b = flatOf(origin, to)
    const middle = placeOf(origin, { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 })
    return (
      <SceneHandle
        key={`middle-${String(edge)}`}
        at={lifted(middle)}
        label={`${bend ?? ''} ${String(edge + 1)}`}
        look="middle"
        groundAt={groundAt}
        onGrab={() => {
          change((current) => grabbedMiddle(current, edge, middle))
        }}
        onMove={(at) => {
          change((current) => dragged(current, at))
        }}
        onLetGo={() => {
          change(released)
        }}
        onKeyboardClick={() => {
          change((current) => released(grabbedMiddle(current, edge, middle)))
        }}
      />
    )
  })
  return (
    <>
      {takeoff}
      {vertices}
      {middles}
    </>
  )
}
