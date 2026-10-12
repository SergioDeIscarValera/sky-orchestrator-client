// The memory measurement of NFR-RES-02 and NFR-RES-03: what `pnpm measure --memory`
// asks for and its verdict. The browser and the servers are run.mjs's; everything here
// is plain and tested.

const MEBIBYTE = 1024 * 1024

/** NFR-RES-02: the JavaScript heap after an hour of live telemetry, at most. */
export const HEAP_BUDGET_BYTES = 150 * MEBIBYTE
/** NFR-RES-02: the heap's upward trend, at most this share of it an hour. */
export const HEAP_TREND_LIMIT = 0.05
/** NFR-RES-02: heap snapshots at 10 and 70 minutes, the trend taken between. */
export const FROM_MINUTE = 10
export const SESSION_MINUTES = 70
/** NFR-RES-03: textures and buffers at most, as the scene accounts them (`gpuMemory.ts`). */
export const GPU_BUDGET_BYTES = 256 * MEBIBYTE

/** `bytes` in mebibytes, one decimal. */
export function inMegabytes(bytes) {
  return `${(bytes / MEBIBYTE).toFixed(1)} MB`
}

/**
 * The heap's trend over the samples from FROM_MINUTE on, as a share of its fitted value
 * at FROM_MINUTE an hour: the least-squares line through them, so one collection's
 * timing does not decide it. Null with fewer than two samples to fit.
 */
export function heapTrend(samples) {
  const fitted = samples.filter(({ minute }) => minute >= FROM_MINUTE)
  if (fitted.length < 2) return null
  const meanMinute = fitted.reduce((sum, { minute }) => sum + minute, 0) / fitted.length
  const meanBytes = fitted.reduce((sum, { bytes }) => sum + bytes, 0) / fitted.length
  let covariance = 0
  let variance = 0
  for (const { minute, bytes } of fitted) {
    covariance += (minute - meanMinute) * (bytes - meanBytes)
    variance += (minute - meanMinute) ** 2
  }
  if (variance === 0) return null
  const perMinute = covariance / variance
  const atStart = meanBytes + perMinute * (FROM_MINUTE - meanMinute)
  return (perMinute * 60) / atStart
}

/**
 * Whether the session met NFR-RES-02 and NFR-RES-03, and the report that says so. A
 * session shorter than SESSION_MINUTES reports its figures but is not the requirement's.
 */
export function memoryVerdict(session, context) {
  const last = session.heap.at(-1)
  if (last === undefined) return { ok: false, report: 'No heap was measured.' }
  const trend = heapTrend(session.heap)
  const full = last.minute >= SESSION_MINUTES
  const heapOk = last.bytes <= HEAP_BUDGET_BYTES
  const trendOk = trend !== null && trend <= HEAP_TREND_LIMIT
  const gpuOk = session.gpuBytes !== null && session.gpuBytes <= GPU_BUDGET_BYTES
  const percent = (share) => `${(share * 100).toFixed(1)} %`
  const lines = [
    `NFR-RES-02 and NFR-RES-03: ${String(last.minute)} minutes of live telemetry, ${String(context.aircraft)} aircraft at 5 Hz, ${context.site}`,
    `GPU: ${context.gpu}`,
    ...(full
      ? []
      : [
          `Shorter than the requirement's ${String(SESSION_MINUTES)} minutes: these figures do not decide it.`,
        ]),
    `JavaScript heap after collection: ${inMegabytes(last.bytes)} at minute ${String(last.minute)}: ${heapOk ? 'within' : 'over'} the ${inMegabytes(HEAP_BUDGET_BYTES)} budget`,
    trend === null
      ? `Heap trend: not enough samples from minute ${String(FROM_MINUTE)} on`
      : `Heap trend from minute ${String(FROM_MINUTE)}: ${percent(trend)} an hour: ${trendOk ? 'within' : 'over'} the ${percent(HEAP_TREND_LIMIT)} limit`,
    session.gpuBytes === null
      ? 'GPU memory: not measured, the scene did not draw'
      : `GPU memory: ${inMegabytes(session.gpuBytes)}: ${gpuOk ? 'within' : 'over'} the ${inMegabytes(GPU_BUDGET_BYTES)} budget`,
  ]
  return { ok: full && heapOk && trendOk && gpuOk, report: lines.join('\n') }
}
