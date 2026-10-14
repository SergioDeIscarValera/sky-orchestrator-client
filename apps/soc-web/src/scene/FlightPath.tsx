import { Line } from '@react-three/drei'
import type { ThreeEvent } from '@react-three/fiber'

import { Dots } from './Dots'
import type { FlownPath } from './waylinePath'

interface Props {
  /** The name the line carries in the scene. */
  readonly name: string
  readonly path: FlownPath
  /** The line and its waypoints' dots, in one colour. */
  readonly colour: string
  readonly lineWidth: number
  readonly renderOrder: number
  readonly onClick?: (event: ThreeEvent<MouseEvent>) => void
}

/**
 * A flight's path as it flies, drawn over the terrain with its waypoints (FR-WAY-07): a selected
 * wayline's, and an operation's planned flight, which is its stored flight's (FR-OPS-07).
 */
export function FlightPath({ name, path, colour, lineWidth, renderOrder, onClick }: Props) {
  return (
    <group>
      <Line
        name={name}
        points={path.points}
        color={colour}
        lineWidth={lineWidth}
        depthTest={false}
        renderOrder={renderOrder}
        onClick={onClick}
      />
      <Dots points={path.waypoints} colour={colour} size={7} />
    </group>
  )
}
