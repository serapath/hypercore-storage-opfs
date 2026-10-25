// A drop-in replacement for rocksdb-native's native binding (its `binding.js`),
// written in plain JavaScript on top of OPFS.
//
// rocksdb-native is two layers: a JavaScript layer (sessions, batches,
// iterators, snapshots, the suspend/resume state machine) and a native binding
// of 29 functions underneath it. This module provides those 29 functions, so
// rocksdb-native's own JavaScript runs unchanged on top. Swap it in with a
// bundler alias; see README.md.
//
// The contract each function follows is documented in BINDING.md. In brief:
//
//   - Handles are plain objects owned by this module. The JavaScript layer
//     only stores them and passes them back.
//   - Asynchronous functions take a context object and callback(s), and call
//     the callback with the context as `this`, always on a later task (like
//     the native binding), never synchronously.
//   - Errors are Error objects with a `code`, using RocksDB's messages where
//     callers (or tests) match on them.

const { Engine, configure, makeError } = require('./lib/engine')
const log = require('./lib/log')

// Operation type constants, with the same values as the native binding.
// (Read and write ops are numbered separately there, so GET and PUT are both 1.)
const GET = 1
const PUT = 1
const DELETE = 2
const DELETE_RANGE = 3

const STATS_LEVEL_MIN = 0
const STATS_LEVEL_MAX = 5
const WAL_FILE_ALIVE = 1

const EMPTY = new Uint8Array(0)

// Native callbacks always arrive on a later turn of the event loop (a task),
// never as a microtask. Callers can depend on that ordering relative to
// setImmediate and timers (Hypercore's replication tests do: with microtask
// callbacks one of them stalls), so callbacks are delivered the same way:
// setImmediate where it exists (Node, Bare), otherwise a MessageChannel
// message, which browsers deliver as a task without setTimeout's minimum delay.
const later = typeof setImmediate === 'function' ? setImmediate : messageChannelScheduler()

function messageChannelScheduler() {
  const queue = []
  const channel = new MessageChannel()
  channel.port1.onmessage = () => queue.shift()()
  return (fn) => {
    queue.push(fn)
    channel.port2.postMessage(null)
  }
}

function engineOf(db) {
  if (db.engine === null || db.closing) throw makeError('RocksDB session is closed')
  return db.engine
}

function cfIdOf(columnFamily) {
  if (columnFamily.id < 0) throw makeError(`Column family '${columnFamily.name}' was not opened with the database`)
  return columnFamily.id
}

function viewOf(snapshot) {
  return snapshot === undefined || snapshot === null ? null : snapshot.view
}

// --- Database -----------------------------------------------------------------

function init(
  readOnly,
  createIfMissing,
  createMissingColumnFamilies,
  maxBackgroundJobs,
  bytesPerSync,
  maxOpenFiles,
  useDirectReads,
  avoidUnnecessaryBlockingIO,
  skipStatsUpdateOnOpen,
  useDirectIOForFlushAndCompaction,
  maxFileOpeningThreads,
  walRecoveryMode,
  bestEffortsRecovery,
  enableStatistics,
  statsLevel,
  walTtlSeconds,
  walSizeLimitMegabytes,
  avoidFlushDuringShutdown,
  walFilterPrefixes
) {
  // Most of these tune RocksDB internals that have no counterpart here. They
  // are accepted so the JavaScript layer can pass them, and otherwise ignored.
  return {
    options: {
      readOnly: !!readOnly,
      createIfMissing: !!createIfMissing,
      createMissingColumnFamilies: !!createMissingColumnFamilies,
      walFilterPrefixes: (walFilterPrefixes || []).map((p) => new Uint8Array(p))
    },
    enableStatistics: !!enableStatistics,
    statsLevel,
    engine: null,
    closing: false,
    snapshots: new Set()
  }
}

// `lock` is a file descriptor from fd-lock/device-file in Node, or -1. File
// descriptors don't exist in browsers, so it is ignored: the engine takes its
// own lock (an exclusive handle on the store's LOCK file) instead.
function open(db, ctx, path, columnFamilies, lock, req, onopen) {
  const names = columnFamilies.map((cf) => cf.name)

  Engine.open(path, db.options, names).then(
    (engine) => {
      db.engine = engine
      for (const cf of columnFamilies) cf.id = engine.cfId(cf.name)
      later(() => onopen.call(ctx, null))
    },
    (err) => later(() => onopen.call(ctx, err))
  )

  return {}
}

function close(db, req, onclose) {
  db.closing = true

  // Snapshots still alive at close are released here, as the native binding does.
  if (db.engine !== null) {
    for (const snapshot of db.snapshots) db.engine.releaseView(snapshot.view)
  }
  db.snapshots.clear()

  const engine = db.engine
  const done = engine === null ? Promise.resolve() : engine.close()

  done.then(
    () => later(() => onclose.call(req)),
    () => later(() => onclose.call(req))
  )

  return {}
}

function suspend(db, req, onsuspend) {
  engineOf(db).suspend().then(
    () => later(() => onsuspend.call(req, null)),
    (err) => later(() => onsuspend.call(req, err))
  )
  return {}
}

