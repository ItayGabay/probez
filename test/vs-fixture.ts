// Builders for Visual Studio Copilot Chat session files, shared by the tests that need one.

/**
 * Just enough of a MessagePack encoder to build a fixture, mirroring the handful of shapes a real
 * Visual Studio Copilot Chat session uses. Kept in the test rather than as a checked-in binary
 * fixture, so what the extractor is actually reading stays reviewable as ordinary source.
 */
export function packInt(n: number): Buffer {
  if (n >= 0 && n <= 0x7f) return Buffer.from([n])
  if (n < 0 && n >= -32) return Buffer.from([256 + n])
  const b = Buffer.alloc(3)
  b[0] = 0xcd
  b.writeUInt16BE(n, 1)
  return b
}

export function packStr(s: string): Buffer {
  const body = Buffer.from(s, 'utf8')
  if (body.length <= 31) return Buffer.concat([Buffer.from([0xa0 | body.length]), body])
  const h = Buffer.alloc(3)
  h[0] = 0xda
  h.writeUInt16BE(body.length, 1)
  return Buffer.concat([h, body])
}

export function packArr(items: Buffer[]): Buffer {
  const n = items.length
  const header = n <= 15 ? Buffer.from([0x90 | n]) : packArrHeader(n)
  return Buffer.concat([header, ...items])
}

export function packArrHeader(n: number): Buffer {
  const h = Buffer.alloc(3)
  h[0] = 0xdc
  h.writeUInt16BE(n, 1)
  return h
}

export function packMap(entries: [string, Buffer][]): Buffer {
  const n = entries.length
  const header = n <= 15 ? Buffer.from([0x80 | n]) : packMapHeader(n)
  const parts: Buffer[] = []
  for (const [key, value] of entries) {
    parts.push(packStr(key), value)
  }
  return Buffer.concat([header, ...parts])
}

export function packMapHeader(n: number): Buffer {
  const h = Buffer.alloc(3)
  h[0] = 0xde
  h.writeUInt16BE(n, 1)
  return h
}

export function packTimestamp(iso: string): Buffer {
  const b = Buffer.alloc(6)
  b[0] = 0xd6 // fixext4
  b.writeInt8(-1, 1)
  b.writeUInt32BE(Math.floor(Date.parse(iso) / 1000), 2)
  return b
}

/** A `[typeTag, payload]` pair, the wrapper every content block and turn envelope uses. */
export function tagged(tag: number, payload: Buffer): Buffer {
  return packArr([packInt(tag), payload])
}

export const SESSION_CREATED_AT = '2026-09-15T13:14:46.000Z'

export function textBlock(text: string): Buffer {
  return tagged(1, packMap([['Content', packStr(text)]]))
}

export function toolCallBlock(name: string, callId: string, argsJson: string): Buffer {
  const fn = packMap([
    ['Id', packArr([packStr(callId)])],
    ['Name', packStr(name)],
    ['Arguments', tagged(0, packMap([['json', packStr(argsJson)]]))],
  ])
  return tagged(7, packMap([['Function', fn]]))
}

export function requestTurn(correlationId: string, userText: string, model: string): Buffer {
  return tagged(
    0,
    packMap([
      ['CorrelationId', packStr(correlationId)],
      ['Content', packArr([textBlock(userText)])],
      ['Model', packMap([['Family', packStr(model)]])],
    ]),
  )
}

export function responseTurn(correlationId: string, messageId: string, content: Buffer[]): Buffer {
  return tagged(
    1,
    packMap([
      ['CorrelationId', packStr(correlationId)],
      ['MessageId', packStr(messageId)],
      ['Content', packArr(content)],
    ]),
  )
}

/** The session-level record that carries `TimeCreated`. */
export function sessionMeta(createdAt = SESSION_CREATED_AT): Buffer {
  return packMap([['TimeCreated', packTimestamp(createdAt)]])
}
