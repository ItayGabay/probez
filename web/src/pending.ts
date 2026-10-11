import { useEffect, useState } from 'react'

/**
 * How many reads are in flight, across the whole page.
 *
 * Every page dims what it already shows while it re-reads, but a dimmed table on its own does not
 * say anything is coming, and a drawer or a scope change can take a few seconds on a big store. The
 * count is what lets the shell draw one bar for all of them, without each page having to report in.
 */
let inFlight = 0
const listeners = new Set<(count: number) => void>()

function tell(): void {
  for (const listener of listeners) listener(inFlight)
}

/** Count a read from the moment it starts until it settles, whichever way it settles. */
export function track<T>(read: Promise<T>): Promise<T> {
  inFlight += 1
  tell()
  return read.finally(() => {
    inFlight -= 1
    tell()
  })
}

/**
 * Whether something has been reading for longer than `after` ms.
 *
 * The wait is the point: most reads finish in a few milliseconds, and a bar that flickers on for
 * each of them says "slow" about a page that is not.
 */
export function useBusy(after = 250): boolean {
  const [reading, setReading] = useState(inFlight > 0)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const listener = (count: number): void => setReading(count > 0)
    listeners.add(listener)
    setReading(inFlight > 0)
    return () => {
      listeners.delete(listener)
    }
  }, [])

  useEffect(() => {
    if (!reading) {
      setBusy(false)
      return
    }
    const timer = window.setTimeout(() => setBusy(true), after)
    return () => window.clearTimeout(timer)
  }, [reading, after])

  return busy
}
