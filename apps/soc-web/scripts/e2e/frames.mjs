// What the console end to end reads off the wire and how it sums it up: the telemetry
// samples among the frames Realtime sends the page, in either of its encodings, and
// their latencies at the requirement's percentiles. Plain and tested; console.mjs
// drives Chrome.

/** realtime-js 2.x: a user broadcast in binary is kind 4 (`serializer.js`). */
const USER_BROADCAST = 4
const JSON_ENCODING = 1
/** The kind byte, then the topic's, the event's and the metadata's sizes, then the encoding. */
const HEADER_BYTES = 5

function binarySample(bytes) {
  if (bytes.length < HEADER_BYTES || bytes[0] !== USER_BROADCAST) return null
  const [, topicSize, eventSize, metadataSize, encoding] = bytes
  const decoder = new TextDecoder()
  let offset = HEADER_BYTES
  const topic = decoder.decode(bytes.subarray(offset, offset + topicSize))
  offset += topicSize
  const event = decoder.decode(bytes.subarray(offset, offset + eventSize))
  offset += eventSize + metadataSize
  if (event !== 'sample' || encoding !== JSON_ENCODING) return null
  return { topic, payload: JSON.parse(decoder.decode(bytes.subarray(offset))) }
}

function textSample(text) {
  let message
  try {
    message = JSON.parse(text)
  } catch {
    return null
  }
  // vsn 2.0.0 frames are arrays, 1.0.0 frames objects: [join_ref, ref, topic, event, payload].
  const [topic, event, payload] = Array.isArray(message)
    ? message.slice(2)
    : [message?.topic, message?.event, message?.payload]
  if (event !== 'broadcast' || payload?.event !== 'sample') return null
  return { topic, payload: payload.payload }
}

/**
 * The telemetry sample a frame carries, with its topic, or null for any other frame:
 * Playwright hands a text frame as a string and a binary one as a Buffer.
 */
export function sampleOf(frame) {
  const found =
    typeof frame === 'string'
      ? textSample(frame)
      : binarySample(new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength))
  if (found === null) return null
  const { taken_at_ms: takenAtMs, sent_at_ms: sentAtMs, aircraft_sn: aircraftSn } = found.payload
  if (!Number.isFinite(takenAtMs) || !Number.isFinite(sentAtMs)) return null
  return { topic: found.topic, aircraftSn, takenAtMs, sentAtMs }
}

/** The nearest rank of the `fraction` percentile, as soc-cloud's latency.py takes it. */
export function percentile(values, fraction) {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)]
}

/** NFR-PERF-01's figures over a run's latencies in milliseconds. */
export function summary(latencies) {
  return {
    count: latencies.length,
    p50: percentile(latencies, 0.5),
    p95: percentile(latencies, 0.95),
    p99: percentile(latencies, 0.99),
    worst: latencies.length === 0 ? null : Math.max(...latencies),
  }
}
