/**
 * A card over the scene. In the dark theme its shadow is lost on the dark ground,
 * which is the card's own colour, so a hairline in the border token outlines it.
 */
export const CARD = 'rounded-card bg-surface shadow-card dark:border-border dark:border'

export const PRIMARY_BUTTON =
  'rounded-pill bg-primary text-on-primary font-heading inline-flex h-11 items-center justify-center gap-2 px-5 text-sm font-semibold transition-[filter] duration-200 hover:brightness-95 disabled:cursor-wait disabled:opacity-70'

/** A button the user's role cannot use: still focusable, pointing at the reason. */
export const UNAVAILABLE = 'aria-disabled:cursor-not-allowed aria-disabled:opacity-60'

export const DANGER_BUTTON =
  'rounded-pill bg-danger-subtle text-danger-emphasis font-heading inline-flex h-11 items-center justify-center gap-2 px-5 text-sm font-semibold transition-[filter] duration-200 hover:brightness-95 disabled:cursor-wait disabled:opacity-70'

export const QUIET_BUTTON =
  'rounded-pill text-muted hover:bg-primary-subtle hover:text-primary-emphasis inline-flex h-9 items-center gap-2 px-3 text-sm transition-colors duration-200'

export const FIELD =
  'rounded-xl border-border bg-surface text-heading placeholder:text-muted h-11 w-full border px-3 text-sm transition-colors duration-200 focus-visible:border-primary'

export const ALERT = 'rounded-xl bg-danger-subtle text-danger-emphasis px-4 py-3 text-sm'

export const MENU = 'rounded-card bg-surface shadow-card border-border z-50 min-w-60 border p-1.5'

export const MENU_ITEM =
  'text-heading data-[highlighted]:bg-primary-subtle data-[highlighted]:text-primary-emphasis flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-sm outline-none'

/** A status pill: a subtle fill with emphasis text, as the design system derives them. */
export const PILL =
  'rounded-pill inline-flex h-6 shrink-0 items-center px-2.5 text-xs font-medium whitespace-nowrap'

/** A pill's tone: each is a pair of tokens the theme already tests for contrast, no new colour. */
export const PILL_TONE = {
  neutral: 'bg-page text-heading',
  progress: 'bg-info-subtle text-info-emphasis',
  good: 'bg-success-subtle text-success-emphasis',
  flying: 'bg-primary-subtle text-primary-emphasis',
  caution: 'bg-warning-subtle text-warning-emphasis',
  bad: 'bg-danger-subtle text-danger-emphasis',
  muted: 'border-border text-muted border',
} as const

export type PillTone = keyof typeof PILL_TONE
