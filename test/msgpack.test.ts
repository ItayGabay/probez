import assert from 'node:assert/strict'
import { test } from 'node:test'

import { decodeAll } from '../src/msgpack.js'

test('primitives: nil, bools, fixints, negative fixints', () => {
  const buf = Buffer.from([0xc0, 0xc2, 0xc3, 0x2a, 0xe0])
  assert.deepEqual(decodeAll(buf), [null, false, true, 42, -32])
})

test('fixstr and str8', () => {
  const short = Buffer.concat([Buffer.from([0xa3]), Buffer.from('cat', 'utf8')])
  const long = Buffer.concat([Buffer.from([0xd9, 40]), Buffer.from('a'.repeat(40), 'utf8')])
  assert.deepEqual(decodeAll(Buffer.concat([short, long])), ['cat', 'a'.repeat(40)])
})

test('fixarray nests correctly', () => {
  // [1, [2, 3]]
  const buf = Buffer.from([0x92, 0x01, 0x92, 0x02, 0x03])
  assert.deepEqual(decodeAll(buf), [[1, [2, 3]]])
})

test('fixmap decodes string keys to a plain object', () => {
  // {"a": 1, "b": "x"}
  const buf = Buffer.concat([
    Buffer.from([0x82]),
    Buffer.from([0xa1]),
    Buffer.from('a'),
    Buffer.from([0x01]),
    Buffer.from([0xa1]),
    Buffer.from('b'),
    Buffer.from([0xa1]),
    Buffer.from('x'),
  ])
  assert.deepEqual(decodeAll(buf), [{ a: 1, b: 'x' }])
})

test('uint16 and int32', () => {
  const u16 = Buffer.from([0xcd, 0x01, 0x00]) // 256
  const i32 = Buffer.alloc(5)
  i32[0] = 0xd2
  i32.writeInt32BE(-70000, 1)
  assert.deepEqual(decodeAll(Buffer.concat([u16, i32])), [256, -70000])
})

test('the timestamp extension decodes to an ISO string', () => {
  const buf = Buffer.alloc(6)
  buf[0] = 0xd6 // fixext4
  buf.writeInt8(-1, 1)
  buf.writeUInt32BE(1_700_000_000, 2)
  assert.deepEqual(decodeAll(buf), [new Date(1_700_000_000 * 1000).toISOString()])
})

test('bin comes back as a Buffer, byte-for-byte', () => {
  const payload = Buffer.from([1, 2, 3, 4])
  const buf = Buffer.concat([Buffer.from([0xc4, payload.length]), payload])
  const [value] = decodeAll(buf)
  assert.ok(Buffer.isBuffer(value))
  assert.deepEqual(value, payload)
})

test('an unknown extension type comes back tagged rather than misread', () => {
  const payload = Buffer.from([9, 9])
  const buf = Buffer.concat([Buffer.from([0xc7, payload.length, 5]), payload])
  assert.deepEqual(decodeAll(buf), [{ extType: 5, bytes: payload }])
})

test('an unrecognised byte stops the walk without throwing, keeping what came before', () => {
  const good = Buffer.from([0x01, 0x02])
  const unknown = Buffer.from([0xc1]) // reserved by the spec, never assigned a meaning
  assert.deepEqual(decodeAll(Buffer.concat([good, unknown])), [1, 2])
})
