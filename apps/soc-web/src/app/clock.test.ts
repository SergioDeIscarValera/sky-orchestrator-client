// @vitest-environment node
import { clockFor } from './clock'

const NOON_UTC = new Date('2026-07-01T12:00:00Z')

describe("the organization's clock (NFR-UX-07)", () => {
  it("shows the organization's time and UTC beside it", () => {
    const clock = clockFor('Europe/Madrid')
    expect(clock.local.resolvedOptions().timeZone).toBe('Europe/Madrid')
    expect(clock.local.format(NOON_UTC)).toMatch(/14.00.00/)
    expect(clock.utc.format(NOON_UTC)).toBe('12:00:00')
    expect(clock.zone).toBe('Europe/Madrid')
  })

  it.each([null, 'Mars/Olympus_Mons'])("falls back to the device's zone for %j", (zone) => {
    const clock = clockFor(zone)
    expect(clock.zone).toBe(`${clock.local.resolvedOptions().timeZone} (this device)`)
  })
})
