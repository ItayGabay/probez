import { useState } from 'react'

import { duration, shortId, tokens } from '../format'
import { readingKey } from '../api'
import { ASK_MEANING, ASKS, askTitle } from '../categories'
import { linkProps } from '../router'
import { naturalFor, ordered, SortHead, useSort } from './SortHead'
import type { Call, Question, Reading } from '../api'
import type { ReactElement } from 'react'

/** The columns every call-by-call table has. A question adds Asked to them, a trail Followed. */
export type CallSort = 'round' | 'reached' | 'call'

const REACH: Record<Call['scope'], number> = { tree: 0, dir: 1, file: 2, span: 3 }

/**
 * What a shared call-by-call column sorts by. Round is the order the calls were made in; a reach
 * sorts widest first, the order `scope` runs in, rather than by the word.
 */
export function callValue(call: Call, key: CallSort): number | string {
  switch (key) {
    case 'round':
      return call.at
    case 'reached':
      return REACH[call.scope]
    case 'call':
      return call.text
  }
}

type StepSort = CallSort | 'asked'

// Every one of these reads first to last, A→Z or widest first.
const stepNatural = naturalFor<StepSort>('round', 'reached', 'asked', 'call')

/** A call that searched for no words has nothing under Asked, so it sorts after those that did. */
function stepValue(call: Call, key: StepSort): number | string | null {
  if (key === 'asked') return call.probes.length === 0 ? null : call.probes.join(' ')
  return callValue(call, key)
}

type QuestionSort =
  | 'question'
  | 'calls'
  | 'again'
  | 'fetch'
  | 'guess'
  | 'kind'
  | 'about'
  | 'in'
  | 'time'

const questionNatural = naturalFor<QuestionSort>('question', 'kind', 'about')

/**
 * One question, call by call.
 *
 * `TrailPanel` shows a walk: what each hop had to go on, and where it landed. This shows the other
 * reading of the same calls — what the agent was trying to learn, and every call it spent. The
 * difference is the repeats. A walk's edges exist only where a call narrowed, so asking the same
 * thing a sixth time joins no walk and appears nowhere in that panel; here it is a row like any
 * other, marked, and counted in the header.
 *
 * A row is a call, so clicking one selects that round exactly as clicking its cell in the strip
 * does. The panel and the trace are two views of one selection, never two selections.
 */
