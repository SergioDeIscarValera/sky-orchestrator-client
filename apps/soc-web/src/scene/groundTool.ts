import { Raycaster, Vector2, type Camera, type Vector3 } from 'three'
import { create } from 'zustand'

import { eastNorth, geodeticAt, type Geodetic } from '../geometry/projection'
import type { Flat } from './drape'
import { groundUnder } from './pick'
import type { Site } from './site'

/** The canvas on the page, as `getBoundingClientRect` gives it. */
export interface Rect {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
}

/**
 * Where the pointer at (`clientX`, `clientY`) over the canvas meets the ground the
 * scene draws (FR-GEO-01, FR-WAY-01), or null: the sky, beyond `reachM`, or off the
 * site, where no ground is drawn to place anything on.
 */
export function groundAtPointer(
  camera: Camera,
  rect: Rect,
  clientX: number,
  clientY: number,
  site: Site,
  reachM: number,
): Vector3 | null {
  const pointer = new Vector2(
    ((clientX - rect.left) / rect.width) * 2 - 1,
    -((clientY - rect.top) / rect.height) * 2 + 1,
  )
  const raycaster = new Raycaster()
  raycaster.setFromCamera(pointer, camera)
  const hit = groundUnder(raycaster.ray, site.ground, reachM)
  if (hit === null) return null
  return Math.abs(hit.x) > site.halfSizeM || Math.abs(hit.z) > site.halfSizeM ? null : hit
}

/** A point of the scene's ground plane on the Earth: x east, z south (ADR-0014). */
export function placeOf(origin: Geodetic, point: Flat): Geodetic {
  return geodeticAt(origin, { eastM: point.x, northM: -point.z })
}

/** A point on the Earth on the scene's ground plane. */
export function flatOf(origin: Geodetic, at: Geodetic): Flat {
  const { eastM, northM } = eastNorth(origin, at)
  return { x: eastM, z: -northM }
}

/** Where on the page a click landed. */
export interface Click {
  readonly clientX: number
  readonly clientY: number
}

interface GroundTool {
  /** What a click that hits nothing in the scene does, while an editor holds it. */
  readonly use: ((click: Click) => void) | null
  /** Holds the clicks until the returned release is called. */
  readonly hold: (use: (click: Click) => void) => () => void
}

/**
 * The editor holding the scene's clicks on the ground: the geofence editor places its
 * vertices there, the wayline designer its points. Unheld, such a click clears the
 * selection. The canvas passes the click on; the editor, which has the camera, finds
 * the ground under it.
 */
export const useGroundTool = create<GroundTool>()((set, get) => ({
  use: null,
  hold: (use) => {
    set({ use })
    return () => {
      if (get().use === use) set({ use: null })
    }
  },
}))
