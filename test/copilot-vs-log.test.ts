import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  copilotVsUsageFile,
  harvestCopilotVsLogs,
  parseCopilotVsLog,
  readCopilotVsUsage,
} from '../src/copilot-vs-log.js'

const SESSION = '9b58251b-2eca-4d74-8159-b8f7d38b07e7'

/** Usage the way Visual Studio logs it: one JSON line per model call, naming no request. */
function usage(input: number, output: number, cached: number, reasoning: number): string {
  const body = {
    InputTokenCount: input,
    OutputTokenCount: output,
    TotalTokenCount: null,
    CachedInputTokenCount: null,
    ReasoningTokenCount: null,
    AdditionalCounts: { prompt_tokens_details_cached_tokens: cached, reasoning_tokens: reasoning },
  }
  const stamp = '[2026-10-03 14:06:35.592 Conversations V]'
  return `${stamp} [CopilotClient EventType(11)] [${JSON.stringify(body)}]`
}

function begin(correlation: string): string {
  return (
    `[2026-10-03 14:06:25.545 CopilotSessionProvider I] Begin sending message ` +
    `(ConversationId:${SESSION}, CorrelationId:${correlation}, MessageId: ae6a78b0-e9b5-4cae)`
  )
}

const models = {
  data: [
    {
      id: 'gpt-5-mini',
      capabilities: { family: 'gpt-5-mini', limits: { max_prompt_tokens: 128000 } },
    },
    { id: 'gpt-4o-mini', capabilities: { limits: { max_prompt_tokens: 64000 } } },
  ],
}

// Trimmed from a real log: a model list, a call before any request, then two requests — the
// second an agent turn of three calls, as an edit, a build and a final reply make it.
const LOG = [
  `[2026-10-03 14:06:10.000 Conversations V] [CopilotClient] ModelsResponse: ${JSON.stringify(
    models,
  )}`,
  'Model: gpt-4o-mini',
  usage(300, 5, 0, 0),
  begin('48572186-1fab-4b1b-9fed-067e7baf468b'),
  'Status: Success',
  'Model: gpt-5-mini',
  'Usage:',
  '- InputTokenCount: 12261',
  usage(12261, 668, 0, 448),
  begin('afecfe9f-25a7-4482-87fd-0e3428ce2e71'),
  'Model: gpt-5-mini',
  usage(12571, 420, 12160, 192),
  'Model: gpt-5-mini',
  usage(13013, 14, 12800, 0),
  usage(13007, 14, 0, 0),
].join('\r\n')

test('each logged call belongs to the request most recently begun', () => {
  const calls = parseCopilotVsLog(LOG, 'a.chat.log')
  assert.deepEqual(
    calls.map((call) => [call.correlation_id.slice(0, 8), call.input_tokens]),
    [
      ['48572186', 12261],
      ['afecfe9f', 12571],
      ['afecfe9f', 13013],
      ['afecfe9f', 13007],
    ],
  )
  for (const call of calls) assert.equal(call.conversation_id, SESSION)
})

test('a call logged before any request began belongs to no chat turn', () => {
  const calls = parseCopilotVsLog(LOG, 'a.chat.log')
  assert.ok(!calls.some((call) => call.input_tokens === 300))
})

test('a call carries its counts, its model, and the cap Copilot put on that model', () => {
  const [first, second] = parseCopilotVsLog(LOG, 'a.chat.log')
  assert.equal(first!.model, 'gpt-5-mini')
  assert.equal(first!.output_tokens, 668)
  assert.equal(first!.cached_tokens, 0)
  assert.equal(first!.reasoning_tokens, 448)
  assert.equal(first!.max_prompt_tokens, 128000)
  assert.equal(second!.cached_tokens, 12160)
  // Visual Studio stamps its log in UTC.
  assert.equal(first!.ts, '2026-10-03T14:06:35.592Z')
  assert.equal(first!.source, 'a.chat.log#9')
})

test('a call with no model line of its own does not inherit the previous one', () => {
  const last = parseCopilotVsLog(LOG, 'a.chat.log').at(-1)!
  assert.equal(last.model, null)
  assert.equal(last.max_prompt_tokens, null)
})

test('harvesting keeps every call once, however many times the log is read', async () => {
  const logDir = mkdtempSync(join(tmpdir(), 'probez-vs-logs-'))
  const dataDir = mkdtempSync(join(tmpdir(), 'probez-vs-data-'))
  writeFileSync(join(logDir, '20261003_140603.057_VSGitHubCopilot.chat.log'), LOG)
  writeFileSync(join(logDir, 'not-a-chat-log.txt'), usage(1, 1, 0, 0))

  assert.equal(await harvestCopilotVsLogs(logDir, dataDir), 4)
  assert.equal(await harvestCopilotVsLogs(logDir, dataDir), 0)
  assert.equal((await readCopilotVsUsage(dataDir)).length, 4)

  // Visual Studio goes on writing to the same log: only what is new is added.
  const log = join(logDir, '20261003_140603.057_VSGitHubCopilot.chat.log')
  appendFileSync(log, '\r\n' + usage(14000, 30, 13000, 0))
  assert.equal(await harvestCopilotVsLogs(logDir, dataDir), 1)
  assert.equal((await readCopilotVsUsage(dataDir)).length, 5)
})

test('what was harvested outlives the log it came from', async () => {
  const logDir = mkdtempSync(join(tmpdir(), 'probez-vs-logs-'))
  const dataDir = mkdtempSync(join(tmpdir(), 'probez-vs-data-'))
  writeFileSync(join(logDir, 'old_VSGitHubCopilot.chat.log'), LOG)
  await harvestCopilotVsLogs(logDir, dataDir)

  // Visual Studio clears its logs; probez keeps what it already read.
  const emptied = mkdtempSync(join(tmpdir(), 'probez-vs-logs-'))
  assert.equal(await harvestCopilotVsLogs(emptied, dataDir), 0)
  assert.equal((await readCopilotVsUsage(dataDir)).length, 4)
})

test('a missing log directory adds nothing and writes nothing', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'probez-vs-data-'))
  assert.equal(await harvestCopilotVsLogs(join(dataDir, 'nowhere'), dataDir), 0)
  assert.deepEqual(await readCopilotVsUsage(dataDir), [])
})

test('a torn line in the sidecar is skipped, not fatal', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'probez-vs-data-'))
  const logDir = join(dataDir, 'logs')
  mkdirSync(logDir)
  writeFileSync(join(logDir, 'x_VSGitHubCopilot.chat.log'), LOG)
  await harvestCopilotVsLogs(logDir, dataDir)
  appendFileSync(copilotVsUsageFile(dataDir), '{"conversation_id":"half')
  assert.equal((await readCopilotVsUsage(dataDir)).length, 4)
  assert.ok(readFileSync(copilotVsUsageFile(dataDir), 'utf8').includes('half'))
})
