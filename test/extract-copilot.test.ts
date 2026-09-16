import assert from 'node:assert/strict'
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

test('usage stays null, even though the log gives a per-round output-token count', () => {
  for (const round of rounds) {
    assert.equal(round.in_tokens, null)
    assert.equal(round.in_uncached, null)
    assert.equal(round.in_cache_write, null)
    assert.equal(round.in_cache_read, null)
    assert.equal(round.out_tokens, null)
  }
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
