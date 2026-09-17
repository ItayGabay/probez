import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'

import { isSubagent } from './agents/paths.js'
import { errorKindOf } from './errors.js'
import { applyTiming, contentChars, inputChars, toText, truncateInput } from './extract.js'
import type { HeadHistory } from './git.js'
import type { Round, RoundEvent, ToolCall } from './types.js'

type Json = Record<string, unknown>

/**
 * The `type` values GitHub Copilot CLI's `events.jsonl` uses. Every line is `{type, data, id,
 * timestamp, parentId}` — the dotted `type` and the `data` key are what tell a Copilot line apart
 * from Codex's `{type, payload}` envelope and from Claude/Cursor's undotted `type`/`role`.
 */
const COPILOT_ENVELOPE = new Set([
  'session.start',
  'session.resume',
  'session.shutdown',
  'system.message',
  'user.message',
  'assistant.turn_start',
  'assistant.message',
  'assistant.turn_end',
  'tool.execution_start',
  'tool.execution_complete',
])

export function isCopilotRecord(row: Record<string, unknown>): boolean {
  return typeof row.type === 'string' && COPILOT_ENVELOPE.has(row.type) && 'data' in row
}

function asText(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

function dataOf(record: Json): Json {
  const raw = record.data
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Json) : {}
}

function stampOf(record: Json): string | null {
  return typeof record.timestamp === 'string' ? record.timestamp : null
}

function parseTs(value: string | null): number | null {
  if (value === null) return null
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? null : ms
}

/** The text of a tool's result, whichever of the two shapes `tool.execution_complete` used. */
function resultTextOf(data: Json): string {
  if (data.success === false) {
    const error = data.error
    if (error && typeof error === 'object' && !Array.isArray(error)) {
      return asText((error as Json).message) ?? ''
    }
    return ''
  }
  const result = data.result
  if (!result || typeof result !== 'object' || Array.isArray(result)) return ''
  const r = result as Json
  return asText(r.detailedContent) ?? asText(r.content) ?? ''
}

interface ToolEntry {
  tool: ToolCall
  emittedTs: number | null
}

/**
 * Assemble rounds from a GitHub Copilot CLI session's `events.jsonl`.
 *
 * Unlike Claude's log, one `assistant.message` record already carries a turn's full text and tool
 * requests in one line rather than being built up from several — so a round is built the instant
 * that record arrives, with no open/flush state to carry across the read. What follows it
 * (`tool.execution_start`/`tool.execution_complete`) only enriches the `ToolCall` objects already
 * sitting in `round.tools`, which are ordinary JS references and so are updated in place.
 *
 * A tool's result becomes the *next* round's leading input event, exactly as a `tool_result` does
 * for Claude and Codex — the model that reads it is answering in the round after the one that
 * called the tool, not the one that called it.
 *
 * `assistant.turn_start`/`assistant.turn_end` are not used for round boundaries: this session's
 * sample data ties them 1:1 to `assistant.message`, which would make them redundant, but nothing
 * in the format guarantees that stays true, and building directly off `assistant.message` is
 * correct either way.
 *
 * Usage is never set. `events.jsonl` gives a real output-token count per turn but only a
 * cumulative, per-model running total for input tokens, checkpointed at `session.shutdown` rather
 * than scoped to one round — and `costOf` (`src/pricing.ts`) treats a missing input count as zero,
 * not unmeasured, so recording the output half alone would silently price a round far under what
 * it actually cost. Left null throughout, the same call Cursor's extractor makes for the same
 * reason: an honest "not recorded" beats a plausible-looking partial number.
 *
 * Subagent delegation is not modelled: nothing observed in a real session names a nested-session
 * convention the way Claude/Cursor's `subagents/` path or Codex's `session_meta.source` does.
 */
