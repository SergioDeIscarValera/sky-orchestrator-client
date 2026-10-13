import { useEffect, useRef } from 'react'

import type { EventSeverity, OperationEvent } from '../backend/backend'
import { ALERT } from '../app/styles'
import { Waiting } from '../fleets/Details'
import { useEvents } from './data'
import { Failure } from './Failure'
import { eventWords, inlineWords, localClock, SEVERITY_WORDS } from './format'
import { OperationPill } from './OperationPill'

/** How near the bottom a member must be for the log to follow the newest entry, in pixels. */
const FOLLOW_WITHIN_PX = 8

/**
 * An operation's log: oldest first, the newest at the bottom, each entry with its time, its words,
 * its severity and the value that matters in it (FR-LOG-02, FR-LOG-03). It follows a new entry to
 * the bottom unless the member has scrolled up to read earlier ones.
 */
export function OperationLog({ operationId }: { readonly operationId: string }) {
  const events = useEvents(operationId)
  if (events.isPending) return <Waiting>Loading the log…</Waiting>
  if (events.isError) {
    return <Failure message={events.error.message} onRetry={() => void events.refetch()} />
  }
  if (events.data.length === 0) return <Waiting>None</Waiting>
  return <Entries events={events.data} />
}

function Entries({ events }: { readonly events: readonly OperationEvent[] }) {
  const list = useRef<HTMLOListElement>(null)
  const following = useRef(true)
  const count = events.length

  useEffect(() => {
    const box = list.current
    if (box !== null && following.current) box.scrollTop = box.scrollHeight
  }, [count])

  return (
    <ol
      ref={list}
      role="log"
      aria-label="Log"
      className="mt-3 flex max-h-72 flex-col gap-1 overflow-y-auto text-sm"
      onScroll={(event) => {
        const { scrollTop, scrollHeight, clientHeight } = event.currentTarget
        following.current = scrollHeight - scrollTop - clientHeight < FOLLOW_WITHIN_PX
      }}
    >
      {events.map((event) => (
        <Entry key={event.id} event={event} />
      ))}
    </ol>
  )
}

function Entry({ event }: { readonly event: OperationEvent }) {
  const alarm = event.severity === 'safety'
  const detail = inlineWords(event.kind, event.payload)
  return (
    <li
      className={alarm ? `${ALERT} flex items-center gap-3` : 'flex items-center gap-3 px-2 py-1'}
    >
      <time dateTime={event.occurredAt} className="text-muted shrink-0 tabular-nums">
        {localClock(event.occurredAt)}
      </time>
      <Marker severity={event.severity} />
      <span className="min-w-0 break-words">
        {eventWords(event.kind)}
        {detail !== null && <span className={alarm ? undefined : 'text-muted'}> · {detail}</span>}
      </span>
    </li>
  )
}

/** A severity as a mark: info is a quiet dot with its word for a reader of the page; the rest are pills. */
function Marker({ severity }: { readonly severity: EventSeverity }) {
  switch (severity) {
    case 'info':
      return (
        <span className="bg-muted size-1.5 shrink-0 rounded-full">
          <span className="sr-only">{SEVERITY_WORDS.info}</span>
        </span>
      )
    case 'warning':
      return <OperationPill tone="caution">{SEVERITY_WORDS.warning}</OperationPill>
    case 'error':
      return <OperationPill tone="bad">{SEVERITY_WORDS.error}</OperationPill>
    case 'safety':
      return <OperationPill tone="alarm">{SEVERITY_WORDS.safety}</OperationPill>
  }
}
