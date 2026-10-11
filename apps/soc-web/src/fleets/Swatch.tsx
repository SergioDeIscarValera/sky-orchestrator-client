import { aircraftColourVar } from '../theme/aircraft'

/** A dot in the aircraft's own colour, the one the scene draws it in. */
export function Swatch({ colour }: { readonly colour: number }) {
  return (
    <span
      aria-hidden
      data-colour={colour}
      className="inline-block size-2.5 shrink-0 rounded-full"
      style={{ backgroundColor: aircraftColourVar(colour) }}
    />
  )
}
