import { useEffect, useState } from 'react'

import { useSettings, type Settings } from '../config/settings'
import type { Received } from './store'

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
 * The age of `latest`, counted from when it was due, and its freshness. The age ticks
 * every second; each threshold has a timer of its own, so the state changes when it is
 * crossed and not up to a tick later (FR-TEL-02: within 100 ms). The clock read is never
 * earlier than the sample's arrival, so a sample held up reads as old as it is from the
 * render it arrives in, not a tick later (FR-SAF-02).
 */
export function useFreshness(latest: Pick<Received, 'dueAt' | 'receivedAt'> | null | undefined): {
  readonly freshness: Freshness | null
  readonly ageMs: number | null
} {
  const settings = useSettings()
  const [now, setNow] = useState(() => performance.now())
  const stale = settings.telemetryStaleAfterMs
  const lost = settings.telemetryLostAfterMs
  const dueAt = latest?.dueAt ?? null
  const receivedAt = latest?.receivedAt ?? null

  useEffect(() => {
    if (dueAt === null) return
    const look = () => {
      setNow(performance.now())
    }
    const timers = [dueAt + stale, dueAt + lost]
      .map((at) => at - performance.now())
      .filter((wait) => wait > 0)
      .map((wait) => setTimeout(look, wait))
    const tick = setInterval(look, TICK_MS)
    return () => {
      for (const timer of timers) clearTimeout(timer)
      clearInterval(tick)
    }
  }, [dueAt, stale, lost])

  if (dueAt === null || receivedAt === null) return { freshness: null, ageMs: null }
  const ageMs = Math.max(0, Math.max(now, receivedAt) - dueAt)
  return { freshness: freshnessOf(ageMs, settings), ageMs }
}
