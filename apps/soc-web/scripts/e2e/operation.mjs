// An operation flown from the console against Sky Orchestrator's fake bridge (infra/e2e, M4):
// Chrome, through playwright-core, signs in to the console at SOC_E2E_CONSOLE as SOC_E2E_EMAIL,
// opens SOC_E2E_OPERATION and works it as a pilot does, while the harness drives the stack and
// reads the database. They talk in JSON lines: this script writes what it saw on stdout and
// reads the harness's lines on stdin.
//
//   → {"event": "ready"}                        signed in, state channel joined, operation in draft
//   → {"event": "simulated", "latencies_ms", "holds_ms"}
//                                               planned, prepared, every blocking check passing,
//                                               simulated: SOC_E2E_CYCLES pauses and resumes flown
//                                               while the simulated flight flies, each command's
//                                               reply shown, timed from its send, in milliseconds
//   ← {"real": true}                            the stack turned to a real launch
//   ← {"on_route": true}                        the real flight flies its wayline (mode 5)
//   → {"event": "completed", "state_changes", "shown_at", "delivered_at_ms"}
//                                               completed, and the log's State changed entries,
//                                               each with when it first showed, and when the
//                                               state channel's first broadcast arrived (epoch ms)
//   → {"event": "failed", "message"}            on the first error, then exit 1
//
// A hold is by pointer on odd cycles and by Space on the focused button on even ones, as the
// console's HoldButton takes both (FR-CMD-07). The command goes out when its hold completes,
// 1.5 s on: its send is the start of its request in the page, and its reply shown is the Commands
// feed's newest row answered, timed in the page as the DOM changes (a MutationObserver, where
// Playwright's waitFor polls every 500 ms). A hold is released once its reply shows.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

import { chromium } from 'playwright-core'

import { chromePath } from '../measure/path.mjs'
import { chromeArguments, emit, required, run, tracer } from './driver.mjs'

/** A step the console takes after a click: a state, a row of the feed. */
const WAIT_MS = 30_000
/** A step the stack takes its time over: the checks, the launch, the flight's end. */
const SLOW_MS = 300_000
/** How long a command may take to show its reply before this driver gives up on it. */
const REPLY_MS = 15_000
/** How long every blocking check may take to pass: judged each second, a healthy run passes in seconds. */
const CHECKS_MS = 120_000
/** The start of a log entry that says the operation moved, as the console words it. */
const STATE_CHANGED = 'State changed · '
const trace = tracer('operation.mjs')

/**
 * Runs in the page before its scripts: the presses and the requests for a flight command, each
 * on the page's clock, so a hold and its send can be timed there.
 */
function recordPresses() {
  const presses = { downs: [], sends: [] }
  globalThis.__socOperationE2e = presses
  globalThis.addEventListener(
    'pointerdown',
    (event) => {
      if (event.button === 0) presses.downs.push(event.timeStamp)
    },
    true,
  )
  globalThis.addEventListener(
    'keydown',
    (event) => {
      if (event.key === ' ' || event.key === 'Enter') presses.downs.push(event.timeStamp)
    },
    true,
  )
  new globalThis.PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (entry.name.includes('/rpc/request_command')) presses.sends.push(entry.startTime)
    }
  }).observe({ type: 'resource' })
}

/** Runs in the page: the Commands feed's rows, and the presses and sends so far. */
function feedMarks() {
  const presses = globalThis.__socOperationE2e
  return {
    rows: globalThis.document.querySelectorAll('ol[aria-label="Commands"] > li').length,
    downs: presses.downs.length,
    sends: presses.sends.length,
  }
}

/**
 * Runs in the page: the newest row of the Commands feed once it shows a reply, timed as the DOM
 * changes. A row past `marks.rows` is the command the hold sent. Resolves once that command's
 * send is recorded, with the page's clock at the reply, at the send and at the press that held it.
 */
