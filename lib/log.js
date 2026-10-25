// The on-disk format. A store is a directory of numbered log files
// (000001.log, 000002.log, ...). Each log file is a sequence of records:
//
//   record := bodyLength (u32 LE) | crc32(body) (u32 LE) | body
//
// The checksum is what makes writes all-or-nothing: a record that was only
// partly written when the tab or browser died fails its checksum, and recovery
// stops just before it.
//
// Record bodies start with a type byte:
//
//   HEADER   (1)  magic (u32 LE) | format version (u8) | file kind (u8)
//                 Always the first record of a file.
//   BATCH    (2)  op count (varint) | ops...
//                 One write batch. Applied completely or not at all.
//   BASE_END (3)  entry count (varint)
//                 Marks the end of a base (see below).
//
// Ops inside a batch:
//
//   PUT          (1) cf (varint) | key length (varint) | key | value length (varint) | value
//   DELETE       (2) cf (varint) | key length (varint) | key
//   DELETE_RANGE (3) cf (varint) | start length (varint) | start | end length (varint) | end
//   DEFINE_CF    (4) cf (varint) | name length (varint) | name (UTF-8)
//
// There are two kinds of file:
//
//   DELTA - in the async-only engine, one file contains one committed batch
//           after its header. The reader also tolerates older delta files with
//           multiple batches.
//   BASE  - written by compaction. It contains a full copy of every live entry
//           (as BATCH records), then BASE_END. A base without BASE_END is an
//           interrupted compaction and is ignored. Older stores may have delta
//           batches after BASE_END in the same file; this engine writes each
//           later batch to a separate DELTA file instead.
//
// Values are not copied into memory: the engine remembers where each value's
// bytes sit inside its record, and reads them back when asked.

const MAGIC = 0x5346504f // 'OPFS' when read as little-endian bytes
const FORMAT_VERSION = 1

const FILE_DELTA = 1
const FILE_BASE = 2

const RECORD_HEADER = 1
const RECORD_BATCH = 2
const RECORD_BASE_END = 3

const OP_PUT = 1
const OP_DELETE = 2
const OP_DELETE_RANGE = 3
const OP_DEFINE_CF = 4

const FRAME_SIZE = 8 // bodyLength + crc32
const MAX_BODY_SIZE = 0x7fffffff // sanity limit when reading lengths back

// --- CRC-32 (IEEE 802.3, the same as zlib's crc32) ---------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(bytes) {
  let crc = 0xffffffff
  for (let i = 0; i < bytes.byteLength; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

// --- Varints (unsigned LEB128) ----------------------------------------------
// Arithmetic rather than bit operations so values above 2^31 survive.

function varintLength(n) {
  let len = 1
  while (n >= 128) {
    n = Math.floor(n / 128)
    len++
  }
  return len
}

function writeVarint(buf, offset, n) {
  while (n >= 128) {
    buf[offset++] = (n % 128) | 128
    n = Math.floor(n / 128)
  }
  buf[offset++] = n
  return offset
}

// A small reader over a body. Throws on malformed input; callers treat a
// throw as corruption.
class Reader {
  constructor(buf) {
    this.buf = buf
    this.offset = 0
  }

  u8() {
    if (this.offset >= this.buf.byteLength) throw new Error('Truncated record')
    return this.buf[this.offset++]
  }

  u32() {
    if (this.offset + 4 > this.buf.byteLength) throw new Error('Truncated record')
    const b = this.buf
    const o = this.offset
    this.offset += 4
    return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0
  }

  varint() {
    let n = 0
    let scale = 1
    for (let i = 0; i < 8; i++) {
      const byte = this.u8()
      n += (byte & 127) * scale
      if (byte < 128) return n
      scale *= 128
    }
    throw new Error('Varint too long')
  }

  // Returns { start, length } of the next `length` bytes, without copying.
  span(length) {
    if (this.offset + length > this.buf.byteLength) throw new Error('Truncated record')
    const start = this.offset
    this.offset += length
    return { start, length }
  }

  done() {
    return this.offset === this.buf.byteLength
  }
}

function writeU32(buf, offset, n) {
  buf[offset] = n & 0xff
  buf[offset + 1] = (n >>> 8) & 0xff
  buf[offset + 2] = (n >>> 16) & 0xff
  buf[offset + 3] = (n >>> 24) & 0xff
}

// --- Encoding ---------------------------------------------------------------

// Wraps a body in its frame. Returns the full record bytes.
function frame(body) {
  const record = new Uint8Array(FRAME_SIZE + body.byteLength)
  writeU32(record, 0, body.byteLength)
  writeU32(record, 4, crc32(body))
  record.set(body, FRAME_SIZE)
  return record
}

function encodeHeader(kind) {
  const body = new Uint8Array(7)
  body[0] = RECORD_HEADER
  writeU32(body, 1, MAGIC)
  body[5] = FORMAT_VERSION
  body[6] = kind
  return frame(body)
}

function encodeBaseEnd(count) {
  const body = new Uint8Array(1 + varintLength(count))
  body[0] = RECORD_BASE_END
  writeVarint(body, 1, count)
  return frame(body)
}

// Encodes a batch of ops into one record.
//
// ops: [{ type, cf, key, value }]   for OP_PUT
//      [{ type, cf, key }]          for OP_DELETE
//      [{ type, cf, start, end }]   for OP_DELETE_RANGE
//      [{ type, cf, name }]         for OP_DEFINE_CF (name: Uint8Array)
//
// Returns { record, valueOffsets } where valueOffsets[i] is the offset of op
// i's value bytes from the start of the record (only for PUT ops), so the
// caller can work out where each value lands on disk.
function encodeBatch(ops) {
  let length = 1 + varintLength(ops.length)

  for (const op of ops) {
    length += 1 + varintLength(op.cf)
    switch (op.type) {
      case OP_PUT:
        length += varintLength(op.key.byteLength) + op.key.byteLength
        length += varintLength(op.value.byteLength) + op.value.byteLength
        break
      case OP_DELETE:
        length += varintLength(op.key.byteLength) + op.key.byteLength
        break
      case OP_DELETE_RANGE:
        length += varintLength(op.start.byteLength) + op.start.byteLength
        length += varintLength(op.end.byteLength) + op.end.byteLength
        break
      case OP_DEFINE_CF:
        length += varintLength(op.name.byteLength) + op.name.byteLength
        break
      default:
        throw new Error('Unknown op type ' + op.type)
    }
  }

  const record = new Uint8Array(FRAME_SIZE + length)
  const body = record.subarray(FRAME_SIZE)
  const valueOffsets = new Array(ops.length)

  let o = 0
  body[o++] = RECORD_BATCH
  o = writeVarint(body, o, ops.length)

  const bytes = (b) => {
    o = writeVarint(body, o, b.byteLength)
    body.set(b, o)
    o += b.byteLength
  }

  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]
    body[o++] = op.type
    o = writeVarint(body, o, op.cf)

    switch (op.type) {
      case OP_PUT:
        bytes(op.key)
        o = writeVarint(body, o, op.value.byteLength)
        valueOffsets[i] = FRAME_SIZE + o
        body.set(op.value, o)
        o += op.value.byteLength
        break
      case OP_DELETE:
        bytes(op.key)
        break
      case OP_DELETE_RANGE:
        bytes(op.start)
        bytes(op.end)
        break
      case OP_DEFINE_CF:
        bytes(op.name)
        break
    }
  }

  writeU32(record, 0, length)
  writeU32(record, 4, crc32(body))

  return { record, valueOffsets }
}

