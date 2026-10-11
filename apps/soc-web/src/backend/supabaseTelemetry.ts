import { sampleOf, type TelemetrySample } from '../telemetry/sample'
import type { ChannelFactory } from './supabaseFleets'

const EVENT = 'sample'

/** The organization's private telemetry topic (FR-TEL-01, ADR-0007): samples that follow the contract. */
export function telemetryOperations(channel: ChannelFactory) {
  return {
    onTelemetry(organizationId: string, listener: (sample: TelemetrySample) => void): () => void {
      const subscription = channel(`org:${organizationId}:soc:telemetry`)
      subscription.on('broadcast', { event: EVENT }, ({ payload }) => {
        const sample = sampleOf(payload)
        if (sample !== null) listener(sample)
      })
      subscription.subscribe(() => undefined)
      return () => {
        void subscription.unsubscribe()
      }
    },
  }
}