function whenAnswered({ marks, within }) {
  const replies = ['Accepted', 'Refused', 'Failed', 'Timed out', 'Expired']
  const presses = globalThis.__socOperationE2e
  return new Promise((resolve, reject) => {
    let observer = null
    let done = false
    const finish = (value) => {
      done = true
      observer?.disconnect()
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => {
      if (done) return
      done = true
      observer?.disconnect()
      reject(new Error(`no reply within ${within} ms`))
    }, within)
    // The send is recorded by the time its reply is shown, or a moment after: the poll is short.
    const sentOf = (reply) => {
      if (done) return
      if (presses.sends.length > marks.sends) {
        finish({ ...reply, sent: presses.sends[marks.sends], down: presses.downs[marks.downs] })
        return
      }
      setTimeout(() => {
        sentOf(reply)
      }, 5)
    }
    const check = () => {
      if (done) return
      const rows = Array.from(
        globalThis.document.querySelectorAll('ol[aria-label="Commands"] > li'),
      )
      if (rows.length <= marks.rows) return
      const [row] = rows
      const status = row.children[1]?.textContent ?? ''
      if (!replies.includes(status)) return
      observer?.disconnect()
      sentOf({
        status,
        verb: row.children[0]?.textContent ?? '',
        text: row.textContent,
        at: performance.now(),
      })
    }
    observer = new globalThis.MutationObserver(check)
    observer.observe(globalThis.document.body, {
      subtree: true,
      childList: true,
      characterData: true,
    })
    check()
  })
}

/** Runs in the page: whether the flight console's button `name` may be held now (not busy). */
function commandEnabled(name) {
  const group = globalThis.document.querySelector('[role="group"][aria-label="Flight commands"]')
  const buttons = Array.from(group?.querySelectorAll('button') ?? [])
  const button = buttons.find((each) => each.textContent === name)
  return button !== undefined && !button.disabled
}

/** Runs in the page: the operation's state, as the inspector's header shows it. */
function stateWords() {
  const pill = globalThis.document.querySelector('[aria-label="Inspector"] article h3 + span')
  return pill?.textContent ?? null
}

/** Runs in the page: whether the operation's header shows the state `wanted`. */
function stateIs(wanted) {
  const pill = globalThis.document.querySelector('[aria-label="Inspector"] article h3 + span')
  return pill?.textContent === wanted
}

/** Runs in the page: whether every blocking check the inspector lists reads Pass. */
function blockingChecksPass() {
  const rows = Array.from(
    globalThis.document.querySelectorAll('[aria-label="Preflight checks"] > li'),
  )
  return (
    rows.length > 0 &&
    rows.every(
      (row) =>
        row.textContent.includes('Not blocking') || row.lastElementChild?.textContent === 'Pass',
    )
  )
}

/**
 * Runs in the page: the blocking checks not passing, each row's words (its name, what it measured,
 * its detail and its state), for a failure's message.
 */
function blockingFailures() {
  return Array.from(globalThis.document.querySelectorAll('[aria-label="Preflight checks"] > li'))
    .filter(
      (row) =>
        !row.textContent.includes('Not blocking') && row.lastElementChild?.textContent !== 'Pass',
    )
    .map((row) => row.textContent)
}

/** Runs in the page: the State changed entries of the log as shown, oldest first. */
/**
 * Runs in the page before its scripts: when each State changed entry of the log first shows, on the
 * wall clock (milliseconds since the epoch), so the harness can hold it against when the database
 * recorded it (FR-LOG-03). The services record every move, never this page, so each entry reaches
 * it as it would a second browser.
 */
function recordStateChanges(prefix) {
  const shown = []
  const seen = new WeakSet()
  globalThis.__socStateChanges = shown
  new globalThis.MutationObserver(() => {
    for (const entry of globalThis.document.querySelectorAll('[aria-label="Log"] > li')) {
      if (seen.has(entry)) continue
      const text = entry.lastElementChild?.textContent ?? ''
      if (!text.startsWith(prefix)) continue
      seen.add(entry)
      shown.push({
        move: text.slice(prefix.length),
        at_ms: globalThis.performance.timeOrigin + globalThis.performance.now(),
      })
    }
  }).observe(globalThis.document, { childList: true, subtree: true, characterData: true })
}

function shownStateChanges(prefix) {
  return Array.from(globalThis.document.querySelectorAll('[aria-label="Log"] > li'))
    .map((entry) => entry.lastElementChild?.textContent ?? '')
    .filter((text) => text.startsWith(prefix))
    .map((text) => text.slice(prefix.length))
}

