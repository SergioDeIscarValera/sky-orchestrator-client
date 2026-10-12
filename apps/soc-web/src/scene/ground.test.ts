// @vitest-environment node
import { Color, Fog, Scene, type Group, type PlaneGeometry } from 'three'

import {
  GROUND_EXTENT,
  MAJOR_GRID_M,
  MINOR_GRID_M,
  createGround,
  disposeGround,
  gridLines,
  groundParts,
  paintGround,
  paintSky,
} from './ground'
import type { ScenePalette } from './palette'
import { FLAT_SITE } from './site'

const LIGHT: ScenePalette = {
  page: 'white',
  ground: 'ivory',
  gridMinor: 'gainsboro',
  gridMajor: 'gray',
  accent: 'teal',
  danger: 'tomato',
  casing: 'darkslategray',
  aircraft: ['teal', 'royalblue', 'mediumpurple', 'hotpink', 'olivedrab', 'peru'],
}
const DARK: ScenePalette = { ...LIGHT, page: 'black', ground: 'dimgray', gridMinor: 'slategray' }

function named(ground: Group, name: string) {
  const found = groundParts(ground).find((part) => part.name === name)
  if (found === undefined) throw new Error(`no ${name} in the ground`)
  return found
}

const colourOf = (ground: Group, name: string) => named(ground, name).material.color.getHexString()

describe('the flat ground (FR-SCN-02)', () => {
  it('reaches past the site, flat, with a minor and a major grid over the site', () => {
    const ground = createGround(FLAT_SITE)
    const plane = named(ground, 'ground')
    expect((plane.geometry as PlaneGeometry).parameters).toMatchObject({
      width: 2000 * GROUND_EXTENT,
      height: 2000 * GROUND_EXTENT,
    })
    expect(plane.rotation.x).toBeCloseTo(-Math.PI / 2)
    const lines = (name: string) => named(ground, name).geometry.getAttribute('position').count / 4
    expect(lines('grid-minor')).toBe(2000 / MINOR_GRID_M + 1)
    expect(lines('grid-major')).toBe(2000 / MAJOR_GRID_M + 1)
  })

  it('draws its lines from edge to edge of the site, at ground level', () => {
    const positions = gridLines(100, 50).getAttribute('position')
    const values = Array.from(positions.array)
    expect(Math.min(...values)).toBe(-50)
    expect(Math.max(...values)).toBe(50)
    for (let vertex = 0; vertex < positions.count; vertex += 1)
      expect(positions.getY(vertex)).toBe(0)
  })

  it("is unlit and painted in the theme's tokens, then repainted for another", () => {
    const ground = createGround(FLAT_SITE)
    paintGround(ground, LIGHT)
    expect(named(ground, 'ground').material).toMatchObject({
      type: 'MeshBasicMaterial',
      polygonOffset: true,
    })
    expect(colourOf(ground, 'ground')).toBe(new Color('ivory').getHexString())
    expect(colourOf(ground, 'grid-major')).toBe(new Color('gray').getHexString())
    paintGround(ground, DARK)
    expect(colourOf(ground, 'ground')).toBe(new Color('dimgray').getHexString())
    expect(colourOf(ground, 'grid-minor')).toBe(new Color('slategray').getHexString())
  })

  it('sets the page colour behind the site and fades the far edge into it', () => {
    const scene = new Scene()
    paintSky(scene, DARK, FLAT_SITE)
    expect((scene.background as Color).getHexString()).toBe('000000')
    const fog = scene.fog as Fog
    expect(fog.color.getHexString()).toBe('000000')
    expect(fog.far).toBeGreaterThan(fog.near)
  })

  it('gives its geometry and materials back when it goes', () => {
    const ground = createGround(FLAT_SITE)
    let disposed = 0
    for (const part of groundParts(ground)) {
      part.geometry.addEventListener('dispose', () => (disposed += 1))
      part.material.addEventListener('dispose', () => (disposed += 1))
    }
    disposeGround(ground)
    expect(disposed).toBe(6)
  })
})
