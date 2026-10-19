// The engine's own guarantees: recovery after crashes and corruption,
// compaction, locking, read-only readers, and suspend/resume. These go
// through rocksdb-native's JavaScript layer, as hypercore-storage does, and
// damage files only through the OPFS API.

const test = require('brittle')
const path = require('path')
const { Worker } = require('worker_threads')
const opfs = require('../opfs-node')
const log = require('../lib/log')
const { RocksDB, binding, storePath, logFiles, listFiles, readAll, writeAll, entries } = require('./helpers')

async function put(db, ...pairs) {
  const batch = db.write()
  for (let i = 0; i < pairs.length; i += 2) batch.tryPut(pairs[i], pairs[i + 1])
  try {
    await batch.flush()
  } finally {
    batch.destroy() // also on failure, or close() waits for the batch forever
  }
}

async function logSize(p) {
  const [name] = await logFiles(p)
  return (await readAll(p, name)).byteLength
}

test('data and column families survive reopening', async (t) => {
  const p = storePath()
  let db = new RocksDB(p, { columnFamilies: ['b'] })
  await put(db, 'a', '1')
  await put(db.columnFamily('b'), 'a', 'in b')
  await db.close()

  db = new RocksDB(p, { columnFamilies: ['b'] })
  t.alike(await db.get('a'), Buffer.from('1'))
  t.alike(await db.columnFamily('b').get('a'), Buffer.from('in b'))
  await db.close()
})

test('torn tail: every cut inside the last batch recovers the earlier ones', async (t) => {
  const p = storePath()
  let db = new RocksDB(p)
  await put(db, 'a', '1')
  await db.close()
  const before = await logSize(p)

  db = new RocksDB(p)
  await put(db, 'b', '2', 'c', '3')
  await db.close()
  const [name] = await logFiles(p)
  const full = await readAll(p, name)

  let ok = true
  for (let cut = before; cut < full.byteLength; cut++) {
    await writeAll(p, name, full.subarray(0, cut))
    db = new RocksDB(p)
    const seen = await entries(db)
    await put(db, 'd', '4') // must append cleanly after the repaired tail
    await db.close()

    db = new RocksDB(p)
    const after = await entries(db)
    await db.close()

    if (JSON.stringify(seen) !== JSON.stringify([['a', '1']]) || JSON.stringify(after) !== JSON.stringify([['a', '1'], ['d', '4']])) {
      t.fail(`cut at ${cut}: saw ${JSON.stringify(seen)}, then ${JSON.stringify(after)}`)
      ok = false
      break
    }
  }
  if (ok) t.pass(`${full.byteLength - before} cut positions recovered correctly`)
})

test('a flipped byte in the last batch drops only that batch', async (t) => {
  const p = storePath()
  let db = new RocksDB(p)
  await put(db, 'a', '1')
  await put(db, 'b', '2')
  await db.close()

  const [name] = await logFiles(p)
  const bytes = await readAll(p, name)
  bytes[bytes.byteLength - 2] ^= 0xff
  await writeAll(p, name, bytes)

  db = new RocksDB(p)
  t.alike(await entries(db), [['a', '1']])
  await db.close()
})

test('corruption in the middle: recovery stops there (point in time)', async (t) => {
  const p = storePath()
  let db = new RocksDB(p)
  await put(db, 'a', '1')
  await db.close()
  const afterA = await logSize(p)

  db = new RocksDB(p)
  await put(db, 'b', '2')
  await put(db, 'c', '3')
  await db.close()

  const [name] = await logFiles(p)
  const bytes = await readAll(p, name)
  bytes[afterA + 9] ^= 0xff // inside batch b
  await writeAll(p, name, bytes)

  db = new RocksDB(p)
  t.alike(await entries(db), [['a', '1']], 'only what came before the damage')
  await put(db, 'd', '4')
  await db.close()

  db = new RocksDB(p)
  t.alike(await entries(db), [['a', '1'], ['d', '4']], 'nothing after the damage comes back')
  await db.close()
})

test('an interrupted compaction is ignored and removed', async (t) => {
  const p = storePath()
  let db = new RocksDB(p)
  await put(db, 'a', '1')
  await db.close()

  // A base file with data but no BASE_END: a compaction that never finished.
  const { record } = log.encodeBatch([{ type: log.OP_PUT, cf: 0, key: Buffer.from('bogus'), value: Buffer.from('x') }])
  const header = log.encodeHeader(log.FILE_BASE)
  await writeAll(p, '000002.log', Buffer.concat([header, record]), { create: true })

  db = new RocksDB(p)
  t.alike(await entries(db), [['a', '1']])
  await db.close()
  t.alike(await logFiles(p), ['000001.log'])
})

test('files left behind by a completed compaction are removed on open', async (t) => {
  const p = storePath()
  let db = new RocksDB(p)
  await put(db, 'x', 'old')
  await db.close()
  const oldLog = await readAll(p, '000001.log')

  db = new RocksDB(p)
  await put(db, 'x', 'new')
  await db.compactRange()
  await db.close()
  t.alike(await logFiles(p), ['000002.log'])

  // Simulate a crash after the base was finished but before the old file went.
  await writeAll(p, '000001.log', oldLog, { create: true })

  db = new RocksDB(p)
  t.alike(await db.get('x'), Buffer.from('new'))
  await db.close()
  t.alike(await logFiles(p), ['000002.log'])
})

test('writes after a compaction are appended to the base and survive', async (t) => {
  const p = storePath()
  let db = new RocksDB(p, { columnFamilies: ['b'] })
  await put(db, 'a', '1')
  await put(db.columnFamily('b'), 'z', '26')
  await db.compactRange()
  await put(db, 'b', '2')
  await db.deleteRange('a', 'b')
  await db.close()

  db = new RocksDB(p, { columnFamilies: ['b'] })
  t.alike(await entries(db), [['b', '2']])
  t.alike(await entries(db.columnFamily('b')), [['z', '26']])
  await db.close()
})

