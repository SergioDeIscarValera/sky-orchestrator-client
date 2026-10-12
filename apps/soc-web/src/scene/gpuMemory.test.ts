// @vitest-environment node
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  DataTexture,
  Group,
  InstancedMesh,
  LinearFilter,
  Mesh,
  MeshBasicMaterial,
  ShaderMaterial,
  Texture,
} from 'three'

import { geometryBytes, gpuMemory, GPU_BUDGET_BYTES, textureBytes } from './gpuMemory'

/** A texture over an image of `width` × `height`, as a loaded picture would be. */
function picture(width: number, height: number): Texture {
  const texture = new Texture()
  texture.image = { width, height }
  return texture
}

describe("the scene's memory on the GPU (NFR-RES-03, NFR-OBS-05)", () => {
  it('is the requirement: 256 MB', () => {
    expect(GPU_BUDGET_BYTES).toBe(268_435_456)
  })

  it("counts a geometry's attributes and index as uploaded", () => {
    const geometry = new BufferGeometry()
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(9), 3))
    geometry.setAttribute('uv', new BufferAttribute(new Float32Array(6), 2))
    geometry.setIndex(new BufferAttribute(new Uint16Array(3), 1))
    expect(geometryBytes(geometry)).toBe(36 + 24 + 6)
  })

  it('counts an image as RGBA, its mipmaps a third more, and data as it is', () => {
    const mipmapped = picture(1024, 512)
    expect(textureBytes(mipmapped)).toBe(Math.ceil((1024 * 512 * 4 * 4) / 3))
    const flat = picture(1024, 512)
    flat.minFilter = LinearFilter
    expect(textureBytes(flat)).toBe(1024 * 512 * 4)
    const heights = new DataTexture(new Float32Array(256 * 256), 256, 256)
    expect(textureBytes(heights)).toBe(256 * 256 * 4)
    expect(textureBytes(new Texture())).toBe(0)
  })

  it('counts each geometry and texture once however many objects share them', () => {
    const geometry = new BoxGeometry()
    const ground = picture(64, 64)
    ground.minFilter = LinearFilter
    const material = new MeshBasicMaterial({ map: ground, alphaMap: ground })
    const scene = new Group()
    scene.add(new Mesh(geometry, material), new Mesh(geometry, [material, material]))
    expect(gpuMemory(scene)).toEqual({
      geometries: 1,
      textures: 1,
      bytes: geometryBytes(geometry) + 64 * 64 * 4,
    })
  })

  it("finds a shader's textures in its uniforms, as the terrain's imagery is", () => {
    const geometry = new BoxGeometry()
    const imagery = picture(2048, 2048)
    imagery.minFilter = LinearFilter
    const scene = new Group()
    scene.add(new Mesh(geometry, new ShaderMaterial({ uniforms: { imagery: { value: imagery } } })))
    expect(gpuMemory(scene)).toEqual({
      geometries: 1,
      textures: 1,
      bytes: geometryBytes(geometry) + 2048 * 2048 * 4,
    })
  })

  it("adds an instanced mesh's matrices and colours", () => {
    const geometry = new BoxGeometry()
    const instances = new InstancedMesh(geometry, new MeshBasicMaterial(), 10)
    instances.setColorAt(0, new Color('teal'))
    const scene = new Group()
    scene.add(instances)
    expect(gpuMemory(scene).bytes).toBe(geometryBytes(geometry) + 10 * 16 * 4 + 10 * 3 * 4)
  })
})
