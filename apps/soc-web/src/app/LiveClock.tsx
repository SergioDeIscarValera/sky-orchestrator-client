import { useEffect, useMemo, useState } from 'react'

import { clockFor } from './clock'

export function LiveClock({ timeZone }: { readonly timeZone: string | null }) {
  const [now, setNow] = useState(() => new Date())
  const clock = useMemo(() => clockFor(timeZone), [timeZone])

  useEffect(() => {
    const timer = window.setInterval(() => {
      setNow(new Date())
    }, 1000)
    return () => {
      window.clearInterval(timer)
    }
  }, [])

  return (
    <time
      className="font-heading text-heading text-sm tabular-nums"
      dateTime={now.toISOString()}
      title={`${clock.zone} · ${clock.utc.format(now)} UTC`}
    >
      {clock.local.format(now)}
    </time>
  )
}
