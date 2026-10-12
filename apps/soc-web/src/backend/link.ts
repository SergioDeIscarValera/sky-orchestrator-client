import type { StateChannel } from './supabaseFleets'

/**
 * Whether the console's topics reach it (NFR-REL-07): `up` while every topic it listens
 * on is joined, `down` from the moment one is lost until it is joined again, and
 * `connecting` while one is still joining for the first time. While `down`, what the
 * console shows is as of the loss, not now.
 */
export type Link = 'connecting' | 'up' | 'down'

/**
 * How often the browser asks Realtime whether its socket is alive. A socket that died
 * without closing, a network cut say, is noticed within two of these: Phoenix waits one
 * interval for each heartbeat's reply. Realtime's own default is 25 s.
 */
export const HEARTBEAT_MS = 5000

export interface LinkTracker {
  readonly current: () => Link
  readonly subscribe: (listener: (link: Link) => void) => () => void
  /** The console starts listening on a channel, by a key of its own. */
  readonly listen: (channel: string) => void
  /** A channel's status as Realtime reports it to its `subscribe` callback. */
  readonly status: (channel: string, status: string) => void
  /** The console stopped listening on a channel: its closing is no loss. */
  readonly leave: (channel: string) => void
  /** The socket under every channel was lost: a heartbeat went unanswered. */
  readonly lost: () => void
  /**
   * The browser lost its network, or has it back. Offline, nothing reaches the console
   * whatever the channels last said; back, the link is what they say: a socket that
   * outlived the cut delivers what was held, late, and one that did not rejoins.
   */
  readonly network: (online: boolean) => void
}

type ChannelState = 'joining' | 'joined' | 'lost'

/** What Realtime reports when a channel stops reaching the console. */
const LOSSES = new Set(['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'])

/** The link from each channel's state: a loss anywhere is a loss, joined everywhere is up. */
export function linkOf(states: Iterable<ChannelState>, online = true): Link {
  if (!online) return 'down'
  let joining = false
  let any = false
  for (const state of states) {
    any = true
    if (state === 'lost') return 'down'
    if (state === 'joining') joining = true
  }
  return joining || !any ? 'connecting' : 'up'
}

export function createLinkTracker(): LinkTracker {
  const states = new Map<string, ChannelState>()
  const listeners = new Set<(link: Link) => void>()
  let shown: Link = 'connecting'
  let online = true

  const settle = () => {
    const next = linkOf(states.values(), online)
    if (next === shown) return
    shown = next
    for (const listener of listeners) listener(shown)
  }

  return {
    current: () => shown,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    listen: (channel) => {
      states.set(channel, 'joining')
      settle()
    },
    status: (channel, status) => {
      if (!states.has(channel)) return
      if (status === 'SUBSCRIBED') states.set(channel, 'joined')
      else if (LOSSES.has(status)) states.set(channel, 'lost')
      settle()
    },
    leave: (channel) => {
      states.delete(channel)
      settle()
    },
    lost: () => {
      for (const channel of states.keys()) states.set(channel, 'lost')
      settle()
    },
    network: (now) => {
      online = now
      settle()
    },
  }
}

/** `factory`'s channels, each reporting to `link` while the console listens on it. */
export function reporting(
  factory: (topic: string) => StateChannel,
  link: LinkTracker,
): (topic: string) => StateChannel {
  let channels = 0
  return (topic) => {
    const inner = factory(topic)
    // One entry per channel, so two listening on the same topic leave it apart.
    channels += 1
    const key = `${topic}#${String(channels)}`
    const channel: StateChannel = {
      on: (type, filter, callback) => {
        inner.on(type, filter, callback)
        return channel
      },
      subscribe: (callback) => {
        link.listen(key)
        return inner.subscribe((status) => {
          link.status(key, status)
          callback(status)
        })
      },
      unsubscribe: () => {
        // Before the channel closes, so its own CLOSED is not taken for a loss.
        link.leave(key)
        return inner.unsubscribe()
      },
    }
    return channel
  }
}