// --- Decoding ---------------------------------------------------------------

// Decodes a record body. Byte strings are returned as copies (keys are kept
// in memory long after the body is gone); values are returned as positions
// within the body ({ start, length }) because only their location is kept.
//
// Throws on malformed input.
function decodeBody(body) {
  const r = new Reader(body)
  const type = r.u8()

  if (type === RECORD_HEADER) {
    const magic = r.u32()
    const version = r.u8()
    const kind = r.u8()
    if (magic !== MAGIC) throw new Error('Not a log file')
    if (version !== FORMAT_VERSION) throw new Error('Unsupported log format version ' + version)
    if (kind !== FILE_DELTA && kind !== FILE_BASE) throw new Error('Unknown file kind ' + kind)
    return { type, kind }
  }

  if (type === RECORD_BASE_END) {
    return { type, count: r.varint() }
  }

  if (type !== RECORD_BATCH) throw new Error('Unknown record type ' + type)

  const copy = (span) => body.slice(span.start, span.start + span.length)
  const count = r.varint()
  const ops = new Array(count)

  for (let i = 0; i < count; i++) {
    const opType = r.u8()
    const cf = r.varint()

    switch (opType) {
      case OP_PUT: {
        const key = copy(r.span(r.varint()))
        const value = r.span(r.varint())
        ops[i] = { type: opType, cf, key, value }
        break
      }
      case OP_DELETE:
        ops[i] = { type: opType, cf, key: copy(r.span(r.varint())) }
        break
      case OP_DELETE_RANGE: {
        const start = copy(r.span(r.varint()))
        const end = copy(r.span(r.varint()))
        ops[i] = { type: opType, cf, start, end }
        break
      }
      case OP_DEFINE_CF:
        ops[i] = { type: opType, cf, name: copy(r.span(r.varint())) }
        break
      default:
        throw new Error('Unknown op type ' + opType)
    }
  }

  if (!r.done()) throw new Error('Trailing bytes in batch')

  return { type, ops }
}

// Reads the record starting at `offset` from an immutable File/Blob snapshot.
// All disk-backed reads are asynchronous; the returned body contains only the
// current record, not the whole log file.
//
// Returns { body, bodyOffset, next } for a valid record. Returns null if there
// is no complete, valid record there: end of file, a torn write, or corruption.
async function readRecord(file, offset, fileSize) {
  if (offset + FRAME_SIZE > fileSize) return null

  const head = new Uint8Array(await file.slice(offset, offset + FRAME_SIZE).arrayBuffer())
  if (head.byteLength !== FRAME_SIZE) return null

  const length = (head[0] | (head[1] << 8) | (head[2] << 16) | (head[3] << 24)) >>> 0
  const checksum = (head[4] | (head[5] << 8) | (head[6] << 16) | (head[7] << 24)) >>> 0

  if (length === 0 || length > MAX_BODY_SIZE) return null
  if (offset + FRAME_SIZE + length > fileSize) return null

  const body = new Uint8Array(await file.slice(offset + FRAME_SIZE, offset + FRAME_SIZE + length).arrayBuffer())
  if (body.byteLength !== length || crc32(body) !== checksum) return null

  return { body, bodyOffset: offset + FRAME_SIZE, next: offset + FRAME_SIZE + length }
}

module.exports = {
  FILE_DELTA,
  FILE_BASE,
  RECORD_HEADER,
  RECORD_BATCH,
  RECORD_BASE_END,
  OP_PUT,
  OP_DELETE,
  OP_DELETE_RANGE,
  OP_DEFINE_CF,
  FRAME_SIZE,
  crc32,
  frame,
  encodeHeader,
  encodeBaseEnd,
  encodeBatch,
  decodeBody,
  readRecord
}