/** Runs in the page: whether the log's last State changed entry is the move into Completed. */
function completionLogged(prefix) {
  const entries = Array.from(globalThis.document.querySelectorAll('[aria-label="Log"] > li'))
    .map((entry) => entry.lastElementChild?.textContent ?? '')
    .filter((text) => text.startsWith(prefix))
  return entries.at(-1)?.endsWith(' to Completed') === true
}

/** Waits for the operation's header to show the state `words`, or says which one it shows. */
async function stateShown(page, words, within = WAIT_MS) {
  try {
    await page.waitForFunction(stateIs, words, { timeout: within })
  } catch {
    const shows = await page.evaluate(stateWords)
    const inspector = page.getByRole('complementary', { name: 'Inspector' })
    const says = [
      ...(await inspector.getByRole('alert').allTextContents()),
      ...(await inspector.getByRole('status').allTextContents()),
    ]
    throw new Error(
      `the operation did not show ${words} within ${within} ms: it shows ${shows};` +
        ` the inspector's statuses and alerts say ${JSON.stringify(says)}`,
    )
  }
}

/** Waits for every blocking check to pass, or names the ones that do not. */
async function blockingChecksPassed(page) {
  try {
    await page.waitForFunction(blockingChecksPass, null, { timeout: CHECKS_MS })
  } catch {
    const failing = await page.evaluate(blockingFailures)
    throw new Error(`the blocking checks did not all pass: ${failing.join(', ') || 'none judged'}`)
  }
}

/** Asks an operation's move from its actions in the inspector, by the words the console gives it. */
async function ask(page, words) {
  await page
    .getByRole('complementary', { name: 'Inspector' })
    .getByRole('button', { name: words, exact: true })
    .click()
}

/** Confirms a flight move in the group that asks it, by the words its confirm button has. */
async function confirm(page, prompt, words) {
  await page
    .getByRole('group', { name: prompt })
    .getByRole('button', { name: words, exact: true })
    .click()
}

/**
 * Holds the flight console's button `name` until its command is sent, then until the feed shows
 * its reply. Returns the hold, from its press to the send, and the reply's latency, from the send
 * to the reply shown: both on the page's clock. A press is by pointer, or by Space on the focused
 * button when `keyboard` is set. A reply that is not Accepted fails the run, with its words.
 */
async function holdCommand(page, name, keyboard) {
  const button = page
    .getByRole('group', { name: 'Flight commands' })
    .getByRole('button', { name, exact: true })
  await button.waitFor({ state: 'visible', timeout: WAIT_MS })
  await button.scrollIntoViewIfNeeded()
  await page.waitForFunction(commandEnabled, name, { timeout: WAIT_MS })
  const marks = await page.evaluate(feedMarks)
  const reply = page.evaluate(whenAnswered, { marks, within: REPLY_MS })
  // Read below once the press is released; a reply that never comes fails the run there.
  reply.catch(() => {})
  let pressed = false
  let answered
  try {
    if (keyboard) {
      await button.focus()
      await page.keyboard.down(' ')
      pressed = true
    } else {
      const box = await button.boundingBox()
      if (box === null) throw new Error(`the ${name} button has no box to press`)
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      await page.mouse.down()
      pressed = true
    }
    answered = await reply
  } finally {
    if (pressed) {
      if (keyboard) await page.keyboard.up(' ')
      else await page.mouse.up()
    }
  }
  if (answered.status !== 'Accepted') {
    throw new Error(`the ${name} was ${answered.status}: ${answered.text}`)
  }
  if (answered.verb !== name) {
    throw new Error(`the feed's newest row is ${answered.verb}, not ${name}: ${answered.text}`)
  }
  return { hold: answered.sent - answered.down, latency: answered.at - answered.sent }
}

/** `null` after `ms`: a race's loser, for a wait that must end. */
function timeout(ms) {
  return new Promise((resolve) => {
    setTimeout(() => resolve(null), ms)
  })
}

/**
 * The event and payload of a realtime frame on the organization's state channel, or null for a
 * frame on any other topic. A frame is an array in vsn 2.0.0, an object in 1.0.0; a broadcast is
 * binary (kind 4 of realtime-js 2.x's serializer, as frames.mjs reads it), its event the state's kind.
 */
