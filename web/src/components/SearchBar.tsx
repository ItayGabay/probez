import { useEffect, useId, useRef, useState } from 'react'
import type { KeyboardEvent, ReactElement } from 'react'

import { api } from '../api'
import type { FacetPayload } from '../api'
import { count } from '../format'
import { go, href } from '../router'
import type { Entity } from '../router'

/**
 * The query bar, on every page.
 *
 * Two things make it worth having rather than a box that filters the table underneath it.
 *
 * **It completes from what the store actually holds.** `tool:` offers the eleven tools this project
 * has really called, with how many rounds each is in, because a list of tools in general is a list
 * you still have to know the answer to use. That is what the index is for as much as speed: the
 * counts are a pass over a column, so offering them costs nothing.
 *
 * **It never punishes you for being half-way through.** Nothing is submitted until Enter or the
 * magnifying glass, the suggestions narrow as you type, and a key that is nearly a field is
 * offered rather than refused. A value already typed in full is not offered again underneath.
 * The parser behind it is written to the same rule — a value that has not arrived yet narrows
 * nothing instead of matching nothing — so a query in progress is always a query.
 *
 * It is deliberately not a live-searching box. A keystroke that reads every project in the store is
 * a keystroke that can take a second, and a list that reorders under your hands while you are still
 * describing what you want is worse than one that waits to be asked.
 */
