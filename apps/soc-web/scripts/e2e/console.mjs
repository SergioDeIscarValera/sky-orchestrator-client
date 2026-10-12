// The console end to end's browser (infra/e2e): Chrome, through playwright-core, signs
// in to the console at SOC_E2E_CONSOLE as SOC_E2E_EMAIL and works it as an operator
// does, while the harness drives the platform and the dock. They talk in JSON lines:
// this script writes what it saw on stdout and reads the harness's lines on stdin.
//
//   → {"event": "ready"}                       signed in, the fleet panel open
//   ← {"announced_at_ms": <wall ms>}           the dock has started announcing
//   → {"event": "device", "appeared_after_ms"} the aircraft in the fleet panel
//   → {"event": "fleet", "name"}               registered through the form, shown
//   ← {"flying_since_ms": <wall ms>}           the dock has started its OSD
//   → {"event": "telemetry", ...}              SOC_E2E_SAMPLES samples, measured
//   ← {"stopped": true}                        the dock has gone quiet
//   → {"event": "stale", "after_last_ms"}      the inspector says Stale
//   → {"event": "layout", "map_tools_moved_px"} the map tools with the panel open and shut
//
// Each sample's latency is the browser's receipt, the frame as Playwright hands it
// over, against the dock's publish (its taken_at_ms) and against soc-cloud's
// broadcast (its sent_at_ms); both clocks are this machine's.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

import { chromium } from 'playwright-core'

import { chromePath } from '../measure/path.mjs'
import { sampleOf, summary } from './frames.mjs'

// The catalogue's identifier, as contracts/catalogue/aircraft-models.json names the Mavic Air 2.
const FLEET = { name: 'Norte 1', model: 'mavic-air-2', airframeSerial: '1WNBH9' }
const WAIT_MS = 30_000

function required(name) {
  const value = process.env[name]
  if (value === undefined || value === '') throw new Error(`${name} is not set`)
  return value
}

const emit = (line) => {
  process.stdout.write(`${JSON.stringify(line)}\n`)
}

/** Where the browser is, on stderr, for a run that stops half way. */
const trace = (step) => {
  process.stderr.write(`[console.mjs ${new Date().toISOString()}] ${step}\n`)
}

/** The live value a row of the inspector's Live card shows. */
function liveValue(page, label) {
  return page
    .getByRole('region', { name: 'Live' })
    .getByText(label, { exact: true })
    .locator('xpath=following-sibling::*[1]')
    .textContent()
}

/** The figure the statistics overlay shows for `label`, in milliseconds, or null. */
async function overlayMs(page, label) {
  const text = await page
    .getByRole('definition')
    .filter({ has: page.locator(`xpath=preceding-sibling::dt[1][normalize-space()="${label}"]`) })
    .first()
    .textContent()
    .catch(() => null)
  const value = Number.parseFloat(text ?? '')
  return Number.isFinite(value) ? value : null
}

/** Runs in the page, where globalThis is its window: the wall clock when the Live card's pill first reads Stale. */
function staleAt() {
  const stale = () =>
    Array.from(globalThis.document.querySelectorAll('span')).some((node) =>
      node.textContent.startsWith('Stale,'),
    )
  return new Promise((resolve) => {
    if (stale()) {
      resolve(Date.now())
      return
    }
    const observer = new globalThis.MutationObserver(() => {
      if (!stale()) return
      observer.disconnect()
      resolve(Date.now())
    })
    observer.observe(globalThis.document.body, {
      subtree: true,
      childList: true,
      characterData: true,
    })
  })
}

