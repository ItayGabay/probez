import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'

import type { CopilotVsCall } from './copilot-vs-log.js'
import { applyTiming, inputChars, truncateInput } from './extract.js'
import type { HeadHistory } from './git.js'
import { decodeAll, type MsgpackValue } from './msgpack.js'
import type { Round, RoundEvent, ToolCall } from './types.js'

type Obj = { [key: string]: MsgpackValue }

function asObj(v: MsgpackValue | undefined): Obj | null {
  if (v === undefined || v === null || typeof v !== 'object') return null
  if (Array.isArray(v) || Buffer.isBuffer(v)) return null
  return v as Obj
}

function asArr(v: MsgpackValue | undefined): MsgpackValue[] | null {
  return Array.isArray(v) ? v : null
}

function asStr(v: MsgpackValue | undefined): string | null {
  return typeof v === 'string' && v !== '' ? v : null
}

/**
 * Visual Studio wraps most things in `[typeTag, payload]` pairs — a compiled-in union index this
 * decoder has no table for, so every lookup here goes by field shape instead of by the number.
 * `payload` is unwrapped whether or not the pair is actually there, since a future release could
 * drop the wrapper on some item and the fields would still mean the same thing.
 */
function payloadOf(v: MsgpackValue | undefined): Obj | null {
  const arr = asArr(v)
  if (arr !== null && arr.length === 2) return asObj(arr[1])
  return asObj(v)
}

function contentItems(content: MsgpackValue | undefined): Obj[] {
  const arr = asArr(content)
  if (arr === null) return []
  const out: Obj[] = []
  for (const entry of arr) {
    const obj = payloadOf(entry)
    if (obj !== null) out.push(obj)
  }
  return out
}

/**
 * The plaintext of a turn's content blocks, in file order.
 *
 * Some blocks (Copilot's reasoning) carry only `EncryptedContent` — an at-rest-encrypted blob
 * probez has no key for — and their `Content` is null. Those are skipped rather than guessed at;
 * see `thinking_chars` on the built round, which stays 0 for the same reason.
 */
function textOf(content: MsgpackValue | undefined): string {
  const parts: string[] = []
  for (const item of contentItems(content)) {
    if (typeof item.Content === 'string' && item.Content !== '') parts.push(item.Content)
  }
  return parts.join('\n')
}

function modelOf(value: MsgpackValue | undefined): string | null {
  const model = asObj(value)
  if (model === null) return null
  return asStr(model.Family) ?? asStr(model.ModelId)
}

/**
 * A content block is a tool call when it carries a `Function`, whatever its type tag. `Result` is
 * left unread: it is another polymorphic `ValueContainer`, not a plain string, so there is no
 * honest character count to give it — `result_chars` stays null, the same call `is_error` makes,
 * since the one `Status` value seen so far (a plain success) is not enough to know what a failure
 * looks like.
 */
function toolsOf(content: MsgpackValue | undefined): ToolCall[] {
  const out: ToolCall[] = []
  for (const item of contentItems(content)) {
    const fn = asObj(item.Function)
    if (fn === null) continue
    const name = asStr(fn.Name)
    const idArr = asArr(fn.Id)
    const id = idArr !== null ? asStr(idArr[0]) : null
    const args = payloadOf(fn.Arguments)
    let input: unknown = args
    let rawForSize: unknown = args
    if (args !== null && typeof args.json === 'string') {
      rawForSize = args.json
      try {
        input = JSON.parse(args.json)
      } catch {
        input = args.json
      }
    }
    out.push({
      name,
      id,
      input: truncateInput(input),
      input_chars: inputChars(rawForSize),
      result_chars: null,
      is_error: null,
      error_kind: null,
      stderr_chars: null,
      interrupted: null,
      patch: null,
      emitted_at: null,
      result_at: null,
      ms: null,
    })
  }
  return out
}

/**
 * Put a request's logged model calls onto the round that answered it.
 *
 * A round here is one response, and an agent response is several model calls — one per tool step —
 * each sending the whole conversation again. So the billed counts are the calls summed, the way
 * every other source's round is billed, while the context the round reached is the largest single
 * prompt among them: the sum would be a size no window ever held. The window is Copilot's own cap
 * on that model, from the same log, when the log listed it.
 *
 * `InputTokenCount` already counts its cached tokens, as OpenAI's `prompt_tokens` does, so uncached
 * is what is left after them. Nothing is ever charged as a cache write: OpenAI bills none.
 */
function applyCalls(round: Round, calls: CopilotVsCall[]): void {
  let input = 0
  let cached = 0
  let output = 0
  let peak = 0
  let window: number | null = null
  for (const call of calls) {
    input += call.input_tokens
    cached += Math.min(call.cached_tokens ?? 0, call.input_tokens)
    output += call.output_tokens ?? 0
    peak = Math.max(peak, call.input_tokens)
    if (call.max_prompt_tokens !== null) window = Math.max(window ?? 0, call.max_prompt_tokens)
  }
  round.in_tokens = input
  round.in_uncached = input - cached
  round.in_cache_read = cached
  round.in_cache_write = 0
  round.in_cache_write_5m = 0
  round.in_cache_write_1h = 0
  round.out_tokens = output
  round.context_tokens = peak
  round.context_window = window
  // The session file names the model the person picked; the log names the one that answered.
  const model = calls.find((call) => call.model !== null)?.model
  if (round.model === null && model !== undefined && model !== null) round.model = model
}

