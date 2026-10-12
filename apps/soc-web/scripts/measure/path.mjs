// The frame-time measurement of NFR-PERF-06: what `pnpm measure` asks for, the scripted
// 60 s camera path it drives through the console's own controls, and its verdict. The
// browser and the servers are run.mjs's; everything here is plain and tested.
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'

import { GPU_BUDGET_BYTES, inMegabytes } from './memory.mjs'

/** NFR-PERF-06: frame time at p95, in milliseconds. */
export const BUDGET_MS = 20
/** NFR-PERF-06's viewport. */
export const VIEWPORT = Object.freeze({ width: 1920, height: 1080 })
/** NFR-PERF-06's live telemetry: two aircraft (the replay's `?replay=2`). */
export const AIRCRAFT = 2
/** The replay's aircraft circle from 7 s on (replay.ts); the path starts once both do. */
export const SETTLE_MS = 8000
/** The cards over the scene, in CSS pixels: the rail on the left, the inspector on the right. */
const RAIL_PX = 92
const INSPECTOR_PX = 392

/**
 * The scripted camera path, 60 s in all, through the controls an operator uses, with
 * the first aircraft selected so its inspector updates at every sample throughout.
 */
export const PATH = Object.freeze([
  { action: 'orbit', seconds: 12, across: 0.5, down: 0 },
  { action: 'follow', seconds: 14 },
  { action: 'tool', label: 'Back to the site overview', seconds: 3 },
  { action: 'tool', label: 'Closer', seconds: 1 },
  { action: 'tool', label: 'Closer', seconds: 1 },
  { action: 'tool', label: 'Closer', seconds: 1 },
  { action: 'orbit', seconds: 12, across: -0.4, down: 0.15 },
  { action: 'tool', label: 'Farther', seconds: 1 },
  { action: 'tool', label: 'Farther', seconds: 1 },
  { action: 'tool', label: 'Farther', seconds: 1 },
  { action: 'orbit', seconds: 13, across: 0.4, down: -0.15 },
])

/** The path's length in seconds. */
export function pathSeconds(path = PATH) {
  return path.reduce((total, step) => total + step.seconds, 0)
}

/** The page the measurement opens: two aircraft replayed, the statistics on, the first selected. */
export function measuredUrl(base) {
  const url = new URL('/', base)
  url.search = `replay=${AIRCRAFT}&stats&gateway=REPLAYDOCK&aircraft=REPLAYUAV`
  return url.href
}

/**
 * The middle of the scene that the rail and the inspector leave free, where a drag
 * turns the camera.
 */
export function dragCentre(viewport = VIEWPORT) {
  return {
    x: RAIL_PX + (viewport.width - RAIL_PX - INSPECTOR_PX) / 2,
    y: viewport.height / 2,
  }
}

/**
 * The pointer's positions for an orbit `seconds` long, one per frame at 60 Hz: from
 * half of `across` (a share of the free width) one side of the centre to half the
 * other, and as much of `down` (a share of the height) between.
 */
export function orbitMoves(step, viewport = VIEWPORT) {
  const centre = dragCentre(viewport)
  const width = viewport.width - RAIL_PX - INSPECTOR_PX
  const count = Math.max(1, Math.round(step.seconds * 60))
  const moves = []
  for (let index = 0; index <= count; index += 1) {
    const share = index / count - 0.5
    moves.push({
      x: centre.x + share * step.across * width,
      y: centre.y + share * step.down * viewport.height,
    })
  }
  return moves
}

const OPTIONS = new Map([
  ['--site', 'site'],
  ['--chrome', 'chrome'],
  ['--theme', 'theme'],
  ['--shots', 'shots'],
  ['--minutes', 'minutes'],
])

/**
 * `pnpm measure`'s arguments: `--site <dir>`, `--chrome <path>`, `--theme light|dark`,
 * `--shots <dir>` (a screenshot after each step, which costs the frames it is taken in),
 * `--headed`, `--serve`, and `--memory` with `--minutes <n>` (NFR-RES-02's session,
 * 70 minutes unless told otherwise).
 */
export function parseArguments(argv) {
  const parsed = {
    site: null,
    chrome: null,
    theme: 'light',
    shots: null,
    headed: false,
    serve: false,
    memory: false,
    minutes: '70',
  }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--headed' || argument === '--serve' || argument === '--memory') {
      parsed[argument.slice(2)] = true
      continue
    }
    const key = OPTIONS.get(argument)
    const value = argv[index + 1]
    if (key === undefined) throw new Error(`unknown argument ${argument}`)
    if (value === undefined || value.startsWith('--')) throw new Error(`${argument} needs a value`)
    parsed[key] = value
    index += 1
  }
  if (parsed.theme !== 'light' && parsed.theme !== 'dark') {
    throw new Error(`--theme is light or dark, not ${parsed.theme}`)
  }
  const minutes = Number(parsed.minutes)
  if (!Number.isInteger(minutes) || minutes < 1) {
    throw new Error(`--minutes is a whole number of minutes, not ${parsed.minutes}`)
  }
  return { ...parsed, minutes }
}

const CHROMES = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']

/** The Chrome to drive: the one given, or the first of the usual names on the PATH. */
export function chromePath(given, path = process.env.PATH ?? '', exists = existsSync) {
  if (given !== null) {
    if (!exists(given)) throw new Error(`no Chrome at ${given}`)
    return given
  }
  for (const directory of path.split(delimiter).filter(Boolean)) {
    for (const name of CHROMES) {
      const candidate = join(directory, name)
      if (exists(candidate)) return candidate
    }
  }
  throw new Error(`no Chrome on the PATH (${CHROMES.join(', ')}); give one with --chrome <path>`)
}

/** Whether the run kept to NFR-PERF-06, and the report that says so. */
export function verdict(run, context) {
  if (run === null || run.p95Ms === null) {
    return { ok: false, report: 'No frame was measured: the scene did not move.' }
  }
  const perSecond = run.frames / context.seconds
  const gpuBytes = context.gpuBytes ?? null
  const gpuOk = gpuBytes !== null && gpuBytes <= GPU_BUDGET_BYTES
  const ok = run.p95Ms <= BUDGET_MS && gpuOk
  const lines = [
    ...(context.shots
      ? ['Screenshots were taken along the path: the figures include their cost.']
      : []),
    `NFR-PERF-06: the scripted ${String(context.seconds)} s camera path, ${String(AIRCRAFT)} aircraft at 5 Hz, ${String(VIEWPORT.width)}×${String(VIEWPORT.height)}, ${context.theme} theme, ${context.site}`,
    `GPU: ${context.gpu}`,
    `${String(run.frames)} frames (${perSecond.toFixed(1)} per second), p95 ${run.p95Ms.toFixed(1)} ms, worst ${(run.worstMs ?? run.p95Ms).toFixed(1)} ms: ${run.p95Ms <= BUDGET_MS ? 'within' : 'over'} the ${String(BUDGET_MS)} ms budget`,
    gpuBytes === null
      ? 'GPU memory (NFR-RES-03): not measured'
      : `GPU memory (NFR-RES-03): ${inMegabytes(gpuBytes)}: ${gpuOk ? 'within' : 'over'} the ${inMegabytes(GPU_BUDGET_BYTES)} budget`,
  ]
  return { ok, report: lines.join('\n') }
}
