import { useEffect, useState } from 'react'

import { useSettings, type Settings } from '../config/settings'

/** Live until `telemetry_stale_after_ms`, stale until `telemetry_lost_after_ms`, then lost (FR-TEL-02). */
export type Freshness = 'live' | 'stale' | 'lost'

type Thresholds = Pick<Settings, 'telemetryStaleAfterMs' | 'telemetryLostAfterMs'>

export function freshnessOf(ageMs: number, thresholds: Thresholds): Freshness {
  if (ageMs >= thresholds.telemetryLostAfterMs) return 'lost'
  if (ageMs >= thresholds.telemetryStaleAfterMs) return 'stale'
  return 'live'
}

const TICK_MS = 1000

/**
 * The age of what was received at `receivedAt`, and its freshness. The age ticks every
 * second; each threshold has a timer of its own, so the state changes when it is crossed
 * and not up to a tick later (FR-TEL-02: within 100 ms).
 */
export function useFreshness(receivedAt: number | null): {
  readonly freshness: Freshness | null
  readonly ageMs: number | null
} {
  const settings = useSettings()
  const [now, setNow] = useState(() => performance.now())
  const stale = settings.telemetryStaleAfterMs
  const lost = settings.telemetryLostAfterMs

  useEffect(() => {
    if (receivedAt === null) return
    const look = () => {
      setNow(performance.now())
    }
    const timers = [receivedAt + stale, receivedAt + lost]
      .map((at) => at - performance.now())
      .filter((wait) => wait > 0)
      .map((wait) => setTimeout(look, wait))
    const tick = setInterval(look, TICK_MS)
    return () => {
      for (const timer of timers) clearTimeout(timer)
      clearInterval(tick)
    }
  }, [receivedAt, stale, lost])

  if (receivedAt === null) return { freshness: null, ageMs: null }
  const ageMs = Math.max(0, now - receivedAt)
  return { freshness: freshnessOf(ageMs, settings), ageMs }
}
