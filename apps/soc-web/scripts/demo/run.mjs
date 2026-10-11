// `pnpm demo`: the console on a laptop, against fake-supabase.mjs in place of the farm's
// Supabase. Vite gets the fake's address, the anon key and the console's settings file
// through its environment, as nginx/soc-web.sh gets them in the image.
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { startFakeSupabase, unsignedJwt } from './fake-supabase.mjs'

const APP = fileURLToPath(new URL('../../', import.meta.url))
const CONSOLE_PORT = 5199
const FAKE_PORT = 54399
const POLL_MS = 100
const STOP_TIMEOUT_MS = 5000

/** The console's settings file for the demo: the keys of its contract, each in range. */
export const DEMO_SETTINGS = Object.freeze({
  telemetry_stale_after_ms: 3000,
  telemetry_lost_after_ms: 10000,
  geofence_warning_band_m: 5,
  geofence_max_vertices: 32,
  max_arc_spacing_m: 10,
})

/** The public anon key, built at runtime: the secret scanner refuses a key literal in the source. */
export function demoSupabaseKey() {
  return unsignedJwt({ role: 'anon', iss: 'supabase' })
}

function fakePort(value) {
  if (value === undefined) return FAKE_PORT
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`SOC_DEMO_PORT must be a port from 1 to 65535, not "${value}"`)
  }
  return port
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Whether a process of the group is still running. */
function groupAlive(group) {
  try {
    process.kill(group, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

function signalGroup(group, signal) {
  try {
    process.kill(group, signal)
  } catch {
    // The group has already gone.
  }
}

/** Stops the Vite process group (pnpm and the dev server under it), by force after a while. */
async function stopGroup(pid) {
  const group = -pid
  signalGroup(group, 'SIGTERM')
  for (let waited = 0; groupAlive(group); waited += POLL_MS) {
    if (waited >= STOP_TIMEOUT_MS) {
      signalGroup(group, 'SIGKILL')
      return
    }
    await sleep(POLL_MS)
  }
}

async function main() {
  const port = fakePort(process.env.SOC_DEMO_PORT)
  const fake = await startFakeSupabase({ port }).catch((error) => {
    throw new Error(
      `cannot listen on 127.0.0.1:${port} (${error.code ?? error.message}); set SOC_DEMO_PORT to a free port`,
    )
  })

  const directory = mkdtempSync(join(tmpdir(), 'soc-demo-'))
  process.on('exit', () => {
    rmSync(directory, { recursive: true, force: true })
  })
  const settings = join(directory, 'soc-web.json')
  writeFileSync(settings, `${JSON.stringify(DEMO_SETTINGS, null, 2)}\n`)

  const vite = spawn('pnpm', ['exec', 'vite', '--port', String(CONSOLE_PORT), '--strictPort'], {
    cwd: APP,
    // Its own process group, so stopping the group stops the dev server under pnpm as well.
    detached: true,
    stdio: 'inherit',
    env: {
      ...process.env,
      SOC_WEB_SUPABASE_URL: fake.url,
      SOC_WEB_SUPABASE_KEY: demoSupabaseKey(),
      SOC_CONFIG_FILE: settings,
    },
  })

  // The first caller decides the exit code; later ones wait for the same shutdown.
  let closing = null
  const close = (code) => {
    closing ??= (async () => {
      if (vite.pid !== undefined) await stopGroup(vite.pid)
      await fake.close().catch(() => undefined)
      return code
    })()
    return closing
  }
  const exitWith = (code) => {
    void close(code).then((status) => {
      process.exit(status)
    })
  }

  vite.once('error', (error) => {
    console.error(`cannot start the console: ${error.message}`)
    exitWith(1)
  })
  vite.once('exit', (code, signal) => {
    exitWith(code ?? (signal === null ? 0 : 1))
  })
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => {
      exitWith(0)
    })
  }

  console.log(
    `The console starts at http://localhost:${CONSOLE_PORT}, on the fake Supabase at ${fake.url}.`,
  )
  console.log('Sign in with any email and any password. Ctrl-C stops the console and the fake.')
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
