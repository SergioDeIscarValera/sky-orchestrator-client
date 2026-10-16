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
//   → {"event": "search", "selected", "following"} the fleet found from the top bar
//   ← {"flying_again": true}                   the dock flies again
//   → {"event": "cut"}                         the browser's network is cut
//   ← {"renamed_to": <name>}                   the fleet renamed in the database
//   → {"event": "reconnected", ...}            the network back for CUT_MS, timed
//
// Each sample's latency is the browser's receipt, the frame as Playwright hands it
// over, against the dock's publish (its taken_at_ms) and against soc-cloud's
// broadcast (its sent_at_ms); both clocks are this machine's.
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

import { chromium } from 'playwright-core'

import { chromePath } from '../measure/path.mjs'
import { chromeArguments, emit, required, run, tracer } from './driver.mjs'
import { sampleOf, summary } from './frames.mjs'

// The catalogue's identifier, as contracts/catalogue/aircraft-models.json names the Mavic Air 2.
const FLEET = { name: 'Norte 1', model: 'mavic-air-2', airframeSerial: '1WNBH9' }
const WAIT_MS = 30_000
/** NFR-REL-07: how long the browser's network is cut. */
const CUT_MS = 10_000

const trace = tracer('console.mjs')

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

/**
 * Runs in the page: the wall clock when some span's text first starts with `text`
 * (`present`), or when none does any more.
 */
function whenText({ text, present }) {
  const shown = () =>
    Array.from(globalThis.document.querySelectorAll('span')).some((node) =>
      node.textContent.startsWith(text),
    )
  return new Promise((resolve) => {
    if (shown() === present) {
      resolve(Date.now())
      return
    }
    const observer = new globalThis.MutationObserver(() => {
      if (shown() !== present) return
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

/** `promise`'s value, or null once `ms` have passed without one. */
function within(promise, ms) {
  return Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(null), ms))])
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
    args: chromeArguments(),
  })
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 } })
    page.on('pageerror', (error) => {
      process.stderr.write(`page error: ${error.message}\n`)
    })
    const samples = []
    // With SOC_E2E_RECORD, every sample the page receives is kept as a recording
    // (contracts/recordings, NFR-TEST-05): one line each, as broadcast, and when it came.
    const recording = process.env.SOC_E2E_RECORD ?? null
    if (recording !== null) writeFileSync(recording, '')
    page.on('websocket', (socket) => {
      socket.on('framereceived', ({ payload }) => {
        const receivedAtMs = Date.now()
        const sample = sampleOf(payload)
        if (sample === null) return
        if (recording !== null) {
          appendFileSync(
            recording,
            `${JSON.stringify({ received_at_ms: receivedAtMs, sample: sample.payload })}\n`,
          )
        }
        if (sample.aircraftSn === aircraft) samples.push({ ...sample, receivedAtMs })
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

    // Registered as an operator does: the row selects the aircraft, and its inspector registers it.
    await row.click()
    await page
      .getByRole('complementary', { name: 'Inspector' })
      .getByRole('button', { name: 'Register as a fleet' })
      .click()
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
      page.evaluate(whenText, { text: 'Stale, ', present: true }),
      page.waitForTimeout(WAIT_MS).then(() => {
        throw new Error('the inspector never said Stale')
      }),
    ])
    emit({ event: 'stale', after_last_ms: staleAtMs - (samples.at(-1)?.receivedAtMs ?? staleAtMs) })

    // The map tools sit bottom right whether or not a panel is open (the design system). The
    // panel's close drops the selection too, so the inspector closes first: only the panel's
    // close is measured.
    await page.getByRole('button', { name: 'Close the inspector' }).click()
    await page.getByRole('complementary', { name: 'Inspector' }).waitFor({ state: 'detached' })
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

    // NFR-REL-07: the dock flies again, and the browser's network is cut for CUT_MS.
    // Meanwhile the harness renames the fleet: what the console shows changes while it
    // cannot hear of it. Each change on screen is timed in the page as it happens.
    await nextLine()
    trace('the dock flies again')
    await page.getByText(/^Live, /).waitFor({ timeout: WAIT_MS })
    const sockets = []
    page.on('websocket', () => sockets.push(Date.now()))
    const reconnecting = page.evaluate(whenText, { text: 'Reconnecting', present: true })
    const framesAtCut = samples.length
    const cutAtMs = Date.now()
    await page.context().setOffline(true)
    emit({ event: 'cut' })
    const { renamed_to: renamed } = await nextLine()
    await page.waitForTimeout(Math.max(0, cutAtMs + CUT_MS - Date.now()))
    const framesDuringCut = samples.length - framesAtCut
    const inspector = page.getByRole('complementary', { name: 'Inspector' })
    const freshnessAtRestore = await inspector.getByText(/^(Live|Stale|Lost), /).textContent()
    const presenceDuringCut = await inspector.getByText('Unknown', { exact: true }).count()
    const linkBack = page.evaluate(whenText, { text: 'Reconnecting', present: false })
    const liveAgain = page.evaluate(whenText, { text: 'Live, ', present: true })
    const restoredAtMs = Date.now()
    await page.context().setOffline(false)
    trace('the network is back')
    const renamedAtMs = await page
      .getByRole('heading', { name: renamed })
      .waitFor({ timeout: WAIT_MS })
      .then(() => Date.now())
    const after = (at) => (at === null ? null : at - restoredAtMs)
    emit({
      event: 'reconnected',
      frames_during_cut: framesDuringCut,
      reconnecting_after_ms: (await within(reconnecting, WAIT_MS)) - cutAtMs,
      freshness_at_restore: freshnessAtRestore,
      presence_unknown_during_cut: presenceDuringCut > 0,
      link_back_after_ms: after(await within(linkBack, WAIT_MS)),
      live_after_ms: after(await within(liveAgain, WAIT_MS)),
      renamed_after_ms: after(renamedAtMs),
      sockets_opened_after_restore: sockets.filter((at) => at >= restoredAtMs).length,
    })
  } finally {
    await browser.close()
  }
}

run(main)
