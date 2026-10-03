/**
 * Token usage for Visual Studio's GitHub Copilot Chat, read from the diagnostic log Visual Studio
 * writes beside it — the session files themselves record none.
 *
 * Visual Studio logs each model call it makes under `%TEMP%\VSGitHubCopilotLogs`, one
 * `<stamp>_VSGitHubCopilot.chat.log` per launch. Three kinds of line matter here:
 *
 * - `Begin sending message (ConversationId:<session>, CorrelationId:<request>, ...)` opens a
 *   request. `ConversationId` is the session file's name and `CorrelationId` the id the session
 *   file pairs a request with its response by, so the two join exactly.
 * - `[CopilotClient EventType(11)] [{"InputTokenCount":…}]` is one model call's usage. An agent
 *   turn makes several — one per tool step — all before the next `Begin sending message`, and the
 *   line itself names no request, so it belongs to the one most recently begun. That is exact for
 *   one chat at a time; two chat windows answering at once would interleave and cannot be told
 *   apart, which is a limit of what the log says rather than of how it is read.
 * - `ModelsResponse: {...}` lists every model with the prompt cap Copilot enforces on it
 *   (`max_prompt_tokens`), which is lower than what the model's maker allows — 128,000 for
 *   `gpt-5-mini` against OpenAI's 272,000.
 *
 * The log is a diagnostic one, not a published format, and Visual Studio keeps it only briefly: a
 * log from a few weeks back is simply gone, and with it any way to know what those chats used. So
 * every call is copied, on the first collect that sees it, into a sidecar under the data directory,
 * the way Cursor's hook usage is — a store rebuilt after the log has been deleted still has it. A
 * chat whose log was deleted before probez ever read it has no usage, and stays that way.
 */

import { appendFile, mkdir, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

/** Same modes as the store: usage must not be world-readable. */
const DIR_MODE = 0o700
const FILE_MODE = 0o600

/** One model call, as Visual Studio logged it. */
export interface CopilotVsCall {
  /** The session file's name. */
  conversation_id: string
  /** The request this call answered, as the session file pairs it. */
  correlation_id: string
  model: string | null
  /** The whole prompt the call sent, cache reads included. */
  input_tokens: number
  cached_tokens: number | null
  /** Everything the call generated, reasoning included. */
  output_tokens: number | null
  reasoning_tokens: number | null
  /** The prompt cap Copilot enforced on `model` in this log's model list, when it listed it. */
  max_prompt_tokens: number | null
  /** When the call's usage was logged, as an ISO timestamp. */
  ts: string | null
  /** The log line it came from, `<log file>#<line>`, which keeps a re-read from adding it twice. */
  source: string
}

/** Where Visual Studio writes its Copilot logs. */
export function defaultCopilotVsLogDir(): string {
  return join(tmpdir(), 'VSGitHubCopilotLogs')
}

/** Where calls read out of those logs are kept once probez has seen them. */
export function copilotVsUsageFile(dataDir: string): string {
  return join(dataDir, 'copilot-vs-usage.jsonl')
}

function asCount(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null
  return Math.round(value)
}

function asText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

const STAMP = /^\[(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}\.\d{3}) /
const BEGIN = /Begin sending message \(ConversationId:\s*([^,\s]+),\s*CorrelationId:\s*([^,\s)]+)/
const USAGE = /\[CopilotClient EventType\(11\)\] (\[.*\])\s*$/
const MODEL = /^Model: (\S+)\s*$/
const MODELS = /\[CopilotClient\] ModelsResponse: (\{.*\})\s*$/

/**
 * The line's own timestamp. Visual Studio stamps these in UTC, not local time: on a machine three
 * hours ahead of UTC, the line stamped 14:07:17 is the one written as the session file it describes
 * was last saved, at 17:07:17 local.
 */
function stampOf(line: string): string | null {
  const match = STAMP.exec(line)
  if (match === null) return null
  const ms = Date.parse(`${match[1]}T${match[2]}Z`)
  return Number.isNaN(ms) ? null : new Date(ms).toISOString()
}

/** Each listed model's prompt cap, by id and by family, from one `ModelsResponse` body. */
function capsOf(body: string, into: Map<string, number>): void {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return
  }
  const data = (parsed as { data?: unknown } | null)?.data
  if (!Array.isArray(data)) return
  for (const entry of data) {
    if (entry === null || typeof entry !== 'object') continue
    const model = entry as {
      id?: unknown
      capabilities?: { family?: unknown; limits?: { max_prompt_tokens?: unknown } }
    }
    const cap = asCount(model.capabilities?.limits?.max_prompt_tokens)
    if (cap === null || cap === 0) continue
    for (const name of [asText(model.id), asText(model.capabilities?.family)]) {
      if (name !== null && !into.has(name)) into.set(name, cap)
    }
  }
}

type Counts = Pick<
  CopilotVsCall,
  'input_tokens' | 'cached_tokens' | 'output_tokens' | 'reasoning_tokens'
