import type { Refusal } from './geofenceDrawing'

const WHOLE = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 })
const TWO_DECIMALS = new Intl.NumberFormat('en-GB', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

/** Square metres up to a hectare, hectares beyond: the scale a field is spoken of in. */
export function formatArea(squareMetres: number): string {
  return squareMetres < 10_000
    ? `${WHOLE.format(squareMetres)} m²`
    : `${TWO_DECIMALS.format(squareMetres / 10_000)} ha`
}

/** Metres up to a kilometre, kilometres beyond. */
export function formatLength(metres: number): string {
  return metres < 1000 ? `${WHOLE.format(metres)} m` : `${TWO_DECIMALS.format(metres / 1000)} km`
}

/** Each reason a geofence cannot be saved, as the editor names it beside Save (FR-GEO-04). */
export function refusalLabel(refusal: Refusal, envelopeCeilingM: number | null): string {
  switch (refusal) {
    case 'name_missing':
      return 'Name missing'
    case 'too_few_vertices':
      return 'Fewer than 3 vertices'
    case 'edges_meet':
      return 'Edges meet'
    case 'zero_length_edge':
      return 'Two vertices in one place'
    case 'no_area':
      return 'No area'
    case 'ceiling_missing':
      return 'Ceiling missing'
    case 'ceiling_not_positive':
      return 'Ceiling not above 0 m'
    case 'ceiling_above_envelope':
      return envelopeCeilingM === null
        ? "Ceiling above the stack's"
        : `Ceiling above the stack's ${WHOLE.format(envelopeCeilingM)} m`
  }
}
