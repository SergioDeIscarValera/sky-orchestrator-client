import {
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  Fog,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  type Scene,
} from 'three'

import { overviewPose } from './camera'
import type { ScenePalette } from './palette'
import type { Site } from './site'

export const MINOR_GRID_M = 50
export const MAJOR_GRID_M = 250
/** The ground reaches this many times the site's size, so its edges are lost in the fog. */
export const GROUND_EXTENT = 4

/** Lines every `spacingM` across a square of `sizeM`, on the ground, both ways. */
export function gridLines(sizeM: number, spacingM: number): BufferGeometry {
  const half = sizeM / 2
  const positions: number[] = []
  for (let offset = -half; offset <= half + 1e-6; offset += spacingM) {
    positions.push(offset, 0, -half, offset, 0, half, -half, 0, offset, half, 0, offset)
  }
  return new BufferGeometry().setAttribute('position', new Float32BufferAttribute(positions, 3))
}

/**
 * The flat ground of a site without a model (FR-SCN-02): a plane, unlit as the
 * design asks, pushed back in depth so the grid on it never flickers, reaching
 * past the site into the fog, and a minor and a major grid over the site. Built
 * once per site, painted per theme.
 */
export function createGround(site: Site): Group {
  const size = site.halfSizeM * 2
  const plane = new Mesh(
    new PlaneGeometry(size * GROUND_EXTENT, size * GROUND_EXTENT),
    new MeshBasicMaterial({ polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }),
  )
  plane.name = 'ground'
  plane.rotation.x = -Math.PI / 2
  const minor = new LineSegments(gridLines(size, MINOR_GRID_M), new LineBasicMaterial())
  minor.name = 'grid-minor'
  const major = new LineSegments(gridLines(size, MAJOR_GRID_M), new LineBasicMaterial())
  major.name = 'grid-major'
  const ground = new Group()
  ground.add(plane, minor, major)
  return ground
}

type Part =
  Mesh<BufferGeometry, MeshBasicMaterial> | LineSegments<BufferGeometry, LineBasicMaterial>

/** The plane and the two grids createGround put in the group. */
export function groundParts(ground: Group): readonly Part[] {
  return ground.children as Part[]
}

export function paintGround(ground: Group, palette: ScenePalette): void {
  const colours: Readonly<Record<string, string>> = {
    ground: palette.ground,
    'grid-minor': palette.gridMinor,
    'grid-major': palette.gridMajor,
  }
  for (const part of groundParts(ground)) {
    const colour = colours[part.name]
    if (colour !== undefined) part.material.color.set(colour)
  }
}

/** The page colour behind the site, and fog that fades its far edge into it. */
export function paintSky(scene: Scene, palette: ScenePalette, site: Site): void {
  const overview = overviewPose(site).position.length()
  scene.background = new Color(palette.page)
  scene.fog = new Fog(palette.page, overview, overview * 1.6)
}

/** The flat ground shows only where no terrain was baked. */
export function showGround(ground: Group, shown: boolean): void {
  ground.visible = shown
}

export function disposeGround(ground: Group): void {
  for (const part of groundParts(ground)) {
    part.geometry.dispose()
    part.material.dispose()
  }
}
