// @vitest-environment node
import { percentile, sampleOf, summary } from './frames.mjs'

const SAMPLE = {
  stack: 'lab',
  gateway_sn: 'SOTESTDOCK01',
  aircraft_sn: 'SOTESTUAV001',
  taken_at_ms: 1_790_800_000_000,
  sent_at_ms: 1_790_800_000_004,
}
const TOPIC = 'realtime:org:6f1c2b9e-4d2a-4c1e-9a7b-2f3e4d5c6b7a:soc:telemetry'

/** A user broadcast as Realtime sends it to realtime-js 2.x in binary (`serializer.js`). */
function binary(event: string, payload: unknown, metadata = ''): Buffer {
  const [topic, name, meta, body] = [TOPIC, event, metadata, JSON.stringify(payload)].map((text) =>
    Buffer.from(text, 'utf8'),
  ) as [Buffer, Buffer, Buffer, Buffer]
  return Buffer.concat([
    Buffer.from([4, topic.length, name.length, meta.length, 1]),
    topic,
    name,
    meta,
    body,
  ])
}

describe("the console end to end's frames (NFR-PERF-01)", () => {
  it('reads a telemetry sample from a binary broadcast, with metadata or without', () => {
    expect(sampleOf(binary('sample', SAMPLE))).toEqual({
      topic: TOPIC,
      aircraftSn: 'SOTESTUAV001',
      takenAtMs: SAMPLE.taken_at_ms,
      sentAtMs: SAMPLE.sent_at_ms,
    })
    expect(sampleOf(binary('sample', SAMPLE, '{"replayed":false}'))?.sentAtMs).toBe(
      SAMPLE.sent_at_ms,
    )
  })

  it('reads one from a text broadcast in either protocol version', () => {
    const broadcast = { type: 'broadcast', event: 'sample', payload: SAMPLE }
    const array = JSON.stringify([null, null, TOPIC, 'broadcast', broadcast])
    const object = JSON.stringify({ topic: TOPIC, event: 'broadcast', payload: broadcast })
    expect(sampleOf(array)?.takenAtMs).toBe(SAMPLE.taken_at_ms)
    expect(sampleOf(object)?.takenAtMs).toBe(SAMPLE.taken_at_ms)
  })

  it('passes over every other frame', () => {
    expect(sampleOf(binary('device', SAMPLE))).toBeNull()
    expect(sampleOf(binary('sample', { ...SAMPLE, sent_at_ms: undefined }))).toBeNull()
    expect(sampleOf(Buffer.from([1, 0, 0, 0, 1]))).toBeNull()
    expect(sampleOf(Buffer.from([]))).toBeNull()
    expect(sampleOf('{"event":"phx_reply","payload":{"status":"ok"}}')).toBeNull()
    expect(sampleOf('not json')).toBeNull()
  })

  it('takes percentiles by nearest rank, as soc-cloud does', () => {
    const values = Array.from({ length: 100 }, (_, index) => 100 - index)
    expect(percentile(values, 0.95)).toBe(95)
    expect(percentile(values, 0.99)).toBe(99)
    expect(percentile([], 0.95)).toBeNull()
    expect(summary([3, 1, 2])).toEqual({ count: 3, p50: 2, p95: 3, p99: 3, worst: 3 })
    expect(summary([])).toEqual({ count: 0, p50: null, p95: null, p99: null, worst: null })
  })
})
