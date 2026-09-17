/**
 * A minimal MessagePack decoder.
 *
 * Visual Studio's GitHub Copilot Chat persists each conversation as a MessagePack-encoded .NET
 * object graph (`extract-copilot-vs.ts` reads it) — there is no npm package worth pulling in for
 * one undocumented, read-only use, so this covers exactly the type bytes real session files use:
 * nil, bool, ints, floats, str, bin, array, map, and the timestamp extension. An extension type
 * this has never seen is not guessed at; it comes back as `{ extType, bytes }` so a caller can
 * skip it rather than misread it.
 */

export type MsgpackValue =
  | null
  | boolean
  | number
  | string
  | Buffer
  | MsgpackValue[]
  | { [key: string]: MsgpackValue }
  | { extType: number; bytes: Buffer }

class Cursor {
  pos = 0
  constructor(readonly buf: Buffer) {}

  done(): boolean {
    return this.pos >= this.buf.length
  }

  u8(): number {
    return this.buf.readUInt8(this.pos++)
  }

  i8(): number {
    const v = this.buf.readInt8(this.pos)
    this.pos += 1
    return v
  }

  u16(): number {
    const v = this.buf.readUInt16BE(this.pos)
    this.pos += 2
    return v
  }

  i16(): number {
    const v = this.buf.readInt16BE(this.pos)
    this.pos += 2
    return v
  }

  u32(): number {
    const v = this.buf.readUInt32BE(this.pos)
    this.pos += 4
    return v
  }

  i32(): number {
    const v = this.buf.readInt32BE(this.pos)
    this.pos += 4
    return v
  }

  u64(): bigint {
    const v = this.buf.readBigUInt64BE(this.pos)
    this.pos += 8
    return v
  }

  i64(): bigint {
    const v = this.buf.readBigInt64BE(this.pos)
    this.pos += 8
    return v
  }

  f32(): number {
    const v = this.buf.readFloatBE(this.pos)
    this.pos += 4
    return v
  }

  f64(): number {
    const v = this.buf.readDoubleBE(this.pos)
    this.pos += 8
    return v
  }

  str(len: number): string {
    const v = this.buf.toString('utf8', this.pos, this.pos + len)
    this.pos += len
    return v
  }

  bin(len: number): Buffer {
    const v = this.buf.subarray(this.pos, this.pos + len)
    this.pos += len
    return v
  }
}

/** The standard `-1` extension type: seconds (and optionally nanoseconds) since the Unix epoch. */
function decodeTimestamp(type: number, payload: Buffer): MsgpackValue {
  if (type !== -1) return { extType: type, bytes: payload }
  if (payload.length === 4) return new Date(payload.readUInt32BE(0) * 1000).toISOString()
  if (payload.length === 8) {
    const raw = payload.readBigUInt64BE(0)
    const nanos = Number(raw >> 34n)
    const secs = Number(raw & 0x3_ffff_ffffn)
    return new Date(secs * 1000 + Math.floor(nanos / 1e6)).toISOString()
  }
  if (payload.length === 12) {
    const nanos = payload.readUInt32BE(0)
    const secs = payload.readBigInt64BE(4)
    return new Date(Number(secs) * 1000 + Math.floor(nanos / 1e6)).toISOString()
  }
  return { extType: type, bytes: payload }
}

function readExt(c: Cursor, len: number): MsgpackValue {
  const type = c.i8()
  const payload = c.bin(len)
  return decodeTimestamp(type, payload)
}

function readArray(c: Cursor, n: number): MsgpackValue[] {
  const out: MsgpackValue[] = []
  for (let i = 0; i < n; i++) out.push(readValue(c))
  return out
}

function readMap(c: Cursor, n: number): { [key: string]: MsgpackValue } {
  const out: { [key: string]: MsgpackValue } = {}
  for (let i = 0; i < n; i++) {
    const key = readValue(c)
    const value = readValue(c)
    // Not `out[key] = value`: `__proto__` is an accessor on every plain object, and a map that
    // happened to carry that literal string as a key would repoint `out`'s prototype instead of
    // setting a field on it — every property this decoder never wrote would start reading back as
    // whatever the file put there. `defineProperty` always makes an own data property, the same
    // way `JSON.parse` reads a `"__proto__"` key safely.
    Object.defineProperty(out, typeof key === 'string' ? key : JSON.stringify(key), {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    })
  }
  return out
}

function readValue(c: Cursor): MsgpackValue {
  const b = c.u8()
  if (b <= 0x7f) return b // positive fixint
  if (b >= 0xe0) return b - 256 // negative fixint
  if (b >= 0x80 && b <= 0x8f) return readMap(c, b & 0x0f)
  if (b >= 0x90 && b <= 0x9f) return readArray(c, b & 0x0f)
  if (b >= 0xa0 && b <= 0xbf) return c.str(b & 0x1f)

  switch (b) {
    case 0xc0:
      return null
    case 0xc2:
      return false
    case 0xc3:
      return true
    case 0xc4:
      return c.bin(c.u8())
    case 0xc5:
      return c.bin(c.u16())
    case 0xc6:
      return c.bin(c.u32())
    case 0xc7:
      return readExt(c, c.u8())
    case 0xc8:
      return readExt(c, c.u16())
    case 0xc9:
      return readExt(c, c.u32())
    case 0xca:
      return c.f32()
    case 0xcb:
      return c.f64()
    case 0xcc:
      return c.u8()
    case 0xcd:
      return c.u16()
    case 0xce:
      return c.u32()
    case 0xcf:
      return Number(c.u64())
    case 0xd0:
      return c.i8()
    case 0xd1:
      return c.i16()
    case 0xd2:
      return c.i32()
    case 0xd3:
      return Number(c.i64())
    case 0xd4:
      return readExt(c, 1)
    case 0xd5:
      return readExt(c, 2)
    case 0xd6:
      return readExt(c, 4)
    case 0xd7:
      return readExt(c, 8)
    case 0xd8:
      return readExt(c, 16)
    case 0xd9:
      return c.str(c.u8())
    case 0xda:
      return c.str(c.u16())
    case 0xdb:
      return c.str(c.u32())
    case 0xdc:
      return readArray(c, c.u16())
    case 0xdd:
      return readArray(c, c.u32())
    case 0xde:
      return readMap(c, c.u16())
    case 0xdf:
      return readMap(c, c.u32())
    default:
      throw new Error(`msgpack: unhandled byte 0x${b.toString(16)} at offset ${c.pos - 1}`)
  }
}

/**
 * Every top-level value the buffer holds, decoded independently.
 *
 * A value this decoder cannot make sense of throws partway through — an unknown extension is
 * handled above, but a future encoding change is not. That failure ends the walk rather than the
 * whole read: whatever decoded before it is kept, since a session cut short by one bad record is a
 * better answer than no session at all.
 */
export function decodeAll(buf: Buffer): MsgpackValue[] {
  const c = new Cursor(buf)
  const out: MsgpackValue[] = []
  while (!c.done()) {
    try {
      out.push(readValue(c))
    } catch {
      break
    }
  }
  return out
}
