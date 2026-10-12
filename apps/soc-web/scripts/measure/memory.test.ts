// @vitest-environment node
import { GPU_BUDGET_BYTES as SCENE_GPU_BUDGET } from '../../src/scene/gpuMemory'
import {
  FROM_MINUTE,
  GPU_BUDGET_BYTES,
  HEAP_BUDGET_BYTES,
  HEAP_TREND_LIMIT,
  SESSION_MINUTES,
  heapTrend,
  inMegabytes,
  memoryVerdict,
} from './memory.mjs'

const MB = 1024 * 1024
const CONTEXT = { aircraft: 2, site: 'over the baked terrain', gpu: 'Iris Xe' }

/** A heap sampled each minute from 1 to `minutes`, `at(minute)` bytes. */
function sampled(minutes: number, at: (minute: number) => number) {
  return Array.from({ length: minutes }, (_, index) => ({
    minute: index + 1,
    bytes: at(index + 1),
  }))
}

describe("pnpm measure --memory's verdict (NFR-RES-02, NFR-RES-03)", () => {
  it('is the requirement: 150 MB of heap after 70 minutes, 5 % an hour, 256 MB on the GPU', () => {
    expect([HEAP_BUDGET_BYTES, HEAP_TREND_LIMIT, FROM_MINUTE, SESSION_MINUTES]).toEqual([
      150 * MB,
      0.05,
      10,
      70,
    ])
    expect(GPU_BUDGET_BYTES).toBe(SCENE_GPU_BUDGET)
  })

  it('takes the trend from minute 10 on, as a share of the heap there an hour', () => {
    // 60 MB at minute 10, growing 3 MB an hour: 5 % an hour.
    expect(heapTrend(sampled(70, (minute) => 60 * MB + ((minute - 10) * 3 * MB) / 60))).toBeCloseTo(
      0.05,
      6,
    )
    // The start-up's growth before minute 10 does not count.
    expect(heapTrend(sampled(70, (minute) => (minute < 10 ? minute * 10 * MB : 80 * MB)))).toBe(0)
    expect(heapTrend(sampled(10, () => 80 * MB))).toBeNull()
  })

  it('passes an hour that stays flat and small, and says by how much', () => {
    const { ok, report } = memoryVerdict(
      { heap: sampled(70, () => 62 * MB), gpuBytes: 40 * MB },
      CONTEXT,
    )
    expect(ok).toBe(true)
    expect(report).toContain('JavaScript heap after collection: 62.0 MB at minute 70: within')
    expect(report).toContain('Heap trend from minute 10: 0.0 % an hour: within')
    expect(report).toContain('GPU memory: 40.0 MB: within the 256.0 MB budget')
  })

  it('fails a heap over budget, a leak, the GPU over budget, or a session cut short', () => {
    const flat = sampled(70, () => 62 * MB)
    const passes = (heap: typeof flat, gpuBytes: number | null) =>
      memoryVerdict({ heap, gpuBytes }, CONTEXT).ok
    expect(
      passes(
        sampled(70, () => 151 * MB),
        40 * MB,
      ),
    ).toBe(false)
    expect(
      passes(
        sampled(70, (minute) => 60 * MB + minute * 0.1 * MB),
        40 * MB,
      ),
    ).toBe(false)
    expect(passes(flat, 257 * MB)).toBe(false)
    expect(passes(flat, null)).toBe(false)
    const short = memoryVerdict({ heap: sampled(20, () => 62 * MB), gpuBytes: 40 * MB }, CONTEXT)
    expect(short.ok).toBe(false)
    expect(short.report).toContain("Shorter than the requirement's 70 minutes")
    expect(memoryVerdict({ heap: [], gpuBytes: null }, CONTEXT)).toEqual({
      ok: false,
      report: 'No heap was measured.',
    })
  })

  it('writes bytes in megabytes', () => {
    expect(inMegabytes(150 * MB)).toBe('150.0 MB')
  })
})