function stateFrame(frame) {
  if (typeof frame !== 'string') return binaryStateFrame(frame)
  let message
  try {
    message = JSON.parse(frame)
  } catch {
    return null
  }
  const [topic, event, payload] = Array.isArray(message)
    ? message.slice(2)
    : [message?.topic, message?.event, message?.payload]
  if (typeof topic !== 'string' || !topic.endsWith(':soc:state')) return null
  return { event, payload: payload ?? null }
}

function binaryStateFrame(frame) {
  const bytes = new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength)
  const broadcast = 4
  const jsonEncoding = 1
  const header = 5
  if (bytes.length < header || bytes[0] !== broadcast) return null
  const [, topicSize, eventSize, metadataSize, encoding] = bytes
  const decoder = new TextDecoder()
  let offset = header
  const topic = decoder.decode(bytes.subarray(offset, offset + topicSize))
  offset += topicSize
  if (!topic.endsWith(':soc:state')) return null
  const kind = decoder.decode(bytes.subarray(offset, offset + eventSize))
  offset += eventSize + metadataSize
  let row = null
  if (encoding === jsonEncoding) {
    try {
      row = JSON.parse(decoder.decode(bytes.subarray(offset)))
    } catch {
      row = null
    }
  }
  return { event: 'broadcast', payload: { event: kind, row } }
}

/**
 * Traces every frame the page sends and receives on the state channel; `joined` resolves with the
 * payload of the join's reply. Realtime delivers to a join only a moment after it, so a change
 * committed in between reaches no listener: the console reads its state again once delivery has
 * begun (onState's JOIN_SETTLE_MS, runs 2, 3 and 6 of this test before it did). This driver moves
 * as soon as the channel has joined, as a pilot would, so that catching up is the console's.
 */
function watchStateChannel(page) {
  let replied = false
  let resolveJoined
  const joined = new Promise((resolve) => {
    resolveJoined = resolve
  })
  // When the first broadcast after the join arrived, on the wall clock: Realtime delivers from then.
  const delivery = { at_ms: null }
  page.on('websocket', (socket) => {
    socket.on('framesent', ({ payload }) => {
      const frame = stateFrame(payload)
      if (frame !== null) trace(`state channel sent ${frame.event}`)
    })
    socket.on('framereceived', ({ payload }) => {
      const frame = stateFrame(payload)
      if (frame === null) return
      const kind = frame.payload?.event ?? ''
      const status = frame.payload?.status ?? ''
      const row = frame.payload?.row ?? null
      const check =
        kind === 'operation_check' && row !== null
          ? ` ${row.check_id} ${row.state} ${String(row.detail).slice(0, 60)}`
          : ''
      trace(`state channel received ${frame.event} ${kind} ${status}${check}`.trimEnd())
      if (frame.event === 'phx_reply' && !replied) {
        replied = true
        resolveJoined(frame.payload)
      } else if (frame.event === 'broadcast' && replied && delivery.at_ms === null) {
        delivery.at_ms = Date.now()
      }
    })
  })
  return { joined, delivery }
}

