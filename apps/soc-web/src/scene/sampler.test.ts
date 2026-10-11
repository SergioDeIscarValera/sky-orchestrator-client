// @vitest-environment node
import { FrameSampler, IDLE_GAP_MS } from './sampler'

const INFO = { render: { calls: 3, triangles: 12 }, memory: { geometries: 4, textures: 0 } }

describe("the scene's frame sampler (NFR-PERF-06, NFR-RES-01)", () => {
  it('counts every rendered frame and keeps what the renderer reported', () => {
    const sampler = new FrameSampler()
    for (let frame = 0; frame < 3; frame += 1) sampler.record(16, INFO)
    expect(sampler.frames).toBe(3)
    expect([sampler.drawCalls, sampler.triangles, sampler.geometries]).toEqual([3, 12, 4])
  })

  it('takes the 95th percentile of the time between frames in motion', () => {
    const sampler = new FrameSampler()
    for (let frame = 1; frame <= 100; frame += 1) sampler.record(frame / 5, INFO)
    expect(sampler.frameTimeP95Ms()).toBe(19)
  })

  it('does not count the wait after an idle stretch as frame time', () => {
    const sampler = new FrameSampler()
    expect(sampler.frameTimeP95Ms()).toBeNull()
    sampler.record(IDLE_GAP_MS + 1, INFO)
    sampler.record(30_000, INFO)
    expect(sampler.frameTimeP95Ms()).toBeNull()
    expect(sampler.frames).toBe(2)
  })

  it('keeps every frame of a run, past the window, by the same rule', () => {
    const sampler = new FrameSampler()
    for (let frame = 0; frame < 50; frame += 1) sampler.record(90, INFO)
    sampler.startRun()
    for (let frame = 1; frame <= 2000; frame += 1) sampler.record(frame <= 1900 ? 16 : 30, INFO)
    sampler.record(IDLE_GAP_MS + 1, INFO)
    // The window holds only the last 600 frames, of which a sixth took 30 ms.
    expect(sampler.frameTimeP95Ms()).toBe(30)
    expect(sampler.endRun()).toEqual({ frames: 2001, p95Ms: 16, worstMs: 30 })
    expect(sampler.endRun()).toBeNull()
  })

  it('keeps a window of the latest frames', () => {
    const sampler = new FrameSampler()
    for (let frame = 0; frame < 1000; frame += 1) sampler.record(40, INFO)
    for (let frame = 0; frame < 600; frame += 1) sampler.record(10, INFO)
    expect(sampler.frameTimeP95Ms()).toBe(10)
  })
})
