import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import type { CopilotVsCall } from '../src/copilot-vs-log.js'
import { extractCopilotVsSession } from '../src/extract-copilot-vs.js'
import { contextShare } from '../src/models.js'
import { costOf, defaultPricing } from '../src/pricing.js'
import {
  packInt,
  requestTurn,
  responseTurn,
  SESSION_CREATED_AT,
  sessionMeta,
  textBlock,
  toolCallBlock,
} from './vs-fixture.js'

const buf = Buffer.concat([
  packInt(1), // format version, ignored
  sessionMeta(),
  requestTurn('corr-1', 'add a health check endpoint', 'gpt-5-mini'),
  responseTurn('corr-1', 'm1', [
    textBlock('Sure, adding it now.'),
    toolCallBlock('edit_file', 'call_1', '{"path":"a.ts"}'),
  ]),
  requestTurn('corr-2', 'run the tests', 'gpt-5-mini'),
  responseTurn('corr-2', 'm2', [toolCallBlock('run_tests', 'call_2', '{}')]),
  // A request with no response yet (the user sent it and nothing answered): no round to build.
  requestTurn('corr-3', 'are you still there', 'gpt-5-mini'),
])

const dir = mkdtempSync(join(tmpdir(), 'probez-copilot-vs-'))
const file = join(dir, 'dcdff605-19d1-41a7-9a57-b81b6e7d93c9')
writeFileSync(file, buf)

const rounds = await extractCopilotVsSession(file, 'vs-dcdff605-19d1-41a7-9a57-b81b6e7d93c9')

test('one round per response turn, grouped by CorrelationId', () => {
  assert.equal(rounds.length, 2)
  assert.deepEqual(
    rounds.map((r) => r.round),
    [0, 1],
  )
  assert.deepEqual(
    rounds.map((r) => r.task),
    [1, 2],
  )
  assert.deepEqual(
    rounds.map((r) => r.id),
    ['m1', 'm2'],
  )
})

test('a dangling request with no response yields no round', () => {
  assert.ok(!rounds.some((r) => r.user_text === 'are you still there'))
})

test('user and assistant text come from the request and response turns', () => {
  assert.equal(rounds[0]!.user_text, 'add a health check endpoint')
  assert.equal(rounds[0]!.text, 'Sure, adding it now.')
  assert.equal(rounds[1]!.user_text, 'run the tests')
  assert.equal(rounds[1]!.text, '')
})

test('model comes from the request turn', () => {
  for (const round of rounds) assert.equal(round.model, 'gpt-5-mini')
})

test('a tool call carries its name, id and parsed arguments', () => {
  const tool = rounds[0]!.tools[0]!
  assert.equal(tool.name, 'edit_file')
  assert.equal(tool.id, 'call_1')
  assert.deepEqual(tool.input, { path: 'a.ts' })
  assert.equal(tool.result_chars, null)
  assert.equal(tool.is_error, null)
})

test('only the first round gets a real timestamp; the format gives no per-turn time', () => {
  assert.equal(rounds[0]!.ts, SESSION_CREATED_AT)
  assert.equal(rounds[0]!.events.length, 1)
  assert.equal(rounds[1]!.ts, null)
  assert.equal(rounds[1]!.events.length, 0)
})

test('usage stays null without the log: nothing in the file measures tokens', () => {
  for (const round of rounds) {
    assert.equal(round.in_tokens, null)
    assert.equal(round.out_tokens, null)
  }
})

function call(correlation: string, input: number, cached: number, output: number): CopilotVsCall {
  return {
    conversation_id: 'dcdff605-19d1-41a7-9a57-b81b6e7d93c9',
    correlation_id: correlation,
    model: 'gpt-5-mini',
    input_tokens: input,
    cached_tokens: cached,
    output_tokens: output,
    reasoning_tokens: 0,
    max_prompt_tokens: 128_000,
    ts: '2026-10-03T14:06:35.592Z',
    source: `vs.chat.log#${input}`,
  }
}

test("a request's logged calls give its round real usage, context and cost", async () => {
  // corr-1 was an agent turn of two model calls: a reply that called a tool, then the one after.
  const id = 'vs-dcdff605-19d1-41a7-9a57-b81b6e7d93c9'
  const logged = await extractCopilotVsSession(file, id, null, [
    call('corr-1', 12_000, 0, 500),
    call('corr-1', 13_000, 12_000, 20),
    // Another session's call with the same request id must not land here.
    { ...call('corr-1', 99_000, 0, 9), conversation_id: 'some-other-session' },
  ])
  const [first, second] = logged
  // Billed counts are the calls summed, the way every other source bills a round.
  assert.equal(first!.in_tokens, 25_000)
  assert.equal(first!.in_cache_read, 12_000)
  assert.equal(first!.in_uncached, 13_000)
  assert.equal(first!.in_cache_write, 0)
  assert.equal(first!.out_tokens, 520)
  // Context is the largest single prompt: no window ever held the sum.
  assert.equal(first!.context_tokens, 13_000)
  assert.equal(first!.context_window, 128_000)
  assert.equal(contextShare(first!), 13_000 / 128_000)
  // gpt-5-mini: $0.25 input, $0.025 cached, $2 output, per million.
  const cost = costOf(first!, defaultPricing())!
  assert.ok(Math.abs(cost - (13_000 * 0.25 + 12_000 * 0.025 + 520 * 2) / 1e6) < 1e-12)

  // corr-2 has no calls — its log was gone before probez read it — and stays unmeasured.
  assert.equal(second!.in_tokens, null)
  assert.equal(second!.context_tokens, null)
  assert.equal(costOf(second!, defaultPricing()), null)
})

test('a regenerated answer leaves its rounds unmeasured, not each claiming the calls', async () => {
  const regenerated = Buffer.concat([
    packInt(1),
    sessionMeta(),
    requestTurn('corr-r', 'explain this', 'gpt-5-mini'),
    responseTurn('corr-r', 'r1', [textBlock('first try')]),
    responseTurn('corr-r', 'r2', [textBlock('second try')]),
  ])
  const regenDir = mkdtempSync(join(tmpdir(), 'probez-copilot-vs-regen-'))
  const regenFile = join(regenDir, 'dcdff605-19d1-41a7-9a57-b81b6e7d93c9')
  writeFileSync(regenFile, regenerated)
  const built = await extractCopilotVsSession(regenFile, 'vs-regen', null, [
    call('corr-r', 5_000, 0, 50),
    call('corr-r', 5_100, 0, 60),
  ])
  assert.equal(built.length, 2)
  for (const round of built) assert.equal(round.in_tokens, null)
})