>

/** One usage line's counts, or null when it is not the shape a model call's usage takes. */
function usageOf(body: string): Counts | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return null
  }
  const first = Array.isArray(parsed) ? parsed[0] : parsed
  if (first === null || typeof first !== 'object') return null
  const row = first as Record<string, unknown>
  const input = asCount(row.InputTokenCount)
  if (input === null) return null
  const extra = (row.AdditionalCounts ?? {}) as Record<string, unknown>
  return {
    input_tokens: input,
    cached_tokens:
      asCount(row.CachedInputTokenCount) ?? asCount(extra.prompt_tokens_details_cached_tokens),
    output_tokens: asCount(row.OutputTokenCount),
    reasoning_tokens: asCount(row.ReasoningTokenCount) ?? asCount(extra.reasoning_tokens),
  }
}

/** Every model call one log recorded, in the order it recorded them. */
export function parseCopilotVsLog(text: string, logName: string): CopilotVsCall[] {
  const calls: CopilotVsCall[] = []
  const caps = new Map<string, number>()
  let request: { conversation: string; correlation: string } | null = null
  let model: string | null = null

  const lines = text.split(/\r?\n/)
  for (let at = 0; at < lines.length; at++) {
    const line = lines[at]!
    const models = MODELS.exec(line)
    if (models !== null) {
      capsOf(models[1]!, caps)
      continue
    }
    const begin = BEGIN.exec(line)
    if (begin !== null) {
      request = { conversation: begin[1]!, correlation: begin[2]! }
      model = null
      continue
    }
    const named = MODEL.exec(line)
    if (named !== null) {
      model = named[1]!
      continue
    }
    const usage = USAGE.exec(line)
    if (usage === null) continue
    const counts = usageOf(usage[1]!)
    // Usage logged before any request began — a model warm-up, a title — belongs to no chat turn.
    if (counts === null || request === null) continue
    calls.push({
      conversation_id: request.conversation,
      correlation_id: request.correlation,
      model,
      ...counts,
      max_prompt_tokens: model === null ? null : (caps.get(model) ?? null),
      ts: stampOf(line),
      source: `${logName}#${at + 1}`,
    })
    // A model is named once per response, just above its usage. Clearing it keeps a later call that
    // logged no model from inheriting this one's.
    model = null
  }
  return calls
}

function callFromStored(value: unknown): CopilotVsCall | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  const conversation = asText(row.conversation_id)
  const correlation = asText(row.correlation_id)
  const source = asText(row.source)
  const input = asCount(row.input_tokens)
  if (conversation === null || correlation === null || source === null) return null
  if (input === null) return null
  return {
    conversation_id: conversation,
    correlation_id: correlation,
    model: asText(row.model),
    input_tokens: input,
    cached_tokens: asCount(row.cached_tokens),
    output_tokens: asCount(row.output_tokens),
    reasoning_tokens: asCount(row.reasoning_tokens),
    max_prompt_tokens: asCount(row.max_prompt_tokens),
    ts: asText(row.ts),
    source,
  }
}

/** Every call kept so far. A line that does not read back as one is skipped, not fatal. */
export async function readCopilotVsUsage(dataDir: string): Promise<CopilotVsCall[]> {
  let text: string
  try {
    text = await readFile(copilotVsUsageFile(dataDir), 'utf8')
  } catch {
    return []
  }
  const calls: CopilotVsCall[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      const call = callFromStored(JSON.parse(line))
      if (call !== null) calls.push(call)
    } catch {
      // A torn last line from an interrupted write; the rest of the file is still good.
    }
  }
  return calls
}

/**
 * Copy every call in Visual Studio's logs that probez has not kept yet into the sidecar.
 *
 * Returns how many were added. A missing log directory is not an error — Visual Studio may never
 * have run here, or may have cleared its logs — and adds nothing.
 */
export async function harvestCopilotVsLogs(logDir: string, dataDir: string): Promise<number> {
  let names: string[]
  try {
    names = (await readdir(logDir)).filter((name) => name.endsWith('.chat.log')).sort()
  } catch {
    return 0
  }
  if (names.length === 0) return 0

  const kept = new Set((await readCopilotVsUsage(dataDir)).map((call) => call.source))
  const fresh: CopilotVsCall[] = []
  for (const name of names) {
    let text: string
    try {
      text = await readFile(join(logDir, name), 'utf8')
    } catch {
      continue
    }
    for (const call of parseCopilotVsLog(text, name)) {
      if (!kept.has(call.source)) fresh.push(call)
    }
  }
  if (fresh.length === 0) return 0

  const file = copilotVsUsageFile(dataDir)
  await mkdir(dirname(file), { recursive: true, mode: DIR_MODE })
  await appendFile(file, fresh.map((call) => JSON.stringify(call)).join('\n') + '\n', {
    encoding: 'utf8',
    mode: FILE_MODE,
  })
  return fresh.length
}
