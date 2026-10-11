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