function resume(db, req, onresume) {
  engineOf(db).resume().then(
    () => later(() => onresume.call(req, null)),
    (err) => later(() => onresume.call(req, err))
  )
  return {}
}

function flushWal(db, req, onflushwal) {
  let promise
  try {
    promise = engineOf(db).flushNow()
  } catch (err) {
    promise = Promise.reject(err)
  }
  promise.then(
    () => later(() => onflushwal.call(req, null)),
    (err) => later(() => onflushwal.call(req, err))
  )
  return {}
}

// RocksDB flushes a column family's memtable to an SST file here. There is no
// memtable: everything is already in the log, so this just flushes the log.
function flush(db, columnFamily, req, onflush) {
  return flushWal(db, req, onflush)
}

// --- Column families ------------------------------------------------------------

// All the arguments after `name` are RocksDB table and blob tuning options,
// which have no counterpart here.
function columnFamilyInit(name) {
  return { name, id: -1 }
}

function columnFamilyDestroy(columnFamily) {
  // Nothing to free. This releases the handle, it doesn't drop the data.
}

// --- Reads ----------------------------------------------------------------------

// The native binding hands out buffers for zero-copy transfer. The JavaScript
// layer only stores them, so empty ones do.
function readInit() {
  return {}
}

function readBuffer(batch, capacity) {
  return new ArrayBuffer(0)
}

function read(db, batch, ops, snapshot, asyncIO, fillCache, ctx, onread) {
  const errors = new Array(ops.length).fill(null)
  const values = new Array(ops.length).fill(null)

  let engine = null
  try {
    engine = engineOf(db)
  } catch (err) {
    errors.fill(err)
  }

  if (engine === null) {
    later(() => onread.call(ctx, errors, values))
    return
  }

  const view = viewOf(snapshot)
  Promise.all(ops.map(async (op, i) => {
    try {
      values[i] = await engine.get(cfIdOf(op.columnFamily), op.key, view)
    } catch (err) {
      errors[i] = err
    }
  })).then(
    () => later(() => onread.call(ctx, errors, values)),
    (err) => {
      errors.fill(err)
      later(() => onread.call(ctx, errors, values))
    }
  )
}

// --- Writes ---------------------------------------------------------------------

function writeInit() {
  return {}
}

function writeBuffer(batch, capacity) {
  return new ArrayBuffer(0)
}

function write(db, batch, ops, ctx, onwrite) {
  let error = null

  try {
    const engine = engineOf(db)
    const converted = new Array(ops.length)

    for (let i = 0; i < ops.length; i++) {
      const op = ops[i]
      const cf = cfIdOf(op.columnFamily)

      switch (op.type) {
        case PUT:
          converted[i] = { type: log.OP_PUT, cf, key: op.key, value: op.value }
          break
        case DELETE:
          converted[i] = { type: log.OP_DELETE, cf, key: op.key }
          break
        case DELETE_RANGE:
          converted[i] = { type: log.OP_DELETE_RANGE, cf, start: op.start, end: op.end }
          break
        default:
          throw makeError('Unknown write operation ' + op.type)
      }
    }

    engine.write(converted).then(
      () => later(() => onwrite.call(ctx, null)),
      (err) => later(() => onwrite.call(ctx, err))
    )
    return
  } catch (err) {
    error = err
  }

  later(() => onwrite.call(ctx, error))
}

// --- Iterators ------------------------------------------------------------------

function iteratorInit() {
  return { iterator: null, ctx: null, onopen: null, onclose: null, onread: null }
}

function iteratorBuffer(handle, capacity) {
  return new ArrayBuffer(0)
}

function iteratorOpen(db, handle, columnFamily, gt, gte, lt, lte, reverse, keysOnly, snapshot, ctx, onopen, onclose, onread) {
  handle.ctx = ctx
  handle.onopen = onopen
  handle.onclose = onclose
  handle.onread = onread

  let error = null
  try {
    const engine = engineOf(db)
    const bounds = { gt: gt || EMPTY, gte: gte || EMPTY, lt: lt || EMPTY, lte: lte || EMPTY, reverse, keysOnly }
    handle.iterator = engine.iterator(cfIdOf(columnFamily), bounds, viewOf(snapshot))
  } catch (err) {
    error = err
  }

  later(() => onopen.call(ctx, error))
}

function iteratorRead(handle, count) {
  let promise
  try {
    if (handle.iterator === null) throw makeError('Iterator is not open')
    promise = handle.iterator.read(count)
  } catch (err) {
    promise = Promise.reject(err)
  }

  promise.then(
    ({ keys, values }) => later(() => handle.onread.call(handle.ctx, null, keys, values)),
    (err) => later(() => handle.onread.call(handle.ctx, err, [], []))
  )
}

function iteratorClose(handle) {
  if (handle.iterator !== null) {
    handle.iterator.close()
    handle.iterator = null
  }
  later(() => handle.onclose.call(handle.ctx, null))
}

