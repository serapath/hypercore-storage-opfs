// The engine's own guarantees: recovery after crashes and corruption,
// compaction, locking, read-only readers, and suspend/resume. These go
// through rocksdb-native's JavaScript layer, as hypercore-storage does, and
// damage files only through the OPFS API.

const test = require('brittle')
const path = require('path')
const { Worker } = require('worker_threads')
const opfs = require('../opfs-node')
const log = require('../lib/log')
const files_module = require('../lib/files')
const { Engine } = require('../lib/engine')
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
  const names = await logFiles(p)
  return (await readAll(p, names[names.length - 1])).byteLength
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

test('torn tail: every cut inside the last batch recovers earlier batches', async (t) => {
  const seed = storePath('torn-seed')
  let db = new RocksDB(seed)
  await put(db, 'a', '1')
  await put(db, 'b', '2', 'c', '3')
  await db.close()
  const seedFiles = await logFiles(seed)
  const full = await readAll(seed, seedFiles[seedFiles.length - 1])

  for (let cut = 0; cut < full.byteLength; cut++) {
    const p = storePath('torn')
    db = new RocksDB(p)
    await put(db, 'a', '1')
    await put(db, 'b', '2', 'c', '3')
    await db.close()

    const names = await logFiles(p)
    const last = names[names.length - 1]
    await writeAll(p, last, full.subarray(0, cut))

    db = new RocksDB(p)
    t.alike(await entries(db), [['a', '1']], `cut at ${cut}: only earlier batch is visible`)
    await put(db, 'd', '4')
    await db.close()

    db = new RocksDB(p)
    t.alike(await entries(db), [['a', '1'], ['d', '4']], `cut at ${cut}: next write survives recovery`)
    await db.close()
  }
  t.pass(`${full.byteLength} cut positions recovered correctly`)
})

test('a flipped byte in the last batch drops only that batch', async (t) => {
  const p = storePath()
  let db = new RocksDB(p)
  await put(db, 'a', '1')
  await put(db, 'b', '2')
  await db.close()

  const names = await logFiles(p)
  const last = names[names.length - 1]
  const bytes = await readAll(p, last)
  bytes[bytes.byteLength - 2] ^= 0xff
  await writeAll(p, last, bytes)

  db = new RocksDB(p)
  t.alike(await entries(db), [['a', '1']])
  await db.close()
})

test('corruption in the middle: recovery stops there (point in time)', async (t) => {
  const p = storePath()
  let db = new RocksDB(p)
  await put(db, 'a', '1')
  await put(db, 'b', '2')
  await put(db, 'c', '3')
  await db.close()

  const names = await logFiles(p)
  const middle = names[names.length - 2]
  const bytes = await readAll(p, middle)
  bytes[bytes.byteLength - 2] ^= 0xff
  await writeAll(p, middle, bytes)

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

  const { record } = log.encodeBatch([{ type: log.OP_PUT, cf: 0, key: Buffer.from('bogus'), value: Buffer.from('x') }])
  const header = log.encodeHeader(log.FILE_BASE)
  const names = await logFiles(p)
  const next = String(parseInt(names[names.length - 1], 10) + 1).padStart(6, '0') + '.log'
  await writeAll(p, next, Buffer.concat([header, record]), { create: true })

  db = new RocksDB(p)
  t.alike(await entries(db), [['a', '1']])
  await db.close()
  t.alike((await logFiles(p)).includes(next), false, 'interrupted base removed')
})

