import { readFile } from 'node:fs/promises'

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
 * Assemble rounds from a Visual Studio GitHub Copilot Chat session (`msgpack.ts` decodes the file).
 *
 * The format gives no per-turn timestamp at all — only one `TimeCreated` for the whole session —
 * so only the session's first round gets a real `ts`, taken as the moment the thread was created,
 * which is also the moment its first message was sent. Every later round's `ts`, and every round's
 * `ms`/`gen_ms`/`wait_ms`, stays null: an honest gap rather than a timestamp invented from the file
 * order. Usage is never set, for the same reason it stays null for Copilot CLI and Cursor — nothing
 * in the file measures it.
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
): Promise<Round[]> {
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
      applyTiming(round)
      rounds.push(round)
    }
  }

  return rounds
}
