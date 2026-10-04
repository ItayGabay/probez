import { useState } from 'react'
import type { CSSProperties, ReactElement, ReactNode } from 'react'

export type Direction = 'asc' | 'desc'

/** Which column a table is ordered by, and which way. Null is the order the rows arrived in. */
export interface Sorted<K extends string> {
  key: K
  dir: Direction
}

/**
 * A column heading that sorts.
 *
 * The button *is* the heading rather than sitting beside it, so the target is the word a person is
 * already reading and the keyboard reaches it for free. `aria-sort` on the cell is what says which
 * column is in force and which way it points.
 */
export function SortHead<K extends string>({
  label,
  head,
  sorted,
  onSort,
  className,
  style,
  title,
  after,
}: {
  label: ReactNode
  head: K
  sorted: Sorted<K> | null
  onSort: (key: K) => void
  className?: string
  style?: CSSProperties
  title?: string
  /**
   * Anything the heading carries beside its name, such as an `Info` mark. It sits outside the
   * button, because a mark you can focus and hover is not something a press on the heading should
   * also sort by.
   */
  after?: ReactNode
}): ReactElement {
  const active = sorted !== null && sorted.key === head
  return (
    <th
      className={className}
      style={style}
      aria-sort={active ? (sorted.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <button type="button" className="sort" onClick={() => onSort(head)} title={title}>
        {label}
        {/* The column in force carries a solid arrow pointing the way it sorts. Every other one
            carries a faint two-way mark: with nothing there, a heading that sorts looks exactly like
            one that does not, and nobody finds out it can be clicked. */}
        <span className={active ? 'caret' : 'caret idle'} aria-hidden="true">
          {active ? (sorted.dir === 'asc' ? '▲' : '▼') : '⇅'}
        </span>
      </button>
      {after}
    </th>
  )
}

/**
 * Sort state for a table whose rows arrive in an order of their own.
 *
 * A column starts at its natural end — a name A→Z, a number or a date biggest first — and pressing
 * it again turns it round. Pressing it a third time hands the table back to the order it arrived
 * in, because that order is not any one column (sessions keep a subagent under the session that
 * started it) and there would otherwise be no way back to it short of reloading the page.
 *
 * A table whose arrival order *is* one of its columns says so with `initial`. That column is then
 * marked from the first paint, and pressing the column in force only ever turns it round: the
 * order it arrived in is one of the two it already offers.
 */
export function useSort<K extends string>(
  natural: (key: K) => Direction,
  initial: Sorted<K> | null = null,
): [Sorted<K> | null, (key: K) => void] {
  const [sorted, setSorted] = useState<Sorted<K> | null>(initial)
  const press = (key: K): void => {
    const first = natural(key)
    const flipped: Direction = sorted?.dir === 'asc' ? 'desc' : 'asc'
    if (sorted === null || sorted.key !== key) setSorted({ key, dir: first })
    else if (initial !== null || sorted.dir === first) setSorted({ key, dir: flipped })
    else setSorted(null)
  }
  return [sorted, press]
}

/**
 * Rows in the order a heading says, with blanks last whichever way it points.
 *
 * An unknown value is not a small one, and turning the arrow round should not march the blanks to
 * the top. Ties keep the order the rows arrived in, so the same data lists the same way every time.
 * With nothing sorted, the rows come back as they arrived.
 */
export function ordered<T, K extends string>(
  rows: T[],
  sorted: Sorted<K> | null,
  value: (row: T, key: K) => number | string | null,
): T[] {
  if (sorted === null) return rows
  const flip = sorted.dir === 'asc' ? 1 : -1
  return rows
    .map((row, at) => ({ row, at, value: value(row, sorted.key) }))
    .sort((a, b) => {
      if (a.value === null || b.value === null) {
        return a.value === b.value ? a.at - b.at : a.value === null ? 1 : -1
      }
      const by =
        typeof a.value === 'string' && typeof b.value === 'string'
          ? a.value.localeCompare(b.value, undefined, { sensitivity: 'base', numeric: true })
          : Number(a.value) - Number(b.value)
      return flip * by || a.at - b.at
    })
    .map((one) => one.row)
}

/** Text reads A→Z first; everything else — a count, a size, a cost, a time — biggest first. */
export function naturalFor<K extends string>(...text: K[]): (key: K) => Direction {
  return (key) => (text.includes(key) ? 'asc' : 'desc')
}

/** An ISO time as something to sort by, or null when there is none. */
export function instant(at: string | null | undefined): number | null {
  if (at === null || at === undefined) return null
  const parsed = Date.parse(at)
  return Number.isNaN(parsed) ? null : parsed
}