test('files left behind by a completed compaction are removed on open', async (t) => {
  const p = storePath()
  let db = new RocksDB(p)
  await put(db, 'x', 'old')
  await db.close()
  const before = await logFiles(p)
  const oldName = before[before.length - 1]
  const oldLog = await readAll(p, oldName)

  db = new RocksDB(p)
  await put(db, 'x', 'new')
  await db.compactRange()
  await db.close()
  const compacted = await logFiles(p)
  t.is(compacted.length, 1)
  const baseName = compacted[0]

  // Simulate a crash after the base was finished but before the old file went.
  await writeAll(p, oldName, oldLog, { create: true })

  db = new RocksDB(p)
  t.alike(await db.get('x'), Buffer.from('new'))
  await db.close()
  t.alike(await logFiles(p), [baseName])
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

test('compaction defers deleting a log leased by another context', async (t) => {
  const p = storePath()
  let db = new RocksDB(p)
  await put(db, 'a', '1')
  await db.close()

  const first_logs = await logFiles(p)
  const leased_log = first_logs[first_logs.length - 1]
  const lock_name = 'rocksdb-native-opfs:file:' + p.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '') + '/' + leased_log
  let release_lease
  let confirm_lease
  const lease_acquired = new Promise((resolve) => { confirm_lease = resolve })
  const held = new Promise((resolve) => { release_lease = resolve })
  const lease_request = navigator.locks.request(lock_name, { mode: 'shared' }, async (lock) => {
    if (!lock) throw new Error('shared lease was not granted')
    confirm_lease()
    await held
  })
  await lease_acquired

  db = new RocksDB(p)
  await put(db, 'b', '2')
  await db.compactRange()
  await new Promise((resolve) => setTimeout(resolve, 0))
  t.ok((await logFiles(p)).includes(leased_log), 'leased log remains available while reader owns shared lock')
  release_lease()
  await lease_request
  await db.close()

  db = new RocksDB(p)
  await db.ready()
  t.alike(await entries(db), [['a', '1'], ['b', '2']])
  await db.close()
  t.is((await logFiles(p)).length, 1, 'next writable open collects the now-unleased old log')
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
  const while_reader_open = await logFiles(p)
  t.ok(while_reader_open.length > 1, 'reader keeps its old log entries alive')

  await reader.close()
  await new Promise((resolve) => setTimeout(resolve, 10))
  t.is((await logFiles(p)).length, 1, 'old logs deleted once the reader let go')
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

test('suspend releases the writer lock and resume validates the session', async (t) => {
  const p = storePath()
  let db = new RocksDB(p)
  await put(db, 'a', '1')
  await db.suspend()

  // Suspending releases ownership so another writer can open the store.
  const other = new RocksDB(p)
  await other.ready()
  await put(other, 'b', '2')
  await other.close()

  await t.exception(db.resume(), /Session ID does not match/)
  await db.close()
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

test('a failed async batch commit leaves the store consistent', async (t) => {
  const p = storePath()
  let db = new RocksDB(p)
  await put(db, 'a', '1')

  const file_api = require('../lib/files')
  const create_writer = file_api.createWriter
  file_api.createWriter = async (shared) => {
    const writer = await create_writer(shared)
    let calls = 0
    return {
      write: async (bytes) => {
        calls++
        if (calls === 2) {
          await writer.write(bytes.subarray(0, 5))
          throw new DOMException('Quota exceeded', 'QuotaExceededError')
        }
        return writer.write(bytes)
      },
      close: () => writer.close(),
      abort: () => writer.abort()
    }
  }

  try {
    await t.exception(put(db, 'b', '2'))
  } finally {
    file_api.createWriter = create_writer
  }

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
  t.alike(await listFiles(p), ['000001.log', 'SESSION_ID'])
})




test('read-only open waits for an in-flight async log commit', async (t) => {
  const p = storePath()
  const writer_db = await Engine.open(p, { readOnly: false, createIfMissing: true, createMissingColumnFamilies: true }, [])
  const create_writer = files_module.createWriter
  let close_entered
  const close_is_entered = new Promise((resolve) => { close_entered = resolve })
  let release_close
  const close_gate = new Promise((resolve) => { release_close = resolve })

  files_module.createWriter = async (shared, options) => {
    const writer = await create_writer(shared, options)
    return {
      write: (...args) => writer.write(...args),
      abort: (...args) => writer.abort(...args),
      close: async () => {
        close_entered()
        await close_gate
        return writer.close()
      }
    }
  }

  let reader_db = null
  let write_promise
  try {
    write_promise = writer_db.write([{ type: log.OP_PUT, cf: 0, key: Buffer.from('k'), value: Buffer.from('v') }])
    await close_is_entered
    const reader_open_promise = Engine.open(p, { readOnly: true, createIfMissing: false, createMissingColumnFamilies: true }, [])
    let reader_opened = false
    reader_open_promise.then(() => { reader_opened = true })
    await new Promise((resolve) => setTimeout(resolve, 0))
    t.is(reader_opened, false, 'reader waits while the log filename is protected by an exclusive lease')

    release_close()
    await write_promise
    reader_db = await reader_open_promise
    t.alike(Buffer.from(await reader_db.get(0, Buffer.from('k'))), Buffer.from('v'))
  } finally {
    release_close()
    files_module.createWriter = create_writer
    if (reader_db !== null) await reader_db.close()
    await writer_db.close()
  }
})

test('failed asynchronous commit does not publish a batch', async (t) => {
  const p = storePath()
  let db = await Engine.open(p, { readOnly: false, createIfMissing: true, createMissingColumnFamilies: true }, [])
  await db.write([{ type: log.OP_PUT, cf: 0, key: Buffer.from('committed'), value: Buffer.from('yes') }])

  const create_writer = files_module.createWriter
  let fail_close = true
  files_module.createWriter = async (shared, options) => {
    const writer = await create_writer(shared, options)
    return {
      write: (...args) => writer.write(...args),
      abort: (...args) => writer.abort(...args),
      close: async () => {
        if (fail_close) {
          fail_close = false
          throw new Error('injected close failure')
        }
        return writer.close()
      }
    }
  }

  try {
    await t.exception(
      db.write([{ type: log.OP_PUT, cf: 0, key: Buffer.from('uncommitted'), value: Buffer.from('no') }]),
      /injected close failure/
    )
  } finally {
    files_module.createWriter = create_writer
  }

  t.alike(Buffer.from(await db.get(0, Buffer.from('committed'))), Buffer.from('yes'))
  t.is(await db.get(0, Buffer.from('uncommitted')), null)
  await db.close()

  db = await Engine.open(p, { readOnly: false, createIfMissing: false, createMissingColumnFamilies: true }, [])
  t.alike(Buffer.from(await db.get(0, Buffer.from('committed'))), Buffer.from('yes'))
  t.is(await db.get(0, Buffer.from('uncommitted')), null)
  await db.close()
})

test('read-only resume refuses a store changed while suspended', async (t) => {
  const p = storePath()
  const writer = await Engine.open(p, { readOnly: false, createIfMissing: true, createMissingColumnFamilies: true }, [])
  await writer.write([{ type: log.OP_PUT, cf: 0, key: Buffer.from('a'), value: Buffer.from('1') }])

  const reader = await Engine.open(p, { readOnly: true, createIfMissing: false, createMissingColumnFamilies: true }, [])
  await reader.suspend()
  await writer.write([{ type: log.OP_PUT, cf: 0, key: Buffer.from('b'), value: Buffer.from('2') }])
  await t.exception(reader.resume(), /Store changed while suspended/)

  await reader.close()
  await writer.close()
})