test('a second writer is refused while the first is open', async (t) => {
  const p = storePath()
  const first = new RocksDB(p)
  await first.ready()
  const second = new RocksDB(p)
  await t.exception(second.ready(), /already held/)
  await first.close()

  const third = new RocksDB(p)
  await third.ready()
  await third.close()
})

test('a read-only reader sees data as of its open, even across compaction', async (t) => {
  const p = storePath()
  const writer = new RocksDB(p)
  await put(writer, 'a', '1')

  const reader = new RocksDB(p, { readOnly: true })
  await reader.ready()

  await put(writer, 'a', '2')
  await writer.compactRange()
  t.alike(await writer.get('a'), Buffer.from('2'))
  t.alike(await reader.get('a'), Buffer.from('1'), 'reader keeps its view')

  await writer.close()
  t.alike(await reader.get('a'), Buffer.from('1'), 'still readable after the writer closed')
  t.alike(await logFiles(p), ['000001.log', '000002.log'], 'old log kept alive by the reader')

  await reader.close()
  await new Promise((resolve) => setTimeout(resolve, 10))
  t.alike(await logFiles(p), ['000002.log'], 'old log deleted once the reader let go')
})

test('snapshots keep reading old data across compaction and suspend/resume', async (t) => {
  const p = storePath()
  const db = new RocksDB(p)
  await put(db, 'a', '1', 'b', '1')
  const snap = db.snapshot()
  await put(db, 'a', '2')
  await db.deleteRange('b', 'c')
  await db.compactRange()
  await db.suspend()
  await db.resume()
  await db.compactRange()

  t.alike(await entries(snap), [['a', '1'], ['b', '1']])
  t.alike(await entries(db), [['a', '2']])
  await snap.close()
  await db.close()
})

test('suspend releases every OPFS handle; resume takes them back', async (t) => {
  const before = opfs.openHandleCount()
  const db = new RocksDB(storePath())
  await put(db, 'a', '1')
  t.ok(opfs.openHandleCount() > before, 'holds handles while open')

  await db.suspend()
  t.is(opfs.openHandleCount(), before, 'none while suspended')

  await db.resume()
  t.alike(await db.get('a'), Buffer.from('1'))
  await db.close()
  t.is(opfs.openHandleCount(), before, 'none after close')
})

test('automatic compaction keeps the log bounded', async (t) => {
  const { config } = require('../lib/engine')
  const saved = { ...config }
  binding.configure({ autoCompactMinBytes: 16 * 1024, autoCompactRatio: 2 })
  t.teardown(() => binding.configure(saved))

  const p = storePath()
  let db = new RocksDB(p)
  for (let i = 0; i < 2000; i++) {
    await put(db, 'key' + (i % 10), Buffer.alloc(100, i % 256))
    if (i % 100 === 0) await new Promise((resolve) => setTimeout(resolve, 0)) // let the compaction timer run
  }
  await db.close()

  const files = await logFiles(p)
  let total = 0
  for (const f of files) total += (await readAll(p, f)).byteLength
  t.ok(total < 64 * 1024, `log is ${total} bytes after 200 KB of overwrites`)

  db = new RocksDB(p)
  t.alike(await db.get('key9'), Buffer.alloc(100, 1999 % 256))
  t.is((await entries(db)).length, 10)
  await db.close()
})

test('a failed append leaves the store consistent', async (t) => {
  const p = storePath()
  let db = new RocksDB(p)
  await put(db, 'a', '1')

  // Make the next write to the log fail, as a full quota would.
  const engine = db._state._handle.engine
  const handle = engine.active.handle
  const write = handle.write
  handle.write = function (buf, opts) {
    handle.write = write
    write.call(this, buf.subarray(0, 5), opts) // a partial write, then failure
    throw new DOMException('Quota exceeded', 'QuotaExceededError')
  }

  await t.exception(put(db, 'b', '2'))
  await put(db, 'c', '3')
  t.alike(await entries(db), [['a', '1'], ['c', '3']])
  await db.close()

  db = new RocksDB(p)
  t.alike(await entries(db), [['a', '1'], ['c', '3']])
  await db.close()
})

test('a writer killed mid-write leaves an exact prefix of its batches', async (t) => {
  for (let round = 0; round < 5; round++) {
    const p = storePath('killed')
    const worker = new Worker(path.join(__dirname, 'crash-writer.js'), { workerData: { root: globalThis.OPFS_TEST_ROOT, path: p } })
    await new Promise((resolve, reject) => {
      worker.once('message', resolve)
      worker.once('error', reject)
    })
    await new Promise((resolve) => setTimeout(resolve, 5 + Math.random() * 50))
    await worker.terminate()

    const db = new RocksDB(p)
    const n = parseInt((await db.get('n')).toString(), 10)
    const keys = []
    for await (const key of db.keys({ gte: 'k', lt: 'l' })) keys.push(key.toString())
    await db.close()

    const expected = Array.from({ length: n + 1 }, (_, i) => 'k' + String(i).padStart(8, '0'))
    if (JSON.stringify(keys) !== JSON.stringify(expected)) {
      t.fail(`round ${round}: n=${n} but ${keys.length} k-keys`)
      return
    }
    t.pass(`round ${round}: ${n + 1} batches survived intact`)
  }
})

test('store directory contents', async (t) => {
  const p = storePath()
  const db = new RocksDB(p)
  await db.ready()
  await db.close()
  t.alike(await listFiles(p), ['000001.log', 'LOCK', 'SESSION_ID'])
})
