// `pnpm measure`: NFR-PERF-06 on the production build. It builds the console in the
// measurement mode (production React, with the replay kept), serves it with `vite
// preview` against the demo's fake Supabase, and drives Chrome along path.mjs's
// scripted path while the scene's own frame sampler measures every frame. `--serve`
// only serves it, to look by hand; `--site <dir>` serves the site models there, as
// SOC_SITE_DIR does for the dev server.
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { platform, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { chromium } from 'playwright-core'

import { startFakeSupabase } from '../demo/fake-supabase.mjs'
import { DEMO_SETTINGS, demoSupabaseKey, stopGroup } from '../demo/run.mjs'
import {
  PATH,
  SETTLE_MS,
  VIEWPORT,
  chromePath,
  measuredUrl,
  orbitMoves,
  parseArguments,
  pathSeconds,
  verdict,
} from './path.mjs'

const APP = fileURLToPath(new URL('../../', import.meta.url))
const OUT = 'dist-measure'
const PREVIEW_PORT = 4199
const PREVIEW = `http://localhost:${String(PREVIEW_PORT)}`
const READY_TIMEOUT_MS = 30_000

/** Runs a command to its end, its output shown only when it fails. */
function run(command, args) {
  return new Promise((done, fail) => {
    const child = spawn(command, args, { cwd: APP, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', (chunk) => (output += chunk))
    child.stderr.on('data', (chunk) => (output += chunk))
    child.once('error', fail)
    child.once('exit', (code) => {
      if (code === 0) done()
      else fail(new Error(`${command} ${args.join(' ')} failed:\n${output}`))
    })
  })
}

/** Whether the build kept the replay, without which nothing flies. */
function replayKept() {
  const manifest = JSON.parse(readFileSync(join(APP, OUT, '.vite/manifest.json'), 'utf8'))
  return Object.values(manifest).some((chunk) => chunk.src === 'src/telemetry/replay.ts')
}

async function waitUntilServed(url) {
  const deadline = Date.now() + READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    const answered = await fetch(url).then(
      (response) => response.ok,
      () => false,
    )
    if (answered) return
    await new Promise((done) => setTimeout(done, 200))
  }
  throw new Error(`${url} did not answer within ${String(READY_TIMEOUT_MS / 1000)} s`)
}

/** Drives the console along the path, each step paced to its length. */
async function drive(page, shots) {
  for (const [number, step] of PATH.entries()) {
    const started = Date.now()
    if (step.action === 'orbit') {
      const moves = orbitMoves(step)
      await page.mouse.move(moves[0].x, moves[0].y)
      await page.mouse.down()
      for (const [index, move] of moves.entries()) {
        await page.mouse.move(move.x, move.y)
        const wait = started + (index * step.seconds * 1000) / (moves.length - 1) - Date.now()
        if (wait > 0) await page.waitForTimeout(wait)
      }
      await page.mouse.up()
    } else if (step.action === 'follow') {
      // A selection is followed already, and orbiting keeps it: follow only if let go.
      const follow = page.getByRole('button', { name: 'Follow', exact: true, pressed: false })
      if ((await follow.count()) > 0) await follow.click()
    } else {
      await page.getByRole('button', { name: step.label, exact: true }).click()
    }
    const left = started + step.seconds * 1000 - Date.now()
    if (left > 0) await page.waitForTimeout(left)
    if (shots !== null) {
      await page.screenshot({
        path: join(shots, `${String(number + 1).padStart(2, '0')}-${step.action}.png`),
      })
    }
  }
}

// The functions given to page.evaluate run in the page, where globalThis is its window.

/** The GPU WebGL reports, so a figure always says what it was measured on. */
function gpuOf(page) {
  return page.evaluate(() => {
    const gl = globalThis.document.createElement('canvas').getContext('webgl2')
    if (gl === null) return 'no WebGL 2'
    const debug = gl.getExtension('WEBGL_debug_renderer_info')
    return String(gl.getParameter(debug === null ? gl.RENDERER : debug.UNMASKED_RENDERER_WEBGL))
  })
}

async function measure(options) {
  const browser = await chromium.launch({
    executablePath: chromePath(options.chrome),
    headless: !options.headed,
    // The GPU, never the software rasteriser Chrome falls back to without a display.
    args: [
      '--enable-gpu',
      '--ignore-gpu-blocklist',
      ...(platform() === 'linux' ? ['--use-angle=gl'] : []),
    ],
  })
  try {
    const page = await browser.newPage({
      viewport: VIEWPORT,
      deviceScaleFactor: 1,
      colorScheme: options.theme,
    })
    await page.goto(measuredUrl(PREVIEW))
    await page.getByLabel('Email').fill('pilot@farm.test')
    await page.getByLabel('Password').fill('measure')
    await page.getByRole('button', { name: 'Sign in' }).click()
    await page.getByRole('button', { name: /Finca Norte/ }).click()
    await page.waitForTimeout(SETTLE_MS)
    const terrain = await page.getByText(/Instituto Geográfico Nacional/).isVisible()
    const gpu = await gpuOf(page)
    await page.evaluate(() => {
      globalThis.socScene.startRun()
    })
    if (options.shots !== null) mkdirSync(options.shots, { recursive: true })
    await drive(page, options.shots)
    const result = await page.evaluate(() => globalThis.socScene.endRun())
    return verdict(result, {
      seconds: pathSeconds(),
      theme: options.theme,
      site: terrain ? 'over the baked terrain' : 'over the flat ground',
      gpu,
      shots: options.shots !== null,
    })
  } finally {
    await browser.close()
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  console.log('Building the console in the measurement mode…')
  await run('pnpm', [
    'exec',
    'vite',
    'build',
    '--mode',
    'measure',
    '--outDir',
    OUT,
    '--emptyOutDir',
  ])
  if (!replayKept()) throw new Error('the measurement build lost the replay: nothing would fly')

  const fake = await startFakeSupabase()
  const directory = mkdtempSync(join(tmpdir(), 'soc-measure-'))
  const settings = join(directory, 'soc-web.json')
  writeFileSync(settings, `${JSON.stringify(DEMO_SETTINGS, null, 2)}\n`)
  const environment = {
    ...process.env,
    SOC_WEB_SUPABASE_URL: fake.url,
    SOC_WEB_SUPABASE_KEY: demoSupabaseKey(),
    SOC_CONFIG_FILE: settings,
  }
  if (options.site !== null) environment.SOC_SITE_DIR = resolve(options.site)
  const preview = spawn(
    'pnpm',
    [
      'exec',
      'vite',
      'preview',
      '--mode',
      'measure',
      '--outDir',
      OUT,
      '--port',
      String(PREVIEW_PORT),
      '--strictPort',
    ],
    // Its own process group, so stopping the group stops the server under pnpm as well.
    { cwd: APP, detached: true, stdio: 'ignore', env: environment },
  )
  const close = async () => {
    if (preview.pid !== undefined) await stopGroup(preview.pid)
    await fake.close().catch(() => undefined)
    rmSync(directory, { recursive: true, force: true })
  }

  try {
    await waitUntilServed(`${PREVIEW}/config.json`)
    if (options.serve) {
      console.log(
        `The measurement build is at ${measuredUrl(PREVIEW)}; any email and password sign in.`,
      )
      console.log('Ctrl-C stops it.')
      await new Promise((done) => {
        for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(signal, done)
      })
      return 0
    }
    console.log(`Driving Chrome along the ${String(pathSeconds())} s path…`)
    const { ok, report } = await measure(options)
    console.log(report)
    return ok ? 0 : 1
  } finally {
    await close()
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => {
      process.exitCode = code
    },
    (error) => {
      console.error(error.message)
      process.exitCode = 1
    },
  )
}
