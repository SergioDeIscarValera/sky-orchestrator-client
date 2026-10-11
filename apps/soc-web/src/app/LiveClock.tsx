import { useEffect, useState } from 'react'

const FORMAT = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
})

export function LiveClock() {
  const [now, setNow] = useState(() => new Date())

  useEffect(() => {
    const timer = window.setInterval(() => {
      setNow(new Date())
    }, 1000)
    return () => {
      window.clearInterval(timer)
    }
  }, [])

  return (
    <time className="font-heading text-heading text-sm tabular-nums" dateTime={now.toISOString()}>
      {FORMAT.format(now)}
    </time>
  )
}
