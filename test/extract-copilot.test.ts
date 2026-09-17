import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { extractCopilotSession } from '../src/extract-copilot.js'

const here = dirname(fileURLToPath(import.meta.url))
const FIXTURE = join(here, '..', '..', 'test', 'fixtures', 'copilot-session.jsonl')

const sessionId = 'aaaa1111-0000-0000-0000-000000000000'
const rounds = await extractCopilotSession(FIXTURE, sessionId)

test('one round per assistant.message, in file order', () => {
  assert.equal(rounds.length, 3)
  assert.deepEqual(
    rounds.map((r) => r.id),
    ['m1', 'm2', 'm3'],
  )
  assert.deepEqual(
    rounds.map((r) => r.round),
    [0, 1, 2],
  )
})

test('a user.message starts a task, and a later one starts another', () => {
  assert.deepEqual(
    rounds.map((r) => r.task),
    [1, 1, 2],
  )
  assert.equal(rounds[0]!.user_text, 'add a health check endpoint')
  assert.equal(rounds[1]!.user_text, '')
  assert.equal(rounds[2]!.user_text, 'run the tests')
})

test('model comes from session.start and follows every round', () => {
  for (const round of rounds) assert.equal(round.model, 'claude-haiku-4.5')
})

test('output tokens are read straight off each round', () => {
  assert.deepEqual(
    rounds.map((r) => r.out_tokens),
    [12, 18, 9],
  )
})

test("a segment's shutdown usage is split across its rounds by output share", () => {
  // The fixture's one segment runs session.start straight through to session.shutdown, whose
  // modelMetrics reports inputTokens: 42000, cacheReadTokens: 38000, cacheWriteTokens: 0 for
  // claude-haiku-4.5 — the same dotted spelling `session.start` recorded. Uncached is
  // 42000 - 38000 - 0 = 4000, split 12:18:9 by each round's own output tokens.
  assert.deepEqual(
    rounds.map((r) => r.in_uncached),
    [1231, 1846, 923],
  )
  assert.deepEqual(
    rounds.map((r) => r.in_cache_read),
    [11692, 17538, 8769],
  )
  for (const round of rounds) {
    assert.equal(round.in_cache_write, 0)
    assert.equal(round.in_cache_write_5m, 0)
    assert.equal(round.in_cache_write_1h, 0)
    assert.equal(round.in_tokens, (round.in_uncached ?? 0) + (round.in_cache_read ?? 0))
  }
})

test('a segment that never reaches a shutdown reports no usage for its rounds', async () => {
  const lines = [
    { type: 'session.start', data: { selectedModel: 'claude-haiku-4.5' }, id: 'e0', timestamp: '2026-01-06T00:00:00.000Z', parentId: null },
    { type: 'user.message', data: { content: 'hello' }, id: 'e1', timestamp: '2026-01-06T00:00:00.100Z', parentId: 'e0' },
    { type: 'assistant.message', data: { messageId: 'm1', content: 'hi', outputTokens: 5 }, id: 'e2', timestamp: '2026-01-06T00:00:01.000Z', parentId: 'e1' },
    // Resumed without ever shutting down: the segment above simply never got priced.
    { type: 'session.resume', data: { selectedModel: 'claude-haiku-4.5' }, id: 'e3', timestamp: '2026-01-06T00:05:00.000Z', parentId: null },
    { type: 'user.message', data: { content: 'again' }, id: 'e4', timestamp: '2026-01-06T00:05:00.100Z', parentId: 'e3' },
    { type: 'assistant.message', data: { messageId: 'm2', content: 'hi again', outputTokens: 7 }, id: 'e5', timestamp: '2026-01-06T00:05:01.000Z', parentId: 'e4' },
    {
      type: 'session.shutdown',
      data: { modelMetrics: { 'claude-haiku-4.5': { usage: { inputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0 } } } },
      id: 'e6',
      timestamp: '2026-01-06T00:05:02.000Z',
      parentId: 'e5',
    },
  ]
  const dir = mkdtempSync(join(tmpdir(), 'probez-copilot-interrupted-'))
  const file = join(dir, 'events.jsonl')
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')

  const built = await extractCopilotSession(file, 'interrupted-session')
  assert.equal(built.length, 2)
  assert.equal(built[0]!.out_tokens, 5)
  assert.equal(built[0]!.in_tokens, null)
  assert.equal(built[1]!.out_tokens, 7)
  assert.equal(built[1]!.in_uncached, 1000)
})

test('a successful tool call carries its input and result', () => {
  const ls = rounds[0]!.tools[0]!
  assert.equal(ls.name, 'powershell')
  assert.equal(ls.id, 'call_1')
  assert.equal((ls.input as { command: string }).command, 'ls')
  assert.equal(ls.result_chars, 'server.ts\npackage.json'.length)
  assert.equal(ls.is_error, false)
  assert.equal(ls.error_kind, null)

  const tests = rounds[2]!.tools[0]!
  assert.equal(tests.name, 'powershell')
  assert.equal((tests.input as { command: string }).command, 'npm test')
  assert.equal(tests.result_chars, '5 passing'.length)
  assert.equal(tests.is_error, false)
})

test('a failed tool call is flagged, with a body the shared rules do not recognise', () => {
  const create = rounds[1]!.tools[0]!
  assert.equal(create.name, 'create')
  assert.equal(create.id, 'call_2')
  assert.equal(create.is_error, true)
  // Copilot's failure body ("Parent directory does not exist") matches none of the
  // Claude/Codex phrasing errorKindOf knows, so it is an honest `other` rather than a guess.
  assert.equal(create.error_kind, 'other')
  assert.equal(create.result_chars, 'Parent directory does not exist'.length)
})

test("a tool's result becomes the next round's leading input event", () => {
  // call_1 finished before m2 was built, so m2 opens on that result rather than on a user turn.
  assert.equal(rounds[1]!.first_input, 'tool_result')
  assert.ok(rounds[1]!.events.some((e) => e.type === 'tool_result' && e.tool_call_id === 'call_1'))
})
