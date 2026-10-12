import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { sampleOf, type TelemetrySample } from '../telemetry/sample'

/** Where the recordings are kept (contracts/recordings, NFR-TEST-05). */
export const RECORDINGS = fileURLToPath(
  new URL('../../../../contracts/recordings/', import.meta.url),
)

/** One sample a console received, and when, on the browser's wall clock. */
export interface RecordedSample {
  readonly receivedAtMs: number
  readonly sample: TelemetrySample
}

/**
 * A recording's samples, each held to the contract (`recording.schema.json`): a line
 * that is not one throws, naming it, so a recording off the contract cannot pass for
 * a test input.
 */
export function readRecording(text: string, name = 'recording'): RecordedSample[] {
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line, index) => {
      const where = `${name}:${String(index + 1)}`
      const parsed = JSON.parse(line) as { received_at_ms?: unknown; sample?: unknown }
      const keys = Object.keys(parsed).sort().join(',')
      if (keys !== 'received_at_ms,sample') throw new Error(`${where} has ${keys}`)
      const receivedAtMs = parsed.received_at_ms
      if (typeof receivedAtMs !== 'number' || !Number.isInteger(receivedAtMs) || receivedAtMs < 0) {
        throw new Error(`${where}: received_at_ms is not a time`)
      }
      const sample = sampleOf(parsed.sample)
      if (sample === null) throw new Error(`${where}: the sample breaks the telemetry contract`)
      return { receivedAtMs, sample }
    })
}

/** Every recording kept, by file name. */
export function recordings(): Map<string, RecordedSample[]> {
  return new Map(
    readdirSync(RECORDINGS)
      .filter((file) => file.endsWith('.jsonl'))
      .sort()
      .map((file) => [file, readRecording(readFileSync(join(RECORDINGS, file), 'utf8'), file)]),
  )
}