// --- Snapshots ------------------------------------------------------------------

function snapshotCreate(db) {
  const engine = engineOf(db)
  const snapshot = { db, view: engine.createView() }
  db.snapshots.add(snapshot)
  return snapshot
}

function snapshotDestroy(snapshot) {
  const { db } = snapshot
  if (!db.snapshots.delete(snapshot)) return
  if (db.engine !== null) db.engine.releaseView(snapshot.view)
}

// --- Maintenance ----------------------------------------------------------------

function compact(db, columnFamily, exclusive, blobGarbageCollectionPolicy, blobGarbageCollectionAgeCutoff, bottommostLevelCompaction, req, oncompact) {
  let promise
  try {
    promise = engineOf(db).compact()
  } catch (err) {
    promise = Promise.reject(err)
  }
  promise.then(
    () => later(() => oncompact.call(req, null)),
    (err) => later(() => oncompact.call(req, err))
  )
  return {}
}

// Compaction always rewrites the whole store, so the range is not used.
function compactRange(db, columnFamily, start, end, exclusive, blobGarbageCollectionPolicy, blobGarbageCollectionAgeCutoff, bottommostLevelCompaction, req, oncompactrange) {
  return compact(db, columnFamily, exclusive, blobGarbageCollectionPolicy, blobGarbageCollectionAgeCutoff, bottommostLevelCompaction, req, oncompactrange)
}

// Total bytes (keys plus values) stored in [start, end). There is no
// memtable/file split here, so either flag counts everything.
function approximateSize(db, columnFamily, start, end, includeMemtables, includeFiles, filesSizeErrorMargin, req, onapproximatesize) {
  let error = null
  let size = 0

  try {
    if (!includeMemtables && !includeFiles) throw makeError('Invalid options')
    size = engineOf(db).approximateSize(cfIdOf(columnFamily), start || EMPTY, end || EMPTY)
  } catch (err) {
    error = err
  }

  later(() => onapproximatesize.call(req, error, size))
  return {}
}

function currentWalFile(db, req, oncurrentwalfile) {
  let error = null
  let file = null

  try {
    file = engineOf(db).currentLogFile()
    if (file === null) throw makeError('No log file', 'ENOENT')
  } catch (err) {
    error = err
  }

  later(() => {
    if (error) oncurrentwalfile.call(req, error)
    else oncurrentwalfile.call(req, null, file.path, file.number, WAL_FILE_ALIVE, file.startSequence, file.size)
  })
  return {}
}

// --- Statistics and properties --------------------------------------------------

function statsLevelGet(db) {
  if (!db.enableStatistics) throw makeError('invalid argument', 'EINVAL')
  return db.statsLevel
}

function statsLevelSet(db, level) {
  if (!db.enableStatistics) throw makeError('invalid argument', 'EINVAL')
  if (level < STATS_LEVEL_MIN || level > STATS_LEVEL_MAX) throw makeError('invalid argument', 'EINVAL')
  db.statsLevel = level
}

// A few RocksDB properties, computed from the engine's state. Unknown names
// return undefined, as with RocksDB.
function propertyGet(db, columnFamily, name) {
  const engine = engineOf(db)
  const cf = cfIdOf(columnFamily)

  switch (name) {
    case 'rocksdb.estimate-num-keys':
      return String(engine.numKeys(cf))
    case 'rocksdb.estimate-live-data-size':
    case 'rocksdb.total-sst-files-size':
    case 'rocksdb.live-sst-files-size':
      return String(engine.liveBytes(cf))
    case 'rocksdb.options-statistics': {
      if (!db.enableStatistics) return undefined
      // Formatted like RocksDB's statistics dump. There is no block cache, so
      // its counters are always zero.
      const c = engine.counters
      return [
        'rocksdb.block.cache.hit COUNT : 0',
        'rocksdb.block.cache.miss COUNT : 0',
        `rocksdb.number.keys.written COUNT : ${c.keysWritten}`,
        `rocksdb.number.keys.read COUNT : ${c.keysRead}`,
        `rocksdb.bytes.written COUNT : ${c.bytesWritten}`,
        `rocksdb.bytes.read COUNT : ${c.bytesRead}`,
        `rocksdb.compaction.count COUNT : ${c.compactions}`
      ].join('\n') + '\n'
    }
    default:
      return undefined
  }
}

module.exports = {
  init,
  open,
  close,
  suspend,
  resume,
  flushWal,
  flush,
  columnFamilyInit,
  columnFamilyDestroy,
  readInit,
  readBuffer,
  read,
  writeInit,
  writeBuffer,
  write,
  iteratorInit,
  iteratorBuffer,
  iteratorOpen,
  iteratorRead,
  iteratorClose,
  snapshotCreate,
  snapshotDestroy,
  compact,
  compactRange,
  approximateSize,
  currentWalFile,
  statsLevelGet,
  statsLevelSet,
  propertyGet,
  GET,
  PUT,
  DELETE,
  DELETE_RANGE,
  // Not part of the native binding: tuning for this implementation.
  configure
}
