const TIME = { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false } as const

export interface Clock {
  readonly local: Intl.DateTimeFormat
  readonly utc: Intl.DateTimeFormat
  readonly zone: string
}

/** Times in the organization's time zone, the device's when it has none or an unknown one (NFR-UX-07). */
export function clockFor(timeZone: string | null): Clock {
  const utc = new Intl.DateTimeFormat('en-GB', { ...TIME, timeZone: 'UTC' })
  if (timeZone !== null) {
    try {
      return {
        local: new Intl.DateTimeFormat(undefined, { ...TIME, timeZone }),
        utc,
        zone: timeZone,
      }
    } catch {
      return deviceClock(utc)
    }
  }
  return deviceClock(utc)
}

function deviceClock(utc: Intl.DateTimeFormat): Clock {
  const local = new Intl.DateTimeFormat(undefined, TIME)
  return { local, utc, zone: `${local.resolvedOptions().timeZone} (this device)` }
}
