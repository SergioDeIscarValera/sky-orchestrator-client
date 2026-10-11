/** How many colours the aircraft are told apart by; a seventh aircraft takes the first again. */
export const AIRCRAFT_COLOURS = 6

/** The token of the aircraft colour `index`, wrapping round the six (theme.css). */
export function aircraftColourToken(index: number): string {
  return `--color-aircraft-${String((index % AIRCRAFT_COLOURS) + 1)}`
}

/** The aircraft colour `index` as a CSS value, for a swatch beside a name. */
export function aircraftColourVar(index: number): string {
  return `var(${aircraftColourToken(index)})`
}