async function main() {
  const consoleUrl = required('SOC_E2E_CONSOLE')
  const operation = required('SOC_E2E_OPERATION')
  const cycles = Number(process.env.SOC_E2E_CYCLES ?? '25')
  const shots = process.env.SOC_E2E_SHOTS ?? null
  const lines = createInterface({ input: process.stdin })[Symbol.asyncIterator]()
  const nextLine = async () => JSON.parse((await lines.next()).value ?? 'null')

  const browser = await chromium.launch({
    executablePath: chromePath(process.env.SOC_E2E_CHROME ?? null),
    headless: true,
    args: chromeArguments(),
  })
  let page = null
  try {
    page = await browser.newPage({ viewport: { width: 1600, height: 900 } })
    await page.addInitScript(recordPresses)
    await page.addInitScript(recordStateChanges, STATE_CHANGED)
    page.on('pageerror', (error) => {
      process.stderr.write(`page error: ${error.message}\n`)
    })
    const stateChannel = watchStateChannel(page)

    await page.goto(new URL(`/?panel=operations&operation=${operation}`, consoleUrl).href)
    await page.getByLabel('Email').fill(required('SOC_E2E_EMAIL'))
    await page.getByLabel('Password').fill(required('SOC_E2E_PASSWORD'))
    await page.getByRole('button', { name: 'Sign in' }).click()
    await stateShown(page, 'Draft')
    // The first move waits only for the state channel's join (see watchStateChannel).
    const join = await Promise.race([stateChannel.joined, timeout(WAIT_MS)])
    if (join === null) {
      throw new Error(`the console did not join its state channel within ${WAIT_MS} ms`)
    }
    if (join.status !== 'ok') {
      throw new Error(`the console's state channel refused to join: ${JSON.stringify(join)}`)
    }
    trace('signed in: the state channel joined, the operation in draft')
    emit({ event: 'ready' })

    // The preparation: plan, prepare, every blocking check passing, then simulate.
    await ask(page, 'Plan')
    await stateShown(page, 'Planned')
    await ask(page, 'Prepare')
    await stateShown(page, 'Preparing')
    trace('preparing: waiting for every blocking check to pass')
    await blockingChecksPassed(page)
    await ask(page, 'Simulate')
    await confirm(page, 'Fly in the simulator', 'Simulate')
    await stateShown(page, 'Simulating')
    await page
      .getByRole('region', { name: 'Flight console' })
      .getByText('In progress', { exact: true })
      .waitFor({ timeout: SLOW_MS })

    trace(`simulating: ${cycles} pauses and resumes`)
    const latencies = []
    const holds = []
    for (let cycle = 1; cycle <= cycles; cycle += 1) {
      const keyboard = cycle % 2 === 0
      const paused = await holdCommand(page, 'Pause', keyboard)
      const resumed = await holdCommand(page, 'Resume', keyboard)
      latencies.push(paused.latency, resumed.latency)
      holds.push(paused.hold, resumed.hold)
      trace(
        `cycle ${cycle} of ${cycles}: pause ${Math.round(paused.latency)} ms,` +
          ` resume ${Math.round(resumed.latency)} ms`,
      )
    }
    await stateShown(page, 'Simulated', SLOW_MS)
    emit({ event: 'simulated', latencies_ms: latencies, holds_ms: holds })

    // The real launch: the stack turned to real by the harness, the operation ready, launched.
    const turned = await nextLine()
    if (turned.real !== true) {
      throw new Error(`the harness said ${JSON.stringify(turned)} where {"real": true} was due`)
    }
    trace('the stack is real: waiting for Ready')
    await stateShown(page, 'Ready', SLOW_MS)
    await ask(page, 'Launch')
    await confirm(page, 'Fly for real', 'Launch')
    await page.getByText('Real flight', { exact: true }).waitFor({ timeout: SLOW_MS })
    await stateShown(page, 'In flight', SLOW_MS)
    const onRoute = await nextLine()
    if (onRoute.on_route !== true) {
      throw new Error(
        `the harness said ${JSON.stringify(onRoute)} where {"on_route": true} was due`,
      )
    }

    // The real flight: paused and resumed in the air, then completed once it has landed.
    trace('the real flight is on its route: a pause, then a resume')
    await holdCommand(page, 'Pause', false)
    await stateShown(page, 'Paused', SLOW_MS)
    await holdCommand(page, 'Resume', false)
    await stateShown(page, 'In flight', SLOW_MS)
    await stateShown(page, 'Completed', SLOW_MS)
    // The log arrives on its own stream: the move into Completed is read once the log shows it.
    await page.waitForFunction(completionLogged, STATE_CHANGED, { timeout: WAIT_MS })
    const changes = await page.evaluate(shownStateChanges, STATE_CHANGED)
    const shownAt = await page.evaluate(() => globalThis.__socStateChanges)
    emit({
      event: 'completed',
      state_changes: changes,
      shown_at: shownAt,
      delivered_at_ms: stateChannel.delivery.at_ms,
    })
  } catch (error) {
    if (page !== null) {
      if (shots !== null) {
        mkdirSync(shots, { recursive: true })
        await page.screenshot({ path: join(shots, 'failed.png') }).catch(() => {})
      }
      // What the page showed when it failed, where a run in CI leaves no screenshot.
      const shown = await page
        .locator('body')
        .innerText({ timeout: 2_000 })
        .catch(() => '(the page could not be read)')
      throw new Error(
        `${error.message}\nthe page at ${page.url()} showed: ${shown.slice(0, 600)}`,
        {
          cause: error,
        },
      )
    }
    throw error
  } finally {
    await browser.close()
  }
}

run(main)