/**
 * Assemble rounds from a Visual Studio GitHub Copilot Chat session (`msgpack.ts` decodes the file).
 *
 * The format gives no per-turn timestamp at all — only one `TimeCreated` for the whole session —
 * so only the session's first round gets a real `ts`, taken as the moment the thread was created,
 * which is also the moment its first message was sent. Every later round's `ts`, and every round's
 * `ms`/`gen_ms`/`wait_ms`, stays null: an honest gap rather than a timestamp invented from the file
 * order.
 *
 * Nothing in the file measures usage. `calls` is what Visual Studio's own log recorded for this
 * session (`copilot-vs-log.ts`), joined by `CorrelationId`: a round whose request has calls gets
 * real tokens, cost and context, and one whose log was gone before probez read it keeps them null.
 * A request Copilot answered more than once (a regenerated answer) has calls the log cannot divide
 * between its responses, so those rounds stay null too rather than each claiming the whole.
 *
 * A turn pair is `[typeTag, { CorrelationId, ... }]`; the request and its response(s) share one
 * `CorrelationId`, which is what pairs them without leaning on the tag. A `CorrelationId` with more
 * than one response (Copilot regenerated an answer) yields one round per response, all under the
 * same task.
 */
export async function extractCopilotVsSession(
  file: string,
  sessionId: string,
  head: HeadHistory | null = null,
  calls: CopilotVsCall[] = [],
): Promise<Round[]> {
  // The log names a session by its file's name, which probez's own id carries behind a `vs-`.
  const conversation = basename(file).toLowerCase()
  const callsByRequest = new Map<string, CopilotVsCall[]>()
  for (const call of calls) {
    if (call.conversation_id.toLowerCase() !== conversation) continue
    const bucket = callsByRequest.get(call.correlation_id)
    if (bucket === undefined) callsByRequest.set(call.correlation_id, [call])
    else bucket.push(call)
  }

  let buf: Buffer
  try {
    buf = await readFile(file)
  } catch {
    return []
  }

  const values = decodeAll(buf)

  let sessionCreatedAt: string | null = null
  for (const value of values) {
    const obj = asObj(value)
    if (obj !== null && typeof obj.TimeCreated === 'string') {
      sessionCreatedAt = obj.TimeCreated
      break
    }
  }

  const order: string[] = []
  const groups = new Map<string, Obj[]>()
  for (const value of values) {
    const arr = asArr(value)
    if (arr === null || arr.length !== 2) continue
    const payload = asObj(arr[1])
    const correlationId = payload === null ? null : asStr(payload.CorrelationId)
    if (correlationId === null) continue
    let bucket = groups.get(correlationId)
    if (bucket === undefined) {
      bucket = []
      groups.set(correlationId, bucket)
      order.push(correlationId)
    }
    bucket.push(payload!)
  }

  const rounds: Round[] = []
  let taskNo = 0
  for (const correlationId of order) {
    const turns = groups.get(correlationId)!
    if (turns.length < 2) continue // a request with no response yet has no round to build
    taskNo += 1
    const request = turns[0]!
    const userText = textOf(request.Content)
    const model = modelOf(request.Model)

    for (let i = 1; i < turns.length; i++) {
      const response = turns[i]!
      const events: RoundEvent[] = []
      let ts: string | null = null
      if (rounds.length === 0 && sessionCreatedAt !== null) {
        ts = sessionCreatedAt
        if (userText !== '') events.push({ type: 'user_message', ts: sessionCreatedAt, chars: userText.length })
      }

      const round: Round = {
        session: sessionId,
        round: rounds.length,
        task: taskNo,
        commit: head === null ? null : head.at(ts === null ? null : Date.parse(ts)),
        agent: 'main',
        id: asStr(response.MessageId) ?? `${sessionId}#r${rounds.length}`,
        ts,
        ms: null,
        gen_ms: null,
        wait_ms: null,
        first_input: userText !== '' ? 'user_message' : null,
        model,
        in_tokens: null,
        in_uncached: null,
        in_cache_write: null,
        in_cache_write_5m: null,
        in_cache_write_1h: null,
        in_cache_read: null,
        out_tokens: null,
        context_tokens: null,
        context_window: null,
        compaction: null,
        mcp_server: null,
        mcp_tool: null,
        skill: null,
        user_text: userText,
        text: textOf(response.Content),
        thinking_chars: 0,
        tools: toolsOf(response.Content),
        events,
      }
      const logged = callsByRequest.get(correlationId)
      if (logged !== undefined && turns.length === 2) applyCalls(round, logged)
      applyTiming(round)
      rounds.push(round)
    }
  }

  return rounds
}
