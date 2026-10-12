// @vitest-environment node
import { Box3, Color, Texture, Vector3 } from 'three'

import { SITE } from '../test/site'
import type { ScenePalette } from './palette'
import {
  COARSE_FROM_M,
  createTerrain,
  disposeTerrain,
  paintTerrain,
  terrainGeometry,
  tintRamp,
} from './terrain'

const LIGHT: ScenePalette = {
  page: 'whitesmoke',
  ground: 'white',
  gridMinor: 'gainsboro',
  gridMajor: 'slategray',
  accent: 'teal',
  casing: 'darkslategray',
  aircraft: ['teal', 'royalblue', 'mediumpurple', 'hotpink', 'olivedrab', 'peru'],
}
const DARK: ScenePalette = {
  page: 'black',
  ground: 'dimgray',
  gridMinor: 'gray',
  gridMajor: 'silver',
  accent: 'teal',
  casing: 'whitesmoke',
  aircraft: ['teal', 'royalblue', 'mediumpurple', 'hotpink', 'olivedrab', 'peru'],
}
const hex = (name: string) => new Color(name).getHexString()

describe('the terrain (FR-SCN-02)', () => {
  it('lays the grid on the scene: north away from the camera, heights above the origin', () => {
    const geometry = terrainGeometry(SITE)
    const position = geometry.getAttribute('position')
    const vertex = (index: number) => new Vector3().fromBufferAttribute(position, index).toArray()
    expect(vertex(0)).toEqual([-100, 10, -100])
    expect(vertex(4)).toEqual([0, 0, 0])
    expect(vertex(8)).toEqual([100, -10, 100])
    expect((geometry.boundingBox ?? new Box3()).getSize(new Vector3()).y).toBe(20)
  })

  it("tints from the theme's darkest token to its lightest, so dark stays dark", () => {
    const light = tintRamp(LIGHT)
    const dark = tintRamp(DARK)
    expect([light.low.getHexString(), light.high.getHexString()]).toEqual([
      hex('slategray'),
      hex('white'),
    ])
    expect([dark.low.getHexString(), dark.high.getHexString()]).toEqual([
      hex('black'),
      hex('silver'),
    ])
  })

  it('draws every fourth vertex far off, where the full grid would only cost the frame', () => {
    expect(terrainGeometry(SITE, 4).getAttribute('position').count).toBe(4)
    const terrain = createTerrain(SITE, new Texture())
    expect(terrain.lod.levels.map(({ distance }) => distance)).toEqual([0, COARSE_FROM_M])
    disposeTerrain(terrain)
  })

  it('draws contours from heights above mean sea level, fogged, in the casing colour', () => {
    const terrain = createTerrain(SITE, new Texture())
    paintTerrain(terrain.material, DARK)
    expect(terrain.material.fog).toBe(true)
    expect(terrain.material.vertexShader).toContain('const float heightOffset = 690.000;')
    expect(terrain.material.fragmentShader).toContain('#include <colorspace_fragment>')
    // Level ground, where the MDT's whole metres can sit on a contour, draws none.
    expect(terrain.material.fragmentShader).toContain('smoothstep(0.010, 0.030, slope)')
    expect((terrain.material.uniforms.contour?.value as Color).getHexString()).toBe(
      hex('whitesmoke'),
    )
    disposeTerrain(terrain)
  })
})
