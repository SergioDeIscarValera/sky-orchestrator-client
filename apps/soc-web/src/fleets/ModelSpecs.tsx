import type { AircraftModel } from '../backend/backend'
import { Details } from './Details'
import { specRows } from './format'

const LINK = 'text-primary-emphasis underline-offset-2 hover:underline'

/** The model's published figures, each linked to the DJI page it was read on (FR-FLE-01). */
export function ModelSpecs({ model }: { readonly model: AircraftModel }) {
  const support = model.sources.msdk_v4_support
  return (
    <>
      <Details
        title={`Model: ${model.displayName}`}
        rows={specRows(model).map(({ label, value, source }) => [
          label,
          value === null ? (
            <span className="text-muted">Not published</span>
          ) : source === null ? (
            value
          ) : (
            <a href={source} target="_blank" rel="noreferrer" className={LINK}>
              {value}
            </a>
          ),
        ])}
      />
      <p className="text-muted mt-3 text-xs">
        {model.msdkV4Support === 'full'
          ? 'Fully supported by Mobile SDK V4.'
          : `Partly supported by Mobile SDK V4. ${model.supportNotes}`}{' '}
        {support !== undefined && (
          <a href={support} target="_blank" rel="noreferrer" className={LINK}>
            DJI's reference
          </a>
        )}
      </p>
    </>
  )
}