export function SearchBar({
  slug,
  initial,
  source,
}: {
  slug?: string | null
  initial?: string
  /** Page filter from `?source=`. The clear control drops this along with a typed query. */
  source?: string | null
}): ReactElement {
  const [text, setText] = useState(initial ?? '')
  const [open, setOpen] = useState(false)
  /** The highlighted suggestion, or -1 while none has been moved to. */
  const [at, setAt] = useState(-1)
  const [facets, setFacets] = useState<FacetPayload | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const box = useRef<HTMLDivElement>(null)
  const menuId = useId()

  // The query in the address bar is the query in the box: arriving at a result by link, or by the
  // back button, has to leave the bar saying what produced what is on screen.
  useEffect(() => {
    setText(initial ?? '')
  }, [initial])

  // `/` and ⌘K are the two shortcuts people already try. `/` only outside a field, or it would
  // steal the key from anything else on the page that takes text.
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent): void => {
      const target = event.target as HTMLElement | null
      const typing =
        target !== null &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      if ((event.key === 'k' || event.key === 'K') && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        input.current?.focus()
        input.current?.select()
        return
      }
      if (event.key === '/' && !typing && !event.metaKey && !event.ctrlKey) {
        event.preventDefault()
        input.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Clicking anywhere else closes the menu. Blur alone would fire before a click on a suggestion.
  useEffect(() => {
    const onDown = (event: MouseEvent): void => {
      if (box.current !== null && !box.current.contains(event.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [])

  const word = wordAt(text)
  const colon = word.text.indexOf(':')
  const key = colon === -1 ? null : word.text.slice(0, colon)
  const typed = colon === -1 ? word.text : word.text.slice(colon + 1)

  // The field list is the same table the parser validates against, fetched once; a field's values
  // are fetched when a colon says which field is being talked about.
  useEffect(() => {
    let live = true
    api
      .facets(key ?? undefined, slug)
      .then((found) => {
        if (live) setFacets(found)
      })
      .catch(() => {
        if (live) setFacets(null)
      })
    return () => {
      live = false
    }
  }, [key, slug])

  const options = suggest(facets, key, typed, text.trim() === '').filter(
    // Already typed in full: offering the same atom under the box is noise, not help.
    (option) => option.insert.toLowerCase() !== word.text.toLowerCase(),
  )
  useEffect(() => setAt(-1), [word.text])
  const shown = open && options.length > 0
  const optionId = (index: number): string => `${menuId}-${index}`

  const put = (value: string): void => {
    const next = text.slice(0, word.from) + value + text.slice(word.to)
    setText(next)
    input.current?.focus()
    // The caret goes after what was just completed, so the next thing typed continues the query.
    window.requestAnimationFrame(() => {
      const to = word.from + value.length
      input.current?.setSelectionRange(to, to)
    })
  }

  const submit = (value: string): void => {
    const asked = value.trim()
    if (asked === '') return
    setOpen(false)
    input.current?.blur()
    go(href.search(asked, { slug }))
  }

  /**
   * Drop whatever is narrowing the view: the typed query, a search page, and a `?source=` pin.
   *
   * Typed-but-unsubmitted text is just emptied. Anything already in the URL goes back to the
   * project (or the list) with no filter, which is what a clear next to the box is for.
   */
  const clear = (): void => {
    setText('')
    setOpen(false)
    const onSearch = (initial ?? '') !== ''
    const pinned = source !== undefined && source !== null && source !== ''
    if (onSearch || pinned) {
      go(slug ? href.project(slug) : href.projects())
      return
    }
    input.current?.focus()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Escape') {
      if (open) setOpen(false)
      else input.current?.blur()
      return
    }
    // A closed menu opens on the key that would move into it, rather than needing another keystroke.
    if (!open && event.key === 'ArrowDown' && options.length > 0) {
      event.preventDefault()
      setOpen(true)
      setAt(0)
      return
    }
    if (open && options.length > 0) {
      // Nothing is lit until an arrow is pressed, so the first press lands on the first suggestion
      // rather than stepping past it.
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setAt((was) => (was + 1) % options.length)
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setAt((was) => (was <= 0 ? options.length - 1 : was - 1))
        return
      }
      // Tab completes the lit suggestion, or the first when none has been moved to. Shift+Tab is
      // left alone so the box can still be tabbed out of backwards.
      if (event.key === 'Tab' && !event.shiftKey) {
        event.preventDefault()
        put(options[Math.max(at, 0)]!.insert)
        return
      }
      // Enter takes the highlighted suggestion only when one has been moved to. Otherwise it runs
      // the query, because pressing Enter on something you typed in full must not silently replace
      // it with whatever happened to be first in a list.
      if (event.key === 'Enter' && at >= 0) {
        event.preventDefault()
        put(options[at]!.insert)
        return
      }
    }
    if (event.key === 'Enter') submit(text)
  }

  return (
    <div className="find" ref={box}>
      <button
        type="button"
        className="find-go"
        aria-label="Search"
        title="Search"
        onClick={() => {
          if (text.trim() === '') {
            input.current?.focus()
            return
          }
          submit(text)
        }}
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
          <circle cx="7" cy="7" r="4.5" />
          <path d="M10.4 10.4 L14 14" strokeLinecap="round" />
        </svg>
      </button>
      <input
        ref={input}
        type="search"
        className="find-in"
        value={text}
        spellCheck={false}
        autoComplete="off"
        placeholder={slug === undefined || slug === null ? 'Search every project' : 'Search this project'}
        aria-label="Search"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={shown}
        aria-controls={menuId}
        aria-activedescendant={shown && at >= 0 ? optionId(at) : undefined}
        onChange={(event) => {
          setText(event.target.value)
          setOpen(true)
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
      />
      {text !== '' || (initial ?? '') !== '' || (source ?? '') !== '' ? (
        <button
          type="button"
          className="find-clear"
          aria-label="Clear filter"
          title="Clear filter"
          onClick={clear}
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden>
            <path d="M2 2 L8 8 M8 2 L2 8" strokeLinecap="round" />
          </svg>
        </button>
      ) : (
        <kbd className="find-key" title="Press / or Ctrl+K to search from anywhere">
          /
        </kbd>
      )}
      {/* Said aloud for anyone who cannot see the menu open: how many suggestions there are. */}
      <span className="sr-only" role="status" aria-live="polite">
        {shown ? `${options.length} suggestion${options.length === 1 ? '' : 's'}, arrow keys to choose` : ''}
      </span>
      {shown ? (
        <div className="find-menu">
          {text.trim() === '' ? <p className="find-head">Filter by a field, or type any word</p> : null}
          {/* The options are not buttons: focus stays in the input, which is what makes typing,
              arrowing and completing one motion. `aria-activedescendant` says which one is lit. */}
          <ul id={menuId} role="listbox" aria-label="Suggestions">
            {options.map((option, index) => (
              <li
                key={option.insert + option.label}
                id={optionId(index)}
                role="option"
                aria-selected={index === at}
                className={index === at ? 'on' : undefined}
                onMouseEnter={() => setAt(index)}
                // Focus stays in the input; a blur would take the caret away from the query.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => put(option.insert)}
              >
                <span className="find-name">{option.label}</span>
                <span className="find-says">{option.says}</span>
                {option.rounds === undefined ? null : (
                  <span className="find-count">{count(option.rounds)}</span>
                )}
              </li>
            ))}
          </ul>
          <p className="find-hint" aria-hidden>
            <kbd>↑</kbd>
            <kbd>↓</kbd> choose · <kbd>Tab</kbd> complete · <kbd>Enter</kbd> search · <kbd>Esc</kbd> close
          </p>
        </div>
      ) : null}
    </div>
  )
}

/** What a search counts, offered as tabs on the results page rather than typed as `in:`. */
export const ENTITY_LABEL: Record<Entity, string> = {
  rounds: 'Rounds',
  tasks: 'Tasks',
  sessions: 'Sessions',
  projects: 'Projects',
  questions: 'Questions',
  trails: 'Trails',
}

interface Option {
  label: string
  says: string
  insert: string
  rounds?: number
}

/** The word the caret is in, which is the only part of a query a completion may replace. */
function wordAt(text: string): { text: string; from: number; to: number } {
  let from = text.length
  while (from > 0 && !/\s/.test(text[from - 1]!)) from -= 1
  return { text: text.slice(from), from, to: text.length }
}

/**
 * What to offer for what has been typed so far.
 *
 * On an empty box, every field: the language is only learnable if the box says what it takes before
 * you have had to guess a name. Before a colon, the fields whose name or description matches. After
 * one, that field's values —
 * from the index where it has them, and from the parser's own table where the field is an enum, so
 * `agent:` and `is:` complete even in a store with nothing collected in it yet.
 */
function suggest(
  facets: FacetPayload | null,
  key: string | null,
  typed: string,
  empty: boolean,
): Option[] {
  if (facets === null) return []
  const wanted = typed.toLowerCase()

  if (key === null) {
    if (empty) {
      return facets.fields.map((field) => ({ label: `${field.key}:`, says: field.says, insert: `${field.key}:` }))
    }
    if (wanted === '') return []
    return facets.fields
      .filter((field) => field.key.startsWith(wanted) || field.says.toLowerCase().includes(wanted))
      .slice(0, 8)
      .map((field) => ({ label: `${field.key}:`, says: field.says, insert: `${field.key}:` }))
  }

  const field = facets.fields.find((one) => one.key === key)
  if (field === undefined) return []

  // An enum's values are the parser's, not the store's: they are the whole of what the field can
  // take, and offering only the ones a project happens to contain would hide the rest.
  const listed =
    field.values.length > 0
      ? field.values.map((value) => ({ value, rounds: undefined as number | undefined }))
      : facets.values.map((one) => ({ value: one.value, rounds: one.rounds as number | undefined }))

  return listed
    .filter((one) => one.value.toLowerCase().startsWith(wanted))
    .slice(0, 8)
    .map((one) => ({
      label: `${key}:${one.value}`,
      // Blank rather than the field's description: repeated down eleven rows it says nothing about
      // any of them, and the count on the right is the part worth reading.
      says: '',
      // A value with a space in it has to be quoted, or the query reads it as two atoms.
      insert: `${key}:${/\s/.test(one.value) ? `"${one.value}"` : one.value}`,
      ...(one.rounds === undefined ? {} : { rounds: one.rounds }),
    }))
}