async function main() {
  const consoleUrl = required('SOC_E2E_CONSOLE')
  const aircraft = process.env.SOC_E2E_AIRCRAFT ?? 'SOTESTUAV001'
  const wanted = Number(process.env.SOC_E2E_SAMPLES ?? '300')
  const shots = process.env.SOC_E2E_SHOTS ?? null
  const lines = createInterface({ input: process.stdin })[Symbol.asyncIterator]()
  const nextLine = async () => JSON.parse((await lines.next()).value ?? 'null')

  const browser = await chromium.launch({
    executablePath: chromePath(process.env.SOC_E2E_CHROME ?? null),
    headless: true,
    // Without a GPU, as on the runners, WebGL needs SwiftShader allowed explicitly.
    args:
      process.env.SOC_E2E_SOFTWARE_GL === '1'
        ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']
        : ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=gl'],
  })
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 } })
    page.on('pageerror', (error) => {
      process.stderr.write(`page error: ${error.message}\n`)
    })
    const samples = []
    page.on('websocket', (socket) => {
      socket.on('framereceived', ({ payload }) => {
        const receivedAtMs = Date.now()
        const sample = sampleOf(payload)
        if (sample !== null && sample.aircraftSn === aircraft)
          samples.push({ ...sample, receivedAtMs })
      })
    })

    await page.goto(new URL('/?panel=fleet&stats', consoleUrl).href)
    await page.getByLabel('Email').fill(required('SOC_E2E_EMAIL'))
    await page.getByLabel('Password').fill(required('SOC_E2E_PASSWORD'))
    await page.getByRole('button', { name: 'Sign in' }).click()
    await page.getByRole('region', { name: /^Aircraft/ }).waitFor({ timeout: WAIT_MS })
    const row = page.getByRole('button', { name: new RegExp(`^${aircraft}`) })
    const appearing = row.waitFor({ timeout: WAIT_MS }).then(() => Date.now())
    trace('signed in, waiting for the aircraft')
    emit({ event: 'ready' })

    const { announced_at_ms: announcedAtMs } = await nextLine()
    emit({ event: 'device', appeared_after_ms: (await appearing) - announcedAtMs })

    // Registered as an operator does, from the aircraft's row in the fleet panel.
    await page.getByRole('button', { name: `Register ${aircraft}` }).click()
    const form = page.getByRole('form', { name: `Register ${aircraft}` })
    await form.getByLabel('Name').fill(FLEET.name)
    await form.getByLabel('Model').selectOption(FLEET.model)
    await form.getByLabel('Airframe serial').fill(FLEET.airframeSerial)
    await form.getByRole('button', { name: 'Register' }).click()
    await page.getByRole('heading', { name: FLEET.name }).waitFor({ timeout: WAIT_MS })
    trace('registered, waiting for the flight')
    emit({ event: 'fleet', name: FLEET.name })

    const { flying_since_ms: flyingSinceMs } = await nextLine()
    trace('the dock flies')
    const framesBefore = await page.evaluate(() => globalThis.socScene?.frames ?? 0)
    // The selected aircraft is followed: its label holds still on the screen while it flies.
    const label = page.locator('span.font-heading.text-xs', { hasText: FLEET.name }).first()
    const labelAt = async () => {
      const box = await label.boundingBox().catch(() => null)
      return box === null ? null : { x: box.x, y: box.y }
    }
    let followedFrom = null
    const deadline = Date.now() + WAIT_MS + (wanted / 5) * 1000
    let firstPosition = null
    while (samples.length < wanted && Date.now() < deadline) {
      await page.waitForTimeout(250)
      if (firstPosition === null && samples.length > 0) {
        firstPosition = await liveValue(page, 'Position')
      }
      // From once the camera has flown in, a couple of seconds into the flight.
      if (followedFrom === null && samples.length >= 15) followedFrom = await labelAt()
    }
    const lastPosition = await liveValue(page, 'Position')
    const followedTo = await labelAt()
    const following = await page
      .getByRole('button', { name: 'Following', exact: true, pressed: true })
      .count()
    const framesAfter = await page.evaluate(() => globalThis.socScene?.frames ?? 0)
    if (shots !== null) {
      mkdirSync(shots, { recursive: true })
      await page.screenshot({ path: join(shots, 'flying.png') })
    }
    const fromDock = samples.map((sample) => sample.receivedAtMs - sample.takenAtMs)
    const fromCloud = samples.map((sample) => sample.receivedAtMs - sample.sentAtMs)
    emit({
      event: 'telemetry',
      first_after_ms: samples.length === 0 ? null : samples[0].receivedAtMs - flyingSinceMs,
      from_dock_ms: summary(fromDock),
      from_cloud_ms: summary(fromCloud),
      in_order: samples.every(
        (sample, index) => index === 0 || sample.takenAtMs > samples[index - 1].takenAtMs,
      ),
      console_delivery_p95_ms: await overlayMs(page, 'delivery p95'),
      moved: firstPosition !== null && firstPosition !== lastPosition,
      followed: following === 1,
      label_drift_px:
        followedFrom === null || followedTo === null
          ? null
          : Math.hypot(followedTo.x - followedFrom.x, followedTo.y - followedFrom.y),
      frames_drawn: framesAfter - framesBefore,
    })

    await nextLine()
    trace(`the dock is silent after ${String(samples.length)} samples`)
    // Timed in the page as the pill changes: a locator's wait polls every half second.
    const staleAtMs = await Promise.race([
      page.evaluate(staleAt),
      page.waitForTimeout(WAIT_MS).then(() => {
        throw new Error('the inspector never said Stale')
      }),
    ])
    emit({ event: 'stale', after_last_ms: staleAtMs - (samples.at(-1)?.receivedAtMs ?? staleAtMs) })

    // The map tools sit bottom right whether or not a panel is open (the design system).
    const tools = page.getByRole('toolbar', { name: 'Map tools' })
    const open = await tools.boundingBox()
    await page.getByRole('button', { name: 'Close Fleet' }).click()
    await page.getByRole('button', { name: 'Close Fleet' }).waitFor({ state: 'detached' })
    const shut = await tools.boundingBox()
    emit({
      event: 'layout',
      map_tools_moved_px:
        open === null || shut === null ? null : Math.hypot(open.x - shut.x, open.y - shut.y),
    })

    // The search: with nothing selected, `/`, a piece of the aircraft's serial and Enter
    // select its fleet, which the inspector shows and the scene follows.
    await page.keyboard.press('Escape')
    await page.getByRole('complementary', { name: 'Inspector' }).waitFor({ state: 'detached' })
    await page.keyboard.press('/')
    await page.keyboard.type(aircraft.slice(-6))
    await page
      .getByRole('option', { name: new RegExp(`^${FLEET.name}`) })
      .waitFor({ timeout: WAIT_MS })
    await page.keyboard.press('Enter')
    await page.getByRole('heading', { name: FLEET.name }).waitFor({ timeout: WAIT_MS })
    emit({
      event: 'search',
      selected: new URL(page.url()).searchParams.has('fleet'),
      following:
        (await page
          .getByRole('button', { name: 'Following', exact: true, pressed: true })
          .count()) === 1,
    })
  } finally {
    await browser.close()
  }
}

// Exits once done: the harness's open stdin, and Playwright's own SIGTERM handler,
// would otherwise keep Node running after the browser has closed.
main().then(
  () => process.exit(0),
  (error) => {
    emit({ event: 'failed', message: error.message })
    process.exit(1)
  },
)