export async function extractCopilotSession(
  file: string,
  sessionId: string,
  head: HeadHistory | null = null,
): Promise<Round[]> {
  const rounds: Round[] = []
  const toolById = new Map<string, ToolEntry>()
  const agent = isSubagent(sessionId) ? 'sub' : 'main'

  let model: string | null = null
  let pendingEvents: RoundEvent[] = []
  let pendingTextParts: string[] = []
  let pendingWait: number | null = null
  let lastOutputTs: number | null = null
  let task = 0
  let taskUsed = false
  let taskStart: number | null = null
  let index = 0

  const noteOutput = (timestamp: string | null): void => {
    const ts = parseTs(timestamp)
    if (ts !== null && (lastOutputTs === null || ts > lastOutputTs)) lastOutputTs = ts
  }

  const stream = createReadStream(file, { encoding: 'utf8' })
  const lines = createInterface({ input: stream, crlfDelay: Infinity })

  for await (const line of lines) {
    if (line.trim() === '') continue

    let record: Json
    try {
      const parsed: unknown = JSON.parse(line)
      if (!parsed || typeof parsed !== 'object') continue
      record = parsed as Json
    } catch {
      continue
    }

    const kind = typeof record.type === 'string' ? record.type : ''
    const data = dataOf(record)
    const timestamp = stampOf(record)
    const ts = parseTs(timestamp)

    if (kind === 'session.start' || kind === 'session.resume') {
      const named = asText(data.selectedModel)
      if (named !== null) model = named
      continue
    }

    if (kind === 'user.message') {
      const text = asText(data.content) ?? toText(data.content)
      if (text === '') continue
      pendingTextParts.push(text)
      if (timestamp !== null) {
        pendingEvents.push({ type: 'user_message', ts: timestamp, chars: text.length })
        if (pendingWait === null && lastOutputTs !== null && ts !== null) {
          pendingWait = ts - lastOutputTs
        }
      }
      if (task === 0 || taskUsed) {
        task += 1
        taskUsed = false
        taskStart = ts
      }
      continue
    }

    if (kind === 'tool.execution_start') {
      const callId = asText(data.toolCallId)
      if (callId === null) continue
      const entry = toolById.get(callId)
      if (entry !== undefined) {
        entry.emittedTs = ts
        entry.tool.emitted_at = timestamp
      }
      continue
    }

    if (kind === 'tool.execution_complete') {
      const callId = asText(data.toolCallId)
      const named = asText(data.model)
      if (named !== null) model = named
      if (callId !== null) {
        const entry = toolById.get(callId)
        if (entry !== undefined) {
          const text = resultTextOf(data)
          entry.tool.result_chars = text.length
          entry.tool.is_error = typeof data.success === 'boolean' ? data.success === false : null
          if (entry.tool.is_error) {
            entry.tool.error_kind = errorKindOf(text, entry.tool.name, entry.tool.input)
          }
          entry.tool.result_at = timestamp
          entry.tool.ms = entry.emittedTs !== null && ts !== null ? ts - entry.emittedTs : null
        }
        if (timestamp !== null) {
          const chars = entry === undefined ? resultTextOf(data).length : entry.tool.result_chars ?? 0
          pendingEvents.push({ type: 'tool_result', ts: timestamp, chars, tool_call_id: callId })
        }
      }
      noteOutput(timestamp)
      continue
    }

    if (kind !== 'assistant.message') continue

    const id = asText(data.messageId) ?? `${sessionId}#r${index}`
    index += 1
    const round: Round = {
      session: sessionId,
      round: rounds.length,
      task: task === 0 ? 1 : task,
      commit: head === null ? null : head.at(taskStart ?? ts),
      agent,
      id,
      ts: timestamp,
      ms: null,
      gen_ms: null,
      wait_ms: pendingWait,
      first_input: null,
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
      user_text: pendingTextParts.join('\n'),
      text: '',
      thinking_chars: 0,
      tools: [],
      events: pendingEvents,
    }
    pendingEvents = []
    pendingTextParts = []
    pendingWait = null
    taskUsed = true

    const text = asText(data.content) ?? toText(data.content)
    round.text = text
    if (text !== '' && timestamp !== null) {
      round.events.push({ type: 'text', ts: timestamp, chars: text.length })
    }

    const reasoning = data.reasoningText
    if (typeof reasoning === 'string' && reasoning !== '') {
      const chars = contentChars(reasoning)
      round.thinking_chars += chars
      if (timestamp !== null) round.events.push({ type: 'reasoning', ts: timestamp, chars })
    }

    const requests = data.toolRequests
    if (Array.isArray(requests)) {
      for (const raw of requests) {
        if (!raw || typeof raw !== 'object') continue
        const item = raw as Json
        const callId = asText(item.toolCallId)
        if (callId === null || toolById.has(callId)) continue
        const tool: ToolCall = {
          name: asText(item.name),
          id: callId,
          input: truncateInput(item.arguments),
          input_chars: inputChars(item.arguments),
          result_chars: null,
          is_error: null,
          error_kind: null,
          stderr_chars: null,
          interrupted: null,
          patch: null,
          emitted_at: timestamp,
          result_at: null,
          ms: null,
        }
        round.tools.push(tool)
        toolById.set(callId, { tool, emittedTs: ts })
        if (timestamp !== null) round.events.push({ type: 'tool_call', ts: timestamp, tool_call_id: callId })
      }
    }

    applyTiming(round)
    rounds.push(round)
    noteOutput(timestamp)
  }

  for (let i = 0; i < rounds.length; i++) rounds[i]!.round = i
  return rounds
}
