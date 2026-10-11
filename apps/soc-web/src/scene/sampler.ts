/** Frames longer apart than this are the scene waking up from idle, not frame time. */
export const IDLE_GAP_MS = 250
const WINDOW = 600

export interface RendererInfo {
  readonly render: { readonly calls: number; readonly triangles: number }
  readonly memory: { readonly geometries: number; readonly textures: number }
}

/** A scripted measurement's frames: how many, and the p95 and the worst of their frame times. */
export interface Run {
  readonly frames: number
  readonly p95Ms: number | null
  readonly worstMs: number | null
}

/** The nearest rank of the 95th percentile, the value at ceil(0.95 * count). */
function p95(values: ArrayLike<number>): number | null {
  if (values.length === 0) return null
  const sorted = Array.from(values).sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] ?? null
}

/**
 * The scene's frame-time sampler (NFR-PERF-06, NFR-RES-01, NFR-OBS-05): frames
 * rendered, the time between consecutive frames while the scene moves, and what
 * the renderer last drew and holds. A run keeps every frame time from its start,
 * for a scripted measurement longer than the window (`pnpm measure`).
 */
export class FrameSampler {
  frames = 0
  drawCalls = 0
  triangles = 0
  geometries = 0
  textures = 0
  private readonly intervals = new Float64Array(WINDOW)
  private recorded = 0
  private run: { frames: number; intervals: number[] } | null = null

  record(sinceLastFrameMs: number, info: RendererInfo): void {
    this.frames += 1
    if (this.run !== null) this.run.frames += 1
    if (sinceLastFrameMs > 0 && sinceLastFrameMs <= IDLE_GAP_MS) {
      this.intervals[this.recorded % WINDOW] = sinceLastFrameMs
      this.recorded += 1
      this.run?.intervals.push(sinceLastFrameMs)
    }
    this.drawCalls = info.render.calls
    this.triangles = info.render.triangles
    this.geometries = info.memory.geometries
    this.textures = info.memory.textures
  }

  /** The 95th percentile of the recent frame times, or null before any motion. */
  frameTimeP95Ms(): number | null {
    return p95(this.intervals.subarray(0, Math.min(this.recorded, WINDOW)))
  }

  /** Starts a run afresh: every frame from now on counts, however many. */
  startRun(): void {
    this.run = { frames: 0, intervals: [] }
  }

  /** Ends the run: its frames, by the same rule as the window; null when none was started. */
  endRun(): Run | null {
    const run = this.run
    this.run = null
    if (run === null) return null
    return {
      frames: run.frames,
      p95Ms: p95(run.intervals),
      worstMs: run.intervals.length === 0 ? null : Math.max(...run.intervals),
    }
  }
}

export const sampler = new FrameSampler()
