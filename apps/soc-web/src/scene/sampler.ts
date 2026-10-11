/** Frames longer apart than this are the scene waking up from idle, not frame time. */
export const IDLE_GAP_MS = 250
const WINDOW = 600

export interface RendererInfo {
  readonly render: { readonly calls: number; readonly triangles: number }
  readonly memory: { readonly geometries: number; readonly textures: number }
}

/**
 * The scene's frame-time sampler (NFR-PERF-06, NFR-RES-01, NFR-OBS-05): frames
 * rendered, the time between consecutive frames while the scene moves, and what
 * the renderer last drew and holds.
 */
export class FrameSampler {
  frames = 0
  drawCalls = 0
  triangles = 0
  geometries = 0
  textures = 0
  private readonly intervals = new Float64Array(WINDOW)
  private recorded = 0

  record(sinceLastFrameMs: number, info: RendererInfo): void {
    this.frames += 1
    if (sinceLastFrameMs > 0 && sinceLastFrameMs <= IDLE_GAP_MS) {
      this.intervals[this.recorded % WINDOW] = sinceLastFrameMs
      this.recorded += 1
    }
    this.drawCalls = info.render.calls
    this.triangles = info.render.triangles
    this.geometries = info.memory.geometries
    this.textures = info.memory.textures
  }

  /** The 95th percentile of the recent frame times, or null before any motion. */
  frameTimeP95Ms(): number | null {
    const count = Math.min(this.recorded, WINDOW)
    if (count === 0) return null
    const sorted = Array.from(this.intervals.subarray(0, count)).sort((a, b) => a - b)
    return sorted[Math.min(count - 1, Math.ceil(count * 0.95) - 1)] ?? null
  }
}

export const sampler = new FrameSampler()
