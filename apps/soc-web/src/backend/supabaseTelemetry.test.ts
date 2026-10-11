// @vitest-environment node
import { PAYLOAD } from '../test/telemetry'
import type { TelemetrySample } from '../telemetry/sample'
import type { StateChannel } from './supabaseFleets'
import { telemetryOperations } from './supabaseTelemetry'

type Handler = (message: { event: string; payload: Record<string, unknown> }) => void

class FakeChannel implements StateChannel {
  readonly handlers = new Map<string, Handler>()
  unsubscribed = false

  on(_type: 'broadcast', filter: { event: string }, callback: Handler): StateChannel {
    this.handlers.set(filter.event, callback)
    return this
  }

  subscribe(): unknown {
    return this
  }

  unsubscribe(): unknown {
    this.unsubscribed = true
    return this
  }
}

describe("the organization's telemetry topic (FR-TEL-01, ADR-0007)", () => {
  it('listens to its samples, passes those that follow the contract, and stops', () => {
    const topics: string[] = []
    const channel = new FakeChannel()
    const telemetry = telemetryOperations((topic) => {
      topics.push(topic)
      return channel
    })
    const seen: TelemetrySample[] = []
    const stop = telemetry.onTelemetry('11111111-1111-4111-8111-111111111111', (sample) =>
      seen.push(sample),
    )
    expect(topics).toEqual(['org:11111111-1111-4111-8111-111111111111:soc:telemetry'])

    const deliver = channel.handlers.get('sample')
    deliver?.({ event: 'sample', payload: PAYLOAD })
    deliver?.({ event: 'sample', payload: { ...PAYLOAD, battery_pct: 140 } })
    deliver?.({ event: 'sample', payload: { ...PAYLOAD, extra: true } })
    expect(seen.map(({ batteryPct }) => batteryPct)).toEqual([87])

    stop()
    expect(channel.unsubscribed).toBe(true)
  })
})
