import {
  InstancedMesh,
  LinearMipmapLinearFilter,
  LinearMipmapNearestFilter,
  Mesh,
  NearestMipmapLinearFilter,
  NearestMipmapNearestFilter,
  type BufferGeometry,
  type Material,
  type Object3D,
  type ShaderMaterial,
  type Texture,
} from 'three'

/** What the scene holds on the GPU (NFR-RES-03): its geometries and textures, and their bytes. */
export interface GpuMemory {
  readonly geometries: number
  readonly textures: number
  readonly bytes: number
}

/** NFR-RES-03: textures and buffers at most this many bytes. */
export const GPU_BUDGET_BYTES = 256 * 1024 * 1024

const MIPMAPPED = new Set<number>([
  NearestMipmapNearestFilter,
  NearestMipmapLinearFilter,
  LinearMipmapNearestFilter,
  LinearMipmapLinearFilter,
])

/** The bytes of a geometry's attributes and index, as uploaded. */
export function geometryBytes(geometry: BufferGeometry): number {
  let bytes = geometry.index?.array.byteLength ?? 0
  for (const attribute of Object.values(geometry.attributes)) {
    bytes += attribute.array.byteLength
  }
  return bytes
}

interface Pixels {
  readonly width?: number
  readonly height?: number
  readonly data?: ArrayBufferView
}

/**
 * The bytes of a texture's image: its data as given, or four bytes a pixel for an image
 * WebGL uploads as RGBA; a third more when mipmaps are generated for it.
 */
export function textureBytes(texture: Texture): number {
  const image = texture.image as Pixels | null | undefined
  if (image === null || image === undefined) return 0
  const base =
    image.data === undefined ? (image.width ?? 0) * (image.height ?? 0) * 4 : image.data.byteLength
  const mipmapped = texture.generateMipmaps && MIPMAPPED.has(texture.minFilter)
  return mipmapped ? Math.ceil((base * 4) / 3) : base
}

const isTexture = (value: unknown): value is Texture =>
  (value as Partial<Texture> | null)?.isTexture === true

/** A material's textures: its maps, and a shader's in its uniforms, as the terrain's imagery is. */
function texturesOf(material: Material): Texture[] {
  const uniforms = (material as Partial<ShaderMaterial>).uniforms ?? {}
  return [
    ...Object.values(material).filter(isTexture),
    ...Object.values(uniforms)
      .map((uniform) => uniform.value as unknown)
      .filter(isTexture),
  ]
}

/**
 * What everything under `root` holds on the GPU, each geometry and texture counted once
 * however many objects share it, an instanced mesh's matrices and colours with them.
 */
export function gpuMemory(root: Object3D): GpuMemory {
  const geometries = new Set<BufferGeometry>()
  const textures = new Set<Texture>()
  let instanceBytes = 0
  root.traverse((object) => {
    const drawn = object as Partial<Mesh>
    if (drawn.geometry !== undefined) geometries.add(drawn.geometry)
    if (drawn.material !== undefined) {
      for (const material of [drawn.material].flat()) {
        for (const texture of texturesOf(material)) textures.add(texture)
      }
    }
    if (object instanceof InstancedMesh) {
      instanceBytes += object.instanceMatrix.array.byteLength
      instanceBytes += object.instanceColor?.array.byteLength ?? 0
    }
  })
  let bytes = instanceBytes
  for (const geometry of geometries) bytes += geometryBytes(geometry)
  for (const texture of textures) bytes += textureBytes(texture)
  return { geometries: geometries.size, textures: textures.size, bytes }
}
