// The loading budget (NFR-PERF-05), on the built application: the JavaScript the
// entry loads before anything else, and the 3D chunk, both gzipped. It also holds
// development-only code out of the build: the replay of src/telemetry/replay.ts.
import { readFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'

const DIST = new URL('../dist/', import.meta.url)
const INITIAL_KB = 250
const SCENE_KB = 450
const SCENE_CHUNK = /three|scene/i

const manifest = JSON.parse(readFileSync(new URL('.vite/manifest.json', DIST), 'utf8'))
const gzipKb = (file) => gzipSync(readFileSync(new URL(file, DIST)), { level: 9 }).length / 1024

function staticGraph(key, seen = new Set()) {
  if (seen.has(key)) return seen
  seen.add(key)
  for (const imported of manifest[key].imports ?? []) staticGraph(imported, seen)
  return seen
}

const entries = Object.keys(manifest).filter((key) => manifest[key].isEntry)
const initial = new Set(entries.flatMap((key) => [...staticGraph(key)]))
const initialKb = [...initial].reduce((total, key) => total + gzipKb(manifest[key].file), 0)
const sceneKb = Object.values(manifest)
  .filter((chunk) => SCENE_CHUNK.test(chunk.name ?? '') && chunk.file.endsWith('.js'))
  .reduce((total, chunk) => total + gzipKb(chunk.file), 0)

const DEVELOPMENT_ONLY = ['src/telemetry/replay.ts']
const shipped = DEVELOPMENT_ONLY.filter((source) =>
  Object.values(manifest).some((chunk) => chunk.src === source),
)
if (shipped.length > 0) {
  console.error(`Development-only code in the build: ${shipped.join(', ')}.`)
  process.exit(1)
}

console.log(`initial JavaScript ${initialKb.toFixed(1)} KB gzip (budget ${INITIAL_KB})`)
console.log(`3D chunk ${sceneKb.toFixed(1)} KB gzip (budget ${SCENE_KB})`)
if (initialKb > INITIAL_KB || sceneKb > SCENE_KB) {
  console.error('Over the loading budget (NFR-PERF-05).')
  process.exit(1)
}
