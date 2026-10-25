// Browser smoke test. Runs in a Web Worker to exercise the full storage stack.
// The storage engine itself uses only asynchronous OPFS APIs.
//
// It exercises the whole stack: rocksdb-native's JavaScript layer on the OPFS
// binding, then hypercore-storage, then Hypercore itself (append, read,
// reopen, replicate between two cores).

const RocksDB = require('rocksdb-native')
const Storage = require('hypercore-storage')
const Hypercore = require('hypercore')
const sodium = require('sodium-universal')
const log = require('../lib/log')
const files_api = require('../lib/files')

const results = []

function report(message) {
  if (typeof globalThis.postMessage === 'function' && typeof globalThis.document === 'undefined' && globalThis.self === globalThis) {
    globalThis.postMessage(message)
  } else if (globalThis.__smokeReport) {
    globalThis.__smokeReport(message)
  } else {
    console.log(JSON.stringify(message))
  }
}

function skip(name, reason) {
  results.push({ name, ok: true, skipped: true })
  report({ type: 'result', name, ok: true, skipped: true, reason, ms: 0 })
}

async function check(name, fn) {
  const start = Date.now()
  try {
    await fn()
    results.push({ name, ok: true })
    report({ type: 'result', name, ok: true, ms: Date.now() - start })
  } catch (err) {
    results.push({ name, ok: false })
    report({ type: 'result', name, ok: false, ms: Date.now() - start, error: String((err && err.stack) || err) })
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function same(a, b, message) {
  const x = a === null ? 'null' : Buffer.from(a).toString()
  const y = b === null ? 'null' : Buffer.from(b).toString()
  if (x !== y) throw new Error(`${message}: expected ${y}, got ${x}`)
}

const run = Math.random().toString(36).slice(2)
const base = `/smoke-${run}`

async function main() {
  report({ type: 'start', userAgent: (globalThis.navigator && navigator.userAgent) || 'unknown' })

  await check('async OPFS write, close and read', async () => {
    assert(globalThis.navigator && navigator.storage && navigator.storage.getDirectory, 'navigator.storage.getDirectory is missing')
    const root = await navigator.storage.getDirectory()
    const name = `smoke-probe-${run}`
    const file = await root.getFileHandle(name, { create: true })
    const writer = await file.createWritable()
    await writer.write(new Uint8Array([1, 2, 3]))
    await writer.close()
    const stored = new Uint8Array(await (await file.getFile()).arrayBuffer())
    assert(stored.join(',') === '1,2,3', 'async write/read returned unexpected bytes: ' + stored)
    await root.removeEntry(name)
  })

  await check('rocksdb-native: write, read, iterate, snapshot, reopen', async () => {
    const dir = `${base}/rocks`
    let db = new RocksDB(dir)
    await db.put('a', '1')
    await db.put('b', '2')
    const snap = db.snapshot()
    await db.put('a', 'changed')
    await db.deleteRange('b', 'c')
    same(await snap.get('a'), '1', 'snapshot value')
    same(await db.get('a'), 'changed', 'current value')
    same(await db.get('b'), null, 'deleted by range')
    const keys = []
    for await (const { key } of db.iterator({ gte: 'a', lt: 'z' })) keys.push(key.toString())
    assert(keys.join(',') === 'a', 'iterator keys: ' + keys.join(','))
    await snap.close()
    await db.close()

    db = new RocksDB(dir)
    same(await db.get('a'), 'changed', 'value after reopen')
    await db.close()
  })

  await check('read-only open waits for an in-flight log commit', async () => {
    const dir = `${base}/publish-race`
    const writer = new RocksDB(dir)
    await writer.ready()

    const original_create_writer = files_api.createWriter
    let signal_close
    const close_entered = new Promise((resolve) => { signal_close = resolve })
    let release_close
    const close_gate = new Promise((resolve) => { release_close = resolve })
    let reader = null

    files_api.createWriter = async (shared, options) => {
      const stream = await original_create_writer(shared, options)
      return {
        write: (...args) => stream.write(...args),
        abort: (...args) => stream.abort(...args),
        close: async () => {
          signal_close()
          await close_gate
          return stream.close()
        }
      }
    }

    try {
      const write_pending = writer.put('committed', 'yes')
      await close_entered
      reader = new RocksDB(dir, { readOnly: true, createIfMissing: false })
      let opened = false
      const opening = reader.ready().then(() => { opened = true })
      await new Promise((resolve) => setTimeout(resolve, 0))
      assert(!opened, 'read-only open must wait for the in-flight log writer lock')

      release_close()
      await write_pending
      await opening
      same(await reader.get('committed'), 'yes', 'reader sees the whole committed batch')
    } finally {
      release_close()
      files_api.createWriter = original_create_writer
      if (reader !== null) {
        try { await reader.ready() } catch {}
        try { await reader.close() } catch {}
      }
      await writer.close()
    }
  })

  await check('read-only reader survives compaction using async log leases', async () => {
    const dir = `${base}/reader-writer`
    const writer = new RocksDB(dir)
    await writer.put('a', '1')

    const reader = new RocksDB(dir, { readOnly: true, createIfMissing: false })
    await reader.ready()
    await writer.put('b', '2')
    await writer.compactRange()

    same(await reader.get('a'), '1', 'reader retains its original value')
    same(await reader.get('b'), null, 'reader does not observe later writes')
    await reader.close()
    await writer.close()

    const reopened = new RocksDB(dir)
    same(await reopened.get('a'), '1', 'compacted value')
    same(await reopened.get('b'), '2', 'new value after compaction')
    await reopened.close()
  })

  await check('failure injection: a rejected async close does not publish a batch', async () => {
    const dir = `${base}/fault-close`
    let db = new RocksDB(dir)
    await db.put('before', 'kept')

    const original_create_writer = files_api.createWriter
    let fail_close = true
    files_api.createWriter = async (shared, options) => {
      const stream = await original_create_writer(shared, options)
      return {
        write: (...args) => stream.write(...args),
        abort: (...args) => stream.abort(...args),
        close: async () => {
          if (fail_close) {
            fail_close = false
            throw new Error('injected OPFS close failure')
          }
          return stream.close()
        }
      }
    }

    try {
      let rejected = false
      try {
        await db.put('uncommitted', 'dropped')
      } catch (err) {
        rejected = String(err && err.message).includes('injected OPFS close failure')
      }
      assert(rejected, 'injected close failure should reject the write')
      same(await db.get('before'), 'kept', 'previously committed data remains visible')
      same(await db.get('uncommitted'), null, 'failed batch is not published')
    } finally {
      files_api.createWriter = original_create_writer
    }

    await db.close()
    db = new RocksDB(dir)
    same(await db.get('before'), 'kept', 'previous data survives reopen')
    same(await db.get('uncommitted'), null, 'failed batch does not return after reopen')
    await db.close()
  })

  await check('recovery: a damaged async log tail is not published', async () => {
    const dir_path = `${base}/fault-tail`
    let db = new RocksDB(dir_path)
    await db.put('before', 'kept')
    await db.put('damaged', 'dropped')
    await db.close()

    let dir = await navigator.storage.getDirectory()
    for (const segment of dir_path.split('/').filter(Boolean)) dir = await dir.getDirectoryHandle(segment)
    const log_names = []
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind === 'file' && /^\d{6,}\.log$/.test(name)) log_names.push(name)
    }
    log_names.sort()
    assert(log_names.length >= 2, 'expected separate immutable log files for committed batches')

    const last = log_names[log_names.length - 1]
    const handle = await dir.getFileHandle(last)
    const bytes = new Uint8Array(await (await handle.getFile()).arrayBuffer())
    assert(bytes.byteLength > 1, 'last log has content')
    const stream = await handle.createWritable()
    await stream.write(bytes.subarray(0, bytes.byteLength - 1))
    await stream.close()

    db = new RocksDB(dir_path)
    same(await db.get('before'), 'kept', 'earlier committed batch survives')
    same(await db.get('damaged'), null, 'damaged batch is discarded')
    await db.put('after', 'ok')
    await db.close()

    db = new RocksDB(dir_path)
    same(await db.get('before'), 'kept', 'earlier data after another reopen')
    same(await db.get('after'), 'ok', 'write after recovery survives')
    same(await db.get('damaged'), null, 'damaged data never reappears')
    await db.close()
  })

  await check('rocksdb-native: compaction and suspend/resume', async () => {
    const db = new RocksDB(`${base}/compact`)
    for (let i = 0; i < 200; i++) await db.put('k' + (i % 7), String(i))
    await db.compactRange()
    await db.suspend()
    await db.resume()
    same(await db.get('k6'), '195', 'value after compaction and resume')
    await db.close()
  })

  await check('rocksdb-native: a second writer is refused', async () => {
    const dir = `${base}/locked`
    const first = new RocksDB(dir)
    await first.ready()
    const second = new RocksDB(dir)
    let refused = false
    try {
      await second.ready()
    } catch {
      refused = true
    }
    await first.close()
    assert(refused, 'second writer was allowed')
  })

  await check('Hypercore: append, read, reopen', async () => {
    const dir = `${base}/core`
    let core = new Hypercore(new Storage(dir))
    await core.ready()
    const blocks = []
    for (let i = 0; i < 100; i++) blocks.push(Buffer.from('block ' + i))
    await core.append(blocks)
    same(await core.get(42), 'block 42', 'block 42')
    const key = core.key
    await core.close()

    core = new Hypercore(new Storage(dir))
    await core.ready()
    assert(core.length === 100, 'length after reopen: ' + core.length)
    assert(Buffer.compare(core.key, key) === 0, 'key changed after reopen')
    same(await core.get(99), 'block 99', 'block 99 after reopen')
    await core.close()
  })

  // Replication needs a Noise handshake, which needs this libsodium function.
  // sodium-javascript (what sodium-universal uses in browsers) lacks it as of
  // 0.8.0, so replication can't work in browsers yet whatever the storage.
  const missingCrypto = ['crypto_scalarmult_ed25519_noclamp'].filter((fn) => typeof sodium[fn] !== 'function')

  if (missingCrypto.length > 0) {
    skip(
      'Hypercore: replicate between two cores',
      `the crypto library in this build lacks ${missingCrypto.join(', ')}, which Hypercore's Noise handshake needs ` +
        '(sodium-javascript 0.8.0 does not have it). Unrelated to storage.'
    )
  } else await check('Hypercore: replicate between two cores', async () => {
    const a = new Hypercore(new Storage(`${base}/repl-a`))
    await a.ready()
    await a.append(['one', 'two', 'three'].map((s) => Buffer.from(s)))

    const b = new Hypercore(new Storage(`${base}/repl-b`), a.key)
    await b.ready()

    const s1 = a.replicate(true)
    const s2 = b.replicate(false)
    s1.pipe(s2).pipe(s1)

    // A stream error (a failed handshake, say) would otherwise leave b.get()
    // waiting forever, so surface it and give up after a while.
    const failure = new Promise((resolve, reject) => {
      s1.on('error', reject)
      s2.on('error', reject)
      setTimeout(() => reject(new Error('replication did not deliver the block within 10 s')), 10000)
    })

    same(await Promise.race([b.get(2), failure]), 'three', 'replicated block')
    s1.destroy()
    s2.destroy()
    await a.close()
    await b.close()
  })

  await check('clean up', async () => {
    const root = await navigator.storage.getDirectory()
    await root.removeEntry(base.slice(1), { recursive: true })
  })

  const failed = results.filter((r) => !r.ok).length
  const skipped = results.filter((r) => r.skipped).length
  report({ type: 'done', passed: results.length - failed - skipped, failed, skipped })
}

main().catch((err) => report({ type: 'done', passed: 0, failed: 1, error: String((err && err.stack) || err) }))