export function QuestionPanel({
  question,
  reading,
  reader,
  stale,
  explaining,
  problem,
  onExplain,
  onPrompt,
  selected,
  onSelect,
  onClose,
}: {
  question: Question
  /** What a model said this question was, if anyone has asked. */
  reading?: Reading | null
  /** The configured reader, or null when there is nothing to run. */
  reader?: string | null
  /** Whether the reading is about calls that have changed since it was made. */
  stale?: boolean
  explaining?: boolean
  problem?: string | null
  /** Ask the reader. `again` replaces a reading already held. Left out, the panel offers nothing. */
  onExplain?: (again: boolean) => void
  /**
   * Fetch the text the reader would be sent, without sending it.
   *
   * The view's half of `probez explain <id> --prompt`: it runs nothing and needs no reader, so it
   * is offered whether or not one is configured. Pasting these calls into a chat you already have
   * open is a way to use probez, not a way around it.
   */
  onPrompt?: () => Promise<string>
  /** The round the inspector is open on, so the question shows where you are in it. */
  selected: number | null
  onSelect: (round: number) => void
  onClose: () => void
}): ReactElement {
  /**
   * The prompt, once someone has asked for it, and how the asking went.
   *
   * Held here rather than fetched with the panel because most questions are never copied, and the
   * text is every call spelled out. `shown` is the fallback that matters: a clipboard is a
   * permission the browser can refuse, and a refusal must still leave the text somewhere a person
   * can select it, or the button lies.
   */
  const [copied, setCopied] = useState(false)
  const [shown, setShown] = useState<string | null>(null)
  const [copying, setCopying] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)

  const copyPrompt = (): void => {
    if (onPrompt === undefined) return
    setCopying(true)
    setFailed(null)
    onPrompt()
      .then(async (text) => {
        try {
          await navigator.clipboard.writeText(text)
          setCopied(true)
          setShown(null)
        } catch {
          // Not an error worth showing as one: the text is here, and this is where it goes.
          setShown(text)
          setCopied(false)
        }
      })
      .catch((error: Error) => setFailed(error.message))
      .finally(() => setCopying(false))
  }

  // Which calls asked something already asked. Marked where it happens rather than only totalled,
  // because the run of them is the finding: a count says four, a column shows which four.
  // Worked out in the order the calls were made, and carried on each call, because "again" means
  // again *after* the first time — re-sorting the rows must not move the mark to the earlier one.
  const seen = new Set<string>()
  const calls = question.calls.map((call) => {
    const signature = `${[...call.probes].sort().join(' ')}\0${[...call.sites].sort().join(' ')}`
    const repeat = seen.has(signature)
    seen.add(signature)
    return { call, repeat }
  })
  const [sorted, sortBy] = useSort<StepSort>(stepNatural)
  const rows = ordered(calls, sorted, ({ call }, key) => stepValue(call, key))

  const waste = [
    question.repeats > 0 ? `${question.repeats} re-asked` : '',
    question.fetches > 0 ? `${question.fetches} fetched a body` : '',
    question.sweeps > 0 ? `${question.sweeps} guessed at words` : '',
  ].filter((part) => part !== '')

  return (
    <div className="trail-panel">
      <div className="trail-head">
        <strong className="mono">
          question {question.ref} → {question.last}
        </strong>
        <span className="muted">
          {question.calls.length} call{question.calls.length === 1 ? '' : 's'} ·{' '}
          {question.files.length === 0
            ? 'no place named'
            : `${question.files.length} place${question.files.length === 1 ? '' : 's'}`}
        </span>
        <span className="tag" title={askTitle(question.kind)}>
          {question.kind}
        </span>
        {waste.length === 0 ? null : <span className="dim">{waste.join(' · ')}</span>}
        <span className="spacer" style={{ flex: 1 }} />
        <span className="muted">
          {duration(question.ms)} · {tokens(question.in_tokens)} in ·{' '}
          {tokens(question.out_tokens)} out
        </span>
        <button className="tag" onClick={onClose}>
          close
        </button>
      </div>

      {/* What a model made of the same calls. It sits under the header and above the evidence,
          because that is where it belongs in the argument: the header is the measurement, this is
          a reading of it, and the table below is what both are about. `kind` above is never
          rewritten by it — where the two disagree, the disagreement is the interesting part. */}
      {onExplain === undefined && onPrompt === undefined ? null : (
        <div className="reading">
          {onExplain === undefined ? null : reading === null || reading === undefined ? (
            <>
              <button
                className="tag"
                disabled={explaining === true || reader === null}
                onClick={() => onExplain(false)}
              >
                {explaining === true ? 'asking…' : 'explain'}
              </button>
              <span className="muted">
                {reader === null
                  ? 'no reader configured — Settings names the file to write, or copy the ' +
                    'prompt and ask anywhere you like'
                  : `asks ${reader} what these calls were after. Only the calls go.`}
              </span>
            </>
          ) : (
            <>
              <span className="reading-said">{reading.asked}</span>
              {reading.kind === null ? null : (
                <span
                  className="tag"
                  title={`What the reader made of these calls. ${askTitle(reading.kind)}`}
                >
                  {reading.kind === question.kind
                    ? `${reading.kind}, as measured`
                    : `${reading.kind}, not ${question.kind}`}
                </span>
              )}
              {reading.why === '' ? null : <span className="dim">{reading.why}</span>}
              <span className="muted">— {reading.by}</span>
              {stale === true ? (
                <span className="bad">asked of calls that have changed since</span>
              ) : null}
            </>
          )}
          <span className="spacer" style={{ flex: 1 }} />
          {onExplain === undefined || reading === null || reading === undefined ? null : (
            <button className="ghost" disabled={explaining === true} onClick={() => onExplain(true)}>
              {explaining === true ? 'asking…' : 'ask again'}
            </button>
          )}
          {/* Beside asking, never instead of it: the same text either way, and which of the two
              spends anything is the only difference between them. */}
          {onPrompt === undefined ? null : (
            <button
              className="ghost"
              disabled={copying}
              onClick={copyPrompt}
              title="Copies exactly what the reader would be sent — these calls and nothing else — to paste into any chat."
            >
              {copying ? 'copying…' : copied ? 'copied' : 'copy prompt'}
            </button>
          )}
          {problem === null || problem === undefined ? null : (
            <span className="bad">{problem}</span>
          )}
          {failed === null ? null : <span className="bad">{failed}</span>}
          {shown === null ? null : (
            <>
              <span className="muted">
                the browser would not take it — select and copy it from here
              </span>
              <textarea
                className="reading-prompt mono"
                readOnly
                value={shown}
                rows={10}
                onFocus={(event) => event.currentTarget.select()}
              />
            </>
          )}
        </div>
      )}

      <table className="trail-steps">
        {/* Stated, not inferred: see `.trail-steps` in theme.css. The command takes what is left,
            because it is the evidence and the columns before it are the reading of it. */}
        <colgroup>
          <col style={{ width: '4.5rem' }} />
          <col style={{ width: '4.5rem' }} />
          <col style={{ width: '30%' }} />
          <col />
        </colgroup>
        <thead>
          <tr>
            <SortHead label="Round" head="round" sorted={sorted} onSort={sortBy} />
            <SortHead
              label="Reached"
              head="reached"
              sorted={sorted}
              onSort={sortBy}
              title="How wide this call reached: a whole tree, a directory, a file, or a span of lines."
            />
            <SortHead
              label="Asked"
              head="asked"
              sorted={sorted}
              onSort={sortBy}
              title="The words it searched for. ↺ marks a call that asked what this question had already asked."
            />
            <SortHead
              label="Call"
              head="call"
              sorted={sorted}
              onSort={sortBy}
              title="What was actually run. Hover for the whole of it."
            />
          </tr>
        </thead>
        <tbody>
          {rows.map(({ call, repeat }) => (
            <tr
              key={`${call.at}`}
              className={`row${selected === call.round ? ' here' : ''}`}
              onClick={() => onSelect(call.round)}
            >
              <td className="mono">{call.ref}</td>
              <td className="dim nowrap">{call.scope}</td>
              <td className="mono clip" title={call.probes.join(' ')}>
                {call.probes.length === 0 ? (
                  <span className="muted">—</span>
                ) : (
                  call.probes.join(' ')
                )}
                {repeat ? (
                  <span className="dim" title="Asked already, of the same places">
                    {' '}
                    ↺
                  </span>
                ) : null}
              </td>
              {/* The evidence, where the name of the program used to be. `Where` went with it: a
                  command names its own paths, and printing them beside it spent the width the
                  command needed. The title carries the whole of a long one. */}
              <td className="mono clip" title={call.text}>
                {call.text}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/**
 * Questions as a table, costliest first.
 *
 * One table with two callers: the project page lists every question in the store and the task page
 * lists one task's. They differ only in whether a row names its session and whether clicking it
 * navigates or selects, so both are parameters rather than a second table — the columns are the
 * claim this module makes, and two copies of them are two places for the claim to drift.
 *
 * Questions answered in a single call are counted in the note rather than listed. Most questions
 * are one call, and a table that showed them would bury the thirteen-call one under three hundred
 * rows saying nothing went wrong. The tail is the reason to look.
 */
export function QuestionsTable({
  questions,
  readings,
  selected,
  onOpen,
  hrefFor,
  note,
}: {
  questions: Question[]
  /** Readings already asked for, keyed by `readingKey`. A row shows one instead of its terms. */
  readings?: Record<string, Reading>
  /** The `at` of the question being read, when the caller tracks one. */
  selected?: number | null
  onOpen: (question: Question | null) => void
  /** Given, a row is a real link that names its session. Left out, a row is a selection. */
  hrefFor?: (question: Question) => string
  /** What to say under the table, which is the caller's to write: it holds the totals. */
  note?: ReactElement
}): ReactElement {
  // Costliest first is where the table opens, and every other column is a press away.
  const [sorted, sortBy] = useSort<QuestionSort>(questionNatural, { key: 'calls', dir: 'desc' })
  const about = (one: Question): string | null => {
    const read = readings?.[readingKey(one.session, one.task, one.at)]
    if (read !== undefined) return read.asked
    return one.terms.length === 0 ? null : one.terms.join(' ')
  }
  const asked = ordered(
    questions.filter((one) => one.calls.length > 1),
    sorted,
    (one: Question, key: QuestionSort): number | string | null => {
      switch (key) {
        case 'question':
          return hrefFor === undefined ? one.at : `${one.session}#${one.ref}`
        case 'calls':
          return one.calls.length
        case 'again':
          return one.repeats
        case 'fetch':
          return one.fetches
        case 'guess':
          return one.sweeps
        case 'kind':
          return one.kind
        case 'about':
          return about(one)
        case 'in':
          return one.in_tokens
        case 'time':
          return one.ms
      }
    },
  )

  if (questions.length === 0) {
    return <p className="note">Nothing here went looking for anything.</p>
  }

  return (
    <>
      {asked.length === 0 ? (
        <p className="note">
          Every question here was answered in one call. That is what an agent working in a
          repository it already knows looks like.
        </p>
      ) : (
        <table>
          <thead>
            <tr>
              <SortHead label="Question" head="question" sorted={sorted} onSort={sortBy} />
              <SortHead label="Calls" head="calls" sorted={sorted} onSort={sortBy} className="r" />
              <SortHead
                label="Again"
                head="again"
                sorted={sorted}
                onSort={sortBy}
                className="r"
                title="Calls that asked the same words of the same places over again."
              />
              <SortHead
                label="Fetch"
                head="fetch"
                sorted={sorted}
                onSort={sortBy}
                className="r"
                title="Calls that only turned a line number into a body."
              />
              <SortHead
                label="Guess"
                head="guess"
                sorted={sorted}
                onSort={sortBy}
                className="r"
                title="Calls that named three or more different words at once."
              />
              <SortHead
                label="Kind"
                head="kind"
                sorted={sorted}
                onSort={sortBy}
                title="Which of six questions the calls were asking. Hover a kind for what it means."
              />
              <SortHead
                label="Asked about"
                head="about"
                sorted={sorted}
                onSort={sortBy}
                title="The words it searched for — or, where one has been asked for, what a reader said it was after."
              />
              <SortHead label="In" head="in" sorted={sorted} onSort={sortBy} className="r" />
              <SortHead label="Time" head="time" sorted={sorted} onSort={sortBy} className="r" />
            </tr>
          </thead>
          <tbody>
            {asked.map((one) => (
              <tr
                key={`${one.session}-${one.ref}`}
                className={`row${one.at === selected ? ' here' : ''}`}
                onClick={() => onOpen(one.at === selected ? null : one)}
              >
                <td className="mono nowrap">
                  {hrefFor === undefined ? (
                    <>
                      {one.ref} → {one.last}
                    </>
                  ) : (
                    <a {...linkProps(hrefFor(one))}>
                      {shortId(one.session)}#{one.ref}
                    </a>
                  )}
                </td>
                <td className="r num">{one.calls.length}</td>
                <td className={`r num ${one.repeats > 0 ? '' : 'muted'}`}>
                  {one.repeats > 0 ? one.repeats : '·'}
                </td>
                <td className={`r num ${one.fetches > 0 ? '' : 'muted'}`}>
                  {one.fetches > 0 ? one.fetches : '·'}
                </td>
                <td className={`r num ${one.sweeps > 0 ? '' : 'muted'}`}>
                  {one.sweeps > 0 ? one.sweeps : '·'}
                </td>
                <td className="dim" title={askTitle(one.kind)}>
                  {one.kind}
                </td>
                {/* A reading replaces the terms rather than crowding in beside them: the terms are
                    still one hover away, and a column of sentences is the thing worth scanning. */}
                {readings?.[readingKey(one.session, one.task, one.at)] === undefined ? (
                  <td className="muted mono clip" title={one.terms.join(' ')}>
                    {one.terms.length === 0 ? '—' : one.terms.join(' ')}
                  </td>
                ) : (
                  <td className="clip read" title={one.terms.join(' ')}>
                    {readings[readingKey(one.session, one.task, one.at)]!.asked}
                  </td>
                )}
                <td className="r num dim">{tokens(one.in_tokens)}</td>
                <td className="r num dim">{duration(one.ms)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {note}
    </>
  )
}

/** What a question is and what each number means, for the mark beside a table that lists them. */
export function questionsExplained(share?: {
  questions: number
  calls: number
}): ReactElement {
  return (
    <>
      A <strong>question</strong> is one thing the agent needed to know, and every call it spent
      finding out — including the calls that got nowhere. A trail is a walk that went somewhere, and
      its hops exist only where a call narrowed; asking the same thing a sixth time narrows nothing,
      joins no walk, and is invisible there. Here it is counted.
      {share === undefined || share.questions === 0 ? null : (
        <>
          {' '}
          Here that is {(share.calls / share.questions).toFixed(2)} calls per question.
        </>
      )}
      <br />
      <br />
      <span className="tip-key">calls </span>what the answer cost.
      <br />
      <span className="tip-key">again </span>the same words asked of the same places over again.
      <br />
      <span className="tip-key">fetch </span>calls that only turned a line number into a body — the
      second half of locate-then-fetch, which is protocol overhead rather than thinking.
      <br />
      <span className="tip-key">guess </span>calls that named three or more different words at once,
      which is an agent reaching for vocabulary it has not learned yet.
      <br />
      <span className="tip-key">kind </span>which of six questions it was, decided by the first
      rule that reads the calls:
      {ASKS.map((kind, at) => (
        <span key={kind}>
          {at === 0 ? ' ' : ', '}
          <em>{kind}</em> {ASK_MEANING[kind]}
        </span>
      ))}
      . Anything no rule reads is <em>other</em> — a named hole rather than the closest guess. There
      is no <em>path</em> — how does A reach B — because no grep expresses that question, so no
      reading of one can recover it.
      <br />
      <br />
      <span className="tip-key">explain </span>hands one question's calls to a command you name in
      Settings — your own LLM — and keeps the sentence it answers with beside the measurement. It
      runs only when you press it, only on the question you pressed it on, and nothing but those
      calls is sent: no prompts, no tool output.
    </>
  )
}

/** The same, as one sentence, for anything that reads the page aloud. */
export const QUESTIONS_ARIA =
  'A question is one thing the agent needed to know and every call it spent finding out. Calls is ' +
  'what the answer cost; again how many asked something already asked; fetch how many only turned ' +
  'a line number into a body; guess how many named three or more words at once; kind which of six ' +
  'questions it was.'
