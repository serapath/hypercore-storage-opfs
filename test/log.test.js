const test = require('brittle')
const log = require('../lib/log')

// A minimal in-memory stand-in for a sync access handle, for reading records.
function memoryHandle(bytes) {
  return {
    read(buf, { at }) {
      const n = Math.max(0, Math.min(buf.byteLength, bytes.byteLength - at))
      buf.set(bytes.subarray(at, at + n))
      return n
    }
  }
}

test('crc32 matches the standard check value', (t) => {
  t.is(log.crc32(Buffer.from('123456789')), 0xcbf43926)
})

test('batch round trip, with value positions', (t) => {
  const ops = [
    { type: log.OP_PUT, cf: 0, key: Buffer.from('k1'), value: Buffer.from('value one') },
    { type: log.OP_DELETE, cf: 3, key: Buffer.from('k2') },
    { type: log.OP_DELETE_RANGE, cf: 200, start: Buffer.from('a'), end: Buffer.from('z') },
    { type: log.OP_DEFINE_CF, cf: 200, name: Buffer.from('family') },
    { type: log.OP_PUT, cf: 1, key: Buffer.alloc(0), value: Buffer.alloc(0) }
  ]
  const { record, valueOffsets } = log.encodeBatch(ops)
  const read = log.readRecord(memoryHandle(record), 0, record.byteLength)
  t.ok(read)
  t.is(read.next, record.byteLength)

  const decoded = log.decodeBody(read.body)
  t.is(decoded.type, log.RECORD_BATCH)
  t.is(decoded.ops.length, 5)
  t.alike(Buffer.from(decoded.ops[0].key), Buffer.from('k1'))
  t.is(decoded.ops[1].cf, 3)
  t.is(decoded.ops[2].cf, 200)
  t.alike(Buffer.from(decoded.ops[3].name), Buffer.from('family'))

  const valueAt = valueOffsets[0]
  t.alike(Buffer.from(record.subarray(valueAt, valueAt + 9)), Buffer.from('value one'))
  t.is(read.bodyOffset + decoded.ops[0].value.start, valueAt)
})

test('torn and corrupt records are rejected', (t) => {
  const { record } = log.encodeBatch([{ type: log.OP_PUT, cf: 0, key: Buffer.from('key'), value: Buffer.from('value') }])

  for (let cut = 0; cut < record.byteLength; cut++) {
    if (log.readRecord(memoryHandle(record.subarray(0, cut)), 0, cut) !== null) {
      t.fail('accepted a record cut at ' + cut)
      return
    }
  }
  t.pass('every truncation rejected')

  for (let i = 0; i < record.byteLength; i++) {
    const damaged = record.slice()
    damaged[i] ^= 0x40
    const read = log.readRecord(memoryHandle(damaged), 0, damaged.byteLength)
    if (read !== null) {
      t.fail('accepted a record with byte ' + i + ' flipped')
      return
    }
  }
  t.pass('every single-byte flip rejected')
})

test('header and base end round trip', (t) => {
  const header = log.encodeHeader(log.FILE_BASE)
  const h = log.decodeBody(log.readRecord(memoryHandle(header), 0, header.byteLength).body)
  t.is(h.type, log.RECORD_HEADER)
  t.is(h.kind, log.FILE_BASE)

  const end = log.encodeBaseEnd(123456)
  const e = log.decodeBody(log.readRecord(memoryHandle(end), 0, end.byteLength).body)
  t.is(e.type, log.RECORD_BASE_END)
  t.is(e.count, 123456)
})

test('large varints survive', (t) => {
  const big = Buffer.alloc(70000, 1)
  const { record } = log.encodeBatch([{ type: log.OP_PUT, cf: 2 ** 31 + 5, key: Buffer.from('k'), value: big }])
  const decoded = log.decodeBody(log.readRecord(memoryHandle(record), 0, record.byteLength).body)
  t.is(decoded.ops[0].cf, 2 ** 31 + 5)
  t.is(decoded.ops[0].value.length, 70000)
})
