import {
  Color,
  LOD,
  Mesh,
  PlaneGeometry,
  ShaderMaterial,
  UniformsLib,
  UniformsUtils,
  type Texture,
} from 'three'

import type { ScenePalette } from './palette'
import type { LoadedSite } from './siteModel'

/** Contours every 5 m, faint, and an index contour every 25 m, a little stronger (the design system). */
export const MINOR_CONTOUR_M = 5
export const INDEX_CONTOUR_M = 25
/** Below this slope (1 %) the ground counts as level and draws no contour. */
export const FLAT_SLOPE = 0.01
/** How much of PNOA's own luminance shows through the theme's tint. */
export const ORIGINAL_SHARE = 0.2

/**
 * The terrain's grid on the scene's frame: x east, z south, y the height above the
 * ground at the origin, so the site's origin stays where the flat ground had it.
 * PlaneGeometry's rows run from its top edge, which faces north once laid down,
 * as the baked rows do.
 */
export function terrainGeometry(site: LoadedSite, stride = 1): PlaneGeometry {
  const { half_size_m: half, elevation } = site.model
  const segments = Math.ceil((elevation.vertices - 1) / stride)
  const geometry = new PlaneGeometry(half * 2, half * 2, segments, segments).rotateX(-Math.PI / 2)
  const position = geometry.getAttribute('position')
  for (let index = 0; index < position.count; index += 1) {
    const row = Math.min(Math.floor(index / (segments + 1)) * stride, elevation.vertices - 1)
    const column = Math.min((index % (segments + 1)) * stride, elevation.vertices - 1)
    const height = site.heights[row * elevation.vertices + column] ?? elevation.at_origin_m
    position.setY(index, height - elevation.at_origin_m)
  }
  position.needsUpdate = true
  geometry.computeBoundingBox()
  geometry.computeBoundingSphere()
  return geometry
}

function luminance(colour: Color): number {
  return 0.2126 * colour.r + 0.7152 * colour.g + 0.0722 * colour.b
}

/**
 * The tint's ramp from the theme's tokens: from the darkest to the lightest of the
 * page, the ground and the muted colour, so a dark theme keeps shadows dark.
 */
export function tintRamp(palette: ScenePalette): { readonly low: Color; readonly high: Color } {
  const candidates = [palette.page, palette.ground, palette.gridMajor].map(
    (token) => new Color(token),
  )
  const sorted = [...candidates].sort((a, b) => luminance(a) - luminance(b))
  const low = sorted[0] ?? new Color(palette.page)
  const high = sorted.at(-1) ?? new Color(palette.ground)
  return { low, high }
}

/** The vertex stage; `heightOffset` lifts the scene's heights back to above mean sea level. */
const vertexShader = (heightOffset: number) => /* glsl */ `
#include <fog_pars_vertex>
const float heightOffset = ${heightOffset.toFixed(3)};
varying vec2 vUv;
varying float vHeight;
varying vec2 vGround;
void main() {
  vUv = uv;
  vHeight = position.y + heightOffset;
  vGround = position.xz;
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`

const FRAGMENT = /* glsl */ `
#include <fog_pars_fragment>
uniform sampler2D imagery;
uniform vec3 low;
uniform vec3 high;
uniform vec3 contour;
uniform float originalShare;
varying vec2 vUv;
varying float vHeight;
varying vec2 vGround;

float line(float height, float step) {
  float across = height / step;
  float distance = abs(fract(across - 0.5) - 0.5) / max(fwidth(across), 1e-4);
  return 1.0 - clamp(distance, 0.0, 1.0);
}

void main() {
  float lum = texture2D(imagery, vUv).r;
  vec3 colour = mix(mix(low, high, lum), vec3(lum), originalShare);
  // The MDT rounds flat ground to whole metres, so a plateau can sit exactly on a
  // contour's height: contours fade out where the ground is nearly level.
  float rise = length(vec2(dFdx(vHeight), dFdy(vHeight)));
  float run = length(vec2(length(dFdx(vGround)), length(dFdy(vGround))));
  float slope = rise / max(run, 1e-4);
  float sloped = smoothstep(${FLAT_SLOPE.toFixed(3)}, ${(FLAT_SLOPE * 3).toFixed(3)}, slope);
  float strength = sloped * max(line(vHeight, ${MINOR_CONTOUR_M.toFixed(1)}) * 0.18, line(vHeight, ${INDEX_CONTOUR_M.toFixed(1)}) * 0.45);
  gl_FragColor = vec4(mix(colour, contour, strength), 1.0);
  #include <fog_fragment>
  #include <colorspace_fragment>
}
`

export type TerrainMaterial = ShaderMaterial

/**
 * The terrain's look (ADR-0018, the design system): PNOA's luminance, the hillshade
 * baked in, tinted between the theme's darkest and lightest tokens with a small
 * share of the original, and contours drawn from the height, unlit and fogged.
 */
export function terrainMaterial(imagery: Texture, heightOffset: number): TerrainMaterial {
  return new ShaderMaterial({
    uniforms: UniformsUtils.merge([
      UniformsLib.fog,
      {
        imagery: { value: imagery },
        low: { value: new Color() },
        high: { value: new Color() },
        contour: { value: new Color() },
        originalShare: { value: ORIGINAL_SHARE },
      },
    ]),
    vertexShader: vertexShader(heightOffset),
    fragmentShader: FRAGMENT,
    fog: true,
  })
}

export function paintTerrain(material: TerrainMaterial, palette: ScenePalette): void {
  const { low, high } = tintRamp(palette)
  ;(material.uniforms.low?.value as Color).copy(low)
  ;(material.uniforms.high?.value as Color).copy(high)
  ;(material.uniforms.contour?.value as Color).set(palette.casing)
}

/** Farther than this from the camera, the terrain is drawn from every fourth vertex. */
export const COARSE_FROM_M = 2500
const COARSE_STRIDE = 4

export interface Terrain {
  readonly lod: LOD
  readonly material: TerrainMaterial
  readonly geometries: readonly PlaneGeometry[]
}

/**
 * The terrain at two levels of detail sharing one material: the whole grid near,
 * every fourth vertex far, where the full grid's triangles shrink to a pixel or two
 * and cost the frame without showing (NFR-PERF-06).
 */
export function createTerrain(site: LoadedSite, imagery: Texture): Terrain {
  // Contours follow the ground's height above mean sea level, not above the origin.
  const material = terrainMaterial(imagery, site.model.elevation.at_origin_m)
  const geometries = [terrainGeometry(site), terrainGeometry(site, COARSE_STRIDE)]
  const lod = new LOD()
  lod.name = 'terrain'
  geometries.forEach((geometry, level) => {
    lod.addLevel(new Mesh(geometry, material), level === 0 ? 0 : COARSE_FROM_M)
  })
  return { lod, material, geometries }
}

export function disposeTerrain(terrain: Terrain): void {
  for (const geometry of terrain.geometries) geometry.dispose()
  terrain.material.dispose()
}
