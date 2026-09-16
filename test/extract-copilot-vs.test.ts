import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { extractCopilotVsSession } from '../src/extract-copilot-vs.js'

/**
 * Just enough of a MessagePack encoder to build a fixture, mirroring the handful of shapes a real
 * Visual Studio Copilot Chat session uses. Kept in the test rather than as a checked-in binary
 * fixture, so what the extractor is actually reading stays reviewable as ordinary source.
 */
function packInt(n: number): Buffer {
  if (n >= 0 && n <= 0x7f) return Buffer.from([n])
  if (n < 0 && n >= -32) return Buffer.from([256 + n])
  const b = Buffer.alloc(3)
  b[0] = 0xcd
  b.writeUInt16BE(n, 1)
  return b
}

function packStr(s: string): Buffer {
  const body = Buffer.from(s, 'utf8')
  if (body.length <= 31) return Buffer.concat([Buffer.from([0xa0 | body.length]), body])
  const h = Buffer.alloc(3)
  h[0] = 0xda
  h.writeUInt16BE(body.length, 1)
  return Buffer.concat([h, body])
}

function packArr(items: Buffer[]): Buffer {
  const n = items.length
  const header = n <= 15 ? Buffer.from([0x90 | n]) : packArrHeader(n)
  return Buffer.concat([header, ...items])
}

function packArrHeader(n: number): Buffer {
  const h = Buffer.alloc(3)
  h[0] = 0xdc
  h.writeUInt16BE(n, 1)
  return h
}

function packMap(entries: [string, Buffer][]): Buffer {
  const n = entries.length
  const header = n <= 15 ? Buffer.from([0x80 | n]) : packMapHeader(n)
  const parts: Buffer[] = []
  for (const [key, value] of entries) {
    parts.push(packStr(key), value)
  }
  return Buffer.concat([header, ...parts])
}

function packMapHeader(n: number): Buffer {
  const h = Buffer.alloc(3)
  h[0] = 0xde
  h.writeUInt16BE(n, 1)
  return h
}

function packTimestamp(iso: string): Buffer {
  const b = Buffer.alloc(6)
  b[0] = 0xd6 // fixext4
  b.writeInt8(-1, 1)
  b.writeUInt32BE(Math.floor(Date.parse(iso) / 1000), 2)
  return b
}

/** A `[typeTag, payload]` pair, the wrapper every content block and turn envelope uses. */
function tagged(tag: number, payload: Buffer): Buffer {
  return packArr([packInt(tag), payload])
}

const SESSION_CREATED_AT = '2026-09-15T13:14:46.000Z'

function textBlock(text: string): Buffer {
  return tagged(1, packMap([['Content', packStr(text)]]))
}

function toolCallBlock(name: string, callId: string, argsJson: string): Buffer {
  const fn = packMap([
    ['Id', packArr([packStr(callId)])],
    ['Name', packStr(name)],
    ['Arguments', tagged(0, packMap([['json', packStr(argsJson)]]))],
  ])
  return tagged(7, packMap([['Function', fn]]))
}

function requestTurn(correlationId: string, userText: string, model: string): Buffer {
  return tagged(
    0,
    packMap([
      ['CorrelationId', packStr(correlationId)],
      ['Content', packArr([textBlock(userText)])],
      ['Model', packMap([['Family', packStr(model)]])],
    ]),
  )
}

function responseTurn(correlationId: string, messageId: string, content: Buffer[]): Buffer {
  return tagged(
    1,
    packMap([
      ['CorrelationId', packStr(correlationId)],
      ['MessageId', packStr(messageId)],
      ['Content', packArr(content)],
    ]),
  )
}

const sessionMeta = packMap([['TimeCreated', packTimestamp(SESSION_CREATED_AT)]])

const buf = Buffer.concat([
  packInt(1), // format version, ignored
  sessionMeta,
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

test('usage stays null: nothing in the file measures tokens', () => {
  for (const round of rounds) {
    assert.equal(round.in_tokens, null)
    assert.equal(round.out_tokens, null)
  }
})
