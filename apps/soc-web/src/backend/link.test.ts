// @vitest-environment node
import { createLinkTracker, linkOf, reporting, type Link } from './link'
import type { StateChannel } from './supabaseFleets'

/** A channel whose statuses the test plays, as Realtime would report them. */
class PlayedChannel implements StateChannel {
  report: ((status: string) => void) | null = null
  on(): StateChannel {
    return this
  }
  subscribe(callback: (status: string) => void): unknown {
    this.report = callback
    return this
  }
  unsubscribe(): unknown {
    // Realtime closes the channel on the way out, and says so.
    this.report?.('CLOSED')
    return this
  }
}

function tracked() {
  const link = createLinkTracker()
  const seen: Link[] = []
  link.subscribe((now) => seen.push(now))
  const made: PlayedChannel[] = []
  const channel = reporting(() => {
    const played = new PlayedChannel()
    made.push(played)
    return played
  }, link)
  return { link, seen, made, channel }
}

describe("the console's link to its live topics (NFR-REL-07)", () => {
  it('is up only while every channel is joined, and down while any is lost', () => {
    expect(linkOf([])).toBe('connecting')
    expect(linkOf(['joining', 'joined'])).toBe('connecting')
    expect(linkOf(['joined', 'joined'])).toBe('up')
    expect(linkOf(['joined', 'lost'])).toBe('down')
    expect(linkOf(['joining', 'lost'])).toBe('down')
    expect(linkOf(['joined', 'joined'], false)).toBe('down')
  })

  it('goes down when a channel errs or times out, and up again once it rejoins', () => {
    const { link, seen, made, channel } = tracked()
    channel('org:1:soc:state').subscribe(() => undefined)
    channel('org:1:soc:telemetry').subscribe(() => undefined)
    const [state, telemetry] = made
    expect(link.current()).toBe('connecting')
    state?.report?.('SUBSCRIBED')
    telemetry?.report?.('SUBSCRIBED')
    state?.report?.('CHANNEL_ERROR')
    state?.report?.('SUBSCRIBED')
    telemetry?.report?.('TIMED_OUT')
    telemetry?.report?.('SUBSCRIBED')
    expect(seen).toEqual(['up', 'down', 'up', 'down', 'up'])
  })

  it('goes down on a lost socket until every channel rejoins', () => {
    const { link, seen, made, channel } = tracked()
    channel('org:1:soc:state').subscribe(() => undefined)
    channel('org:1:soc:telemetry').subscribe(() => undefined)
    for (const played of made) played.report?.('SUBSCRIBED')
    link.lost()
    made[0]?.report?.('SUBSCRIBED')
    expect(link.current()).toBe('down')
    made[1]?.report?.('SUBSCRIBED')
    expect(seen).toEqual(['up', 'down', 'up'])
  })

  it('takes a channel it stops listening on, closing, for no loss', () => {
    const { link, seen, made, channel } = tracked()
    const state = channel('org:1:soc:state')
    state.subscribe(() => undefined)
    made[0]?.report?.('SUBSCRIBED')
    state.unsubscribe()
    // A switch of organization: the new topics join afresh.
    channel('org:2:soc:state').subscribe(() => undefined)
    made[1]?.report?.('SUBSCRIBED')
    expect(seen).toEqual(['up', 'connecting', 'up'])
    expect(link.current()).toBe('up')
  })

  it('keeps two channels on one topic apart', () => {
    const { link, made, channel } = tracked()
    const first = channel('org:1:soc:state')
    first.subscribe(() => undefined)
    channel('org:1:soc:state').subscribe(() => undefined)
    for (const played of made) played.report?.('SUBSCRIBED')
    first.unsubscribe()
    made[1]?.report?.('CHANNEL_ERROR')
    expect(link.current()).toBe('down')
  })

  it('passes each status on to the console', () => {
    const { made, channel } = tracked()
    const statuses: string[] = []
    channel('org:1:soc:state').subscribe((status) => statuses.push(status))
    made[0]?.report?.('SUBSCRIBED')
    made[0]?.report?.('CHANNEL_ERROR')
    expect(statuses).toEqual(['SUBSCRIBED', 'CHANNEL_ERROR'])
  })

  it('is down while the browser is offline, and as its channels say once back', () => {
    const { link, seen, made, channel } = tracked()
    channel('org:1:soc:state').subscribe(() => undefined)
    made[0]?.report?.('SUBSCRIBED')
    link.network(false)
    link.network(true)
    // A socket the cut killed: its channel errs, and the link stays down until it rejoins.
    link.network(false)
    made[0]?.report?.('CHANNEL_ERROR')
    link.network(true)
    expect(link.current()).toBe('down')
    made[0]?.report?.('SUBSCRIBED')
    expect(seen).toEqual(['up', 'down', 'up', 'down', 'up'])
  })
})
