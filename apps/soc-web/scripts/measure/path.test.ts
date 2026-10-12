// @vitest-environment node
import { join } from 'node:path'

import { CIRCLING_FROM_S } from '../../src/telemetry/replay'
import {
  AIRCRAFT,
  BUDGET_MS,
  PATH,
  SETTLE_MS,
  VIEWPORT,
  chromePath,
  dragCentre,
  measuredUrl,
  orbitMoves,
  parseArguments,
  pathSeconds,
  verdict,
} from './path.mjs'

const CONTEXT = {
  seconds: 60,
  theme: 'light',
  site: 'over the flat ground',
  gpu: 'Iris Xe',
  gpuBytes: 40 * 1024 * 1024,
}

describe("pnpm measure's path (NFR-PERF-06)", () => {
  it('is the requirement: 60 s, two aircraft, 1920×1080, 20 ms at p95', () => {
    expect(pathSeconds()).toBe(60)
    expect(AIRCRAFT).toBe(2)
    expect(VIEWPORT).toEqual({ width: 1920, height: 1080 })
    expect(BUDGET_MS).toBe(20)
    // It starts once both aircraft circle, gliding at every sample.
    expect(SETTLE_MS).toBeGreaterThan(CIRCLING_FROM_S * 1000)
  })

  it('opens two aircraft replayed, the statistics on and the first one selected', () => {
    const url = new URL(measuredUrl('http://localhost:4199'))
    expect(url.searchParams.get('replay')).toBe('2')
    expect(url.searchParams.has('stats')).toBe(true)
    expect([url.searchParams.get('gateway'), url.searchParams.get('aircraft')]).toEqual([
      'REPLAYDOCK',
      'REPLAYUAV',
    ])
  })

  it('keeps the camera moving through the whole path', () => {
    const actions = new Set(PATH.map(({ action }) => action))
    expect(actions).toEqual(new Set(['orbit', 'follow', 'tool']))
    expect(PATH.every(({ seconds }) => seconds > 0)).toBe(true)
  })

  it('drags across the scene the cards leave free, a move a frame', () => {
    const centre = dragCentre()
    expect(centre.x).toBeGreaterThan(92)
    expect(centre.x).toBeLessThan(VIEWPORT.width - 392)
    const moves = orbitMoves({ action: 'orbit', seconds: 2, across: 0.5, down: 0.2 })
    expect(moves).toHaveLength(121)
    expect(moves[60]).toEqual(centre)
    for (const move of moves) {
      expect(move.x).toBeGreaterThan(92)
      expect(move.x).toBeLessThan(VIEWPORT.width - 392)
      expect(move.y).toBeGreaterThan(0)
      expect(move.y).toBeLessThan(VIEWPORT.height)
    }
  })

  it('reads its arguments, and refuses what it does not know', () => {
    expect(parseArguments([])).toEqual({
      site: null,
      chrome: null,
      theme: 'light',
      shots: null,
      headed: false,
      serve: false,
      memory: false,
      minutes: 70,
    })
    expect(
      parseArguments(['--site', '/srv/site', '--theme', 'dark', '--headed', '--shots', '/s']),
    ).toEqual({
      site: '/srv/site',
      chrome: null,
      theme: 'dark',
      shots: '/s',
      headed: true,
      serve: false,
      memory: false,
      minutes: 70,
    })
    expect(parseArguments(['--memory', '--minutes', '5'])).toMatchObject({
      memory: true,
      minutes: 5,
    })
    expect(() => parseArguments(['--minutes', 'soon'])).toThrow('whole number of minutes')
    expect(parseArguments(['--serve', '--chrome', '/c'])).toMatchObject({
      serve: true,
      chrome: '/c',
    })
    expect(() => parseArguments(['--fast'])).toThrow('unknown argument --fast')
    expect(() => parseArguments(['--site'])).toThrow('--site needs a value')
    expect(() => parseArguments(['--site', '--headed'])).toThrow('--site needs a value')
    expect(() => parseArguments(['--theme', 'sepia'])).toThrow('light or dark')
  })

  it('finds Chrome on the PATH, or takes the one given', () => {
    const present = new Set([join('/opt/bin', 'chromium')])
    const exists = (file: string) => present.has(file)
    expect(chromePath(null, ['/usr/bin', '/opt/bin'].join(':'), exists)).toBe('/opt/bin/chromium')
    expect(() => chromePath(null, '/usr/bin', exists)).toThrow('--chrome <path>')
    expect(chromePath('/opt/bin/chromium', '', exists)).toBe('/opt/bin/chromium')
    expect(() => chromePath('/nowhere/chrome', '', exists)).toThrow('no Chrome at /nowhere/chrome')
  })

  it('passes at 20 ms and fails above, saying what it was measured on', () => {
    const within = verdict({ frames: 3600, p95Ms: 20, worstMs: 41.5 }, CONTEXT)
    expect(within.ok).toBe(true)
    expect(within.report).toContain('3600 frames (60.0 per second), p95 20.0 ms, worst 41.5 ms')
    expect(within.report).toContain('within the 20 ms budget')
    expect(within.report).toContain('GPU: Iris Xe')
    expect(within.report).toContain('1920×1080, light theme, over the flat ground')
    expect(verdict({ frames: 3000, p95Ms: 20.1, worstMs: 50 }, CONTEXT)).toMatchObject({
      ok: false,
    })
    expect(verdict(null, CONTEXT).ok).toBe(false)
    expect(
      verdict({ frames: 3600, p95Ms: 17, worstMs: 30 }, { ...CONTEXT, shots: true }).report,
    ).toMatch(/^Screenshots were taken along the path/)
    expect(verdict({ frames: 0, p95Ms: null, worstMs: null }, CONTEXT).ok).toBe(false)
  })

  it('reads what the scene holds on the GPU, and fails over 256 MB (NFR-RES-03)', () => {
    const run = { frames: 3600, p95Ms: 17, worstMs: 30 }
    expect(verdict(run, CONTEXT).report).toContain(
      'GPU memory (NFR-RES-03): 40.0 MB: within the 256.0 MB budget',
    )
    expect(verdict(run, { ...CONTEXT, gpuBytes: 257 * 1024 * 1024 }).ok).toBe(false)
    expect(verdict(run, { ...CONTEXT, gpuBytes: null }).ok).toBe(false)
  })
})
