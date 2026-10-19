// The storage engine: a small ordered key-value store on OPFS that provides
// what rocksdb-native's binding needs (column families, atomic write batches,
// point reads, snapshots, range iterators, suspend/resume).
//
// How it works, in short:
//
//   - Every write batch is appended to a log file as one checksummed record
//     (see log.js), so a batch is either fully on disk or not at all.
//   - In memory, each column family is a persistent sorted tree (see tree.js)
//     mapping keys to where their value bytes sit in the log. Values are read
//     from disk on demand; only keys live in memory.
//   - A snapshot or iterator is a "view": a copy of the current tree roots
//     plus a reference on the log files those roots point into. Because trees
//     are never modified in place, a view never changes.
//   - Compaction writes every live entry into a fresh "base" log file and
//     switches to it. Old files are deleted once no view needs them.
//   - Opening a store replays its log files to rebuild the trees.
//
// Directory layout of a store:
//
//   000001.log, 000002.log, ...   log files (see log.js)
//   LOCK                          held open (exclusively) by the writer
//   SESSION_ID                    random id written by each writable open
//
// The engine is synchronous wherever OPFS allows it (reads, writes, iterator
// steps) and asynchronous only for opening, closing, suspending, resuming and
// starting a compaction, which need OPFS's async directory API. Running in
// one JavaScript thread means a synchronous step can never interleave with
// another, which is what keeps batches and compaction atomic in memory.

const tree = require('./tree')
const log = require('./log')
const files = require('./files')

const LOCK_FILE = 'LOCK'
const SESSION_FILE = 'SESSION_ID'
const DEFAULT_CF = 'default'
const DEFAULT_CF_ID = 0

// Tunables, adjustable through configure() (mainly so tests can trigger
// compaction with small stores).
const config = {
  // Compact automatically once the log files hold at least this many bytes...
  autoCompactMinBytes: 64 * 1024 * 1024,
  // ...and at least this many times the bytes of live data.
  autoCompactRatio: 2,
  // Compaction writes its base in records of roughly this size.
  baseChunkBytes: 1024 * 1024
}

function configure(options = {}) {
  Object.assign(config, options)
}

function makeError(message, code = 'EINVAL') {
  const err = new Error(message)
  err.code = code
  return err
}

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

function logName(number) {
  return String(number).padStart(6, '0') + '.log'
}

function parseLogName(name) {
  const m = /^(\d{6,})\.log$/.exec(name)
  return m ? parseInt(m[1], 10) : -1
}

// Keys handed in by callers may be views into larger, reusable buffers
// (Node's Buffer pool, for one). Keys are kept in memory indefinitely, so they
// are copied into their own small arrays.
function ownCopy(bytes) {
  return Uint8Array.prototype.slice.call(bytes)
}

function randomId() {
  const bytes = new Uint8Array(10)
  globalThis.crypto.getRandomValues(bytes)
  let s = ''
  for (const b of bytes) s += b.toString(16).padStart(2, '0')
  return s
}

function startsWith(key, prefix) {
  if (prefix.byteLength > key.byteLength) return false
  for (let i = 0; i < prefix.byteLength; i++) {
    if (key[i] !== prefix[i]) return false
  }
  return true
}

// One log file, as seen by one engine.
class LogFile {
  constructor(number, shared) {
    this.number = number
    this.name = logName(number)
    this.shared = shared // files.js SharedFile; null while suspended
    this.size = 0 // offset just past the last valid record; appends go here
    this.refs = 0 // 1 while part of the live state, +1 per view holding it
    this.obsolete = false // replaced by compaction; deleted when refs reach 0
    this.startSequence = 0 // sequence number of the first op in this file
  }

  get handle() {
    if (this.shared === null) throw makeError('RocksDB session is closed')
    return this.shared.handle
  }
}

class Engine {
  constructor(path, options) {
    this.path = path
    this.readOnly = !!options.readOnly
    this.createIfMissing = options.createIfMissing !== false
    this.createMissingColumnFamilies = options.createMissingColumnFamilies !== false
    this.walFilterPrefixes = options.walFilterPrefixes || []

    this.state = 'opening' // opening | open | suspended | closed
    this.dir = null
    this.lock = null // exclusive handle on LOCK while held
    this.sessionId = null

    this.files = new Map() // number -> LogFile, every file this engine has open
    this.live = [] // LogFiles making up the current state, oldest first
    this.active = null // LogFile receiving appends (writable engines only)
    this.maxFileNumber = 0

    this.roots = new Map() // column family id -> tree root
    this.cfIds = new Map([[DEFAULT_CF, DEFAULT_CF_ID]]) // name -> id
    this.nextCfId = DEFAULT_CF_ID + 1

    this.sequence = 0 // ops applied so far, like RocksDB's sequence number
    this.compacting = null
    this.flushPending = false
    this.compactTimer = null

    this.counters = { keysWritten: 0, keysRead: 0, bytesWritten: 0, bytesRead: 0, compactions: 0 }
  }

  // Opens (or creates) the store at `path`. Returns the column family ids for
  // `cfNames`, in order, as engine.cfIdsFor(cfNames).
  static async open(path, options, cfNames) {
    const engine = new Engine(path, options)
    try {
      await engine._open(cfNames)
    } catch (err) {
      await engine._abandon()
      throw err
    }
    return engine
  }

  async _open(cfNames) {
    if (this.walFilterPrefixes.length > 0 && !this.readOnly) {
      throw makeError('wal_filter_prefixes requires read_only')
    }

    const create = !this.readOnly && this.createIfMissing
    this.dir = await files.openDirectory(this.path, { create })
    if (this.dir === null) {
      throw makeError(`${this.path}: does not exist (create_if_missing is false)`, 'ENOENT')
    }

    if (!this.readOnly) await this._takeLock()

    const numbers = await this._listLogFiles()

    if (numbers.length === 0) {
      if (!create) {
        throw makeError(`${this.path}: does not exist (create_if_missing is false)`, 'ENOENT')
      }
      await this._startNewLog()
    } else {
      await this._recover(numbers)
    }

    if (!this.readOnly) await this._writeSession()

    this._defineColumnFamilies(cfNames)

    this.state = 'open'
    this._maybeScheduleCompaction()
  }

  // Releases whatever a failed open managed to take.
  async _abandon() {
    this.state = 'closed'
    for (const file of this.files.values()) {
      if (file.shared !== null) await files.release(file.shared)
      file.shared = null
    }
    if (this.lock !== null) {
      this.lock.close()
      this.lock = null
    }
  }

  // --- Locking and sessions -------------------------------------------------

  async _takeLock() {
    try {
      this.lock = await files.openExclusive(this.dir, LOCK_FILE, { create: true })
    } catch (err) {
      if (err && err.name === 'NoModificationAllowedError') {
        throw makeError(`lock ${this.path}/${LOCK_FILE}: already held by another open database`, 'EBUSY')
      }
      throw err
    }
  }

  // Each writable open writes a fresh random id. A suspended writer compares
  // its id when resuming: if someone else opened the store as a writer in the
  // meantime, the id differs and the resume is refused, because this engine's
  // in-memory index would no longer match the files. (librocksdb does the same.)
  async _writeSession() {
    this.sessionId = randomId()
    const handle = await files.openExclusive(this.dir, SESSION_FILE, { create: true })
    try {
      const bytes = textEncoder.encode(this.sessionId)
      handle.truncate(0)
      handle.write(bytes, { at: 0 })
      handle.flush()
    } finally {
      handle.close()
    }
  }

  async _readSession() {
    let handle
    try {
      handle = await files.openExclusive(this.dir, SESSION_FILE)
    } catch (err) {
      if (err && err.name === 'NotFoundError') return null
      throw err
    }
    try {
      const bytes = new Uint8Array(handle.getSize())
      handle.read(bytes, { at: 0 })
      return textDecoder.decode(bytes)
    } finally {
      handle.close()
    }
  }

  // --- Log files ------------------------------------------------------------

  async _listLogFiles() {
    const numbers = []
    for await (const [name, handle] of this.dir.entries()) {
      if (handle.kind !== 'file') continue
      const n = parseLogName(name)
      if (n >= 0) numbers.push(n)
    }
    numbers.sort((a, b) => a - b)
    if (numbers.length > 0) this.maxFileNumber = numbers[numbers.length - 1]
    return numbers
  }

  async _openLogFile(number, { create = false } = {}) {
    const name = logName(number)
    let shared
    try {
      shared = await files.acquire(this.dir, this.path, name, { create })
    } catch (err) {
      if (err && err.name === 'NoModificationAllowedError') {
        throw makeError(`${this.path}/${name} is open in another tab or worker`, 'EBUSY')
      }
      throw err
    }
    const file = new LogFile(number, shared)
    this.files.set(number, file)
    if (number > this.maxFileNumber) this.maxFileNumber = number
    return file
  }

  // Makes `file` part of the live state.
  _addLive(file) {
    file.refs++
    this.live.push(file)
  }

  // Creates the first log file of a new store.
  async _startNewLog() {
    const file = await this._openLogFile(this.maxFileNumber + 1, { create: true })
    const header = log.encodeHeader(log.FILE_DELTA)
    file.handle.truncate(0)
    file.handle.write(header, { at: 0 })
    file.handle.flush()
    file.size = header.byteLength
    file.startSequence = this.sequence
    this._addLive(file)
    this.active = file
  }

  // Deletes a log file that recovery found to be unusable or superseded.
  // Read-only engines never delete anything.
  async _discard(file) {
    this.files.delete(file.number)
    if (file.shared === null) return
    if (!this.readOnly) files.markObsolete(file.shared)
    await files.release(file.shared)
    file.shared = null
  }

  // --- Recovery -------------------------------------------------------------
  //
  // 1. Find the newest base file that has its BASE_END marker. Everything
  //    before it is superseded. Bases without BASE_END are interrupted
  //    compactions and are ignored.
  // 2. Replay from that base (or from the oldest file if there is no base) in
  //    order. Replay stops at the first record that is incomplete or fails its
  //    checksum, as RocksDB's default (point-in-time) recovery does: the store
  //    reopens exactly as it was after the last fully written batch.
  // 3. A writable engine then tidies up: truncates the torn tail, and deletes
  //    superseded, interrupted and unreachable files.

  async _recover(numbers) {
    const found = []
    for (const n of numbers) found.push(await this._openLogFile(n))

    const garbage = new Set()
    let start = 0
    let baseResult = null

    for (let i = found.length - 1; i >= 0; i--) {
      if (this._readFileKind(found[i]) !== log.FILE_BASE) continue
      this._resetState()
      const result = this._replayFile(found[i])
      if (result.baseComplete) {
        start = i
        baseResult = result
        break
      }
      garbage.add(found[i]) // interrupted compaction
    }

    if (baseResult === null) this._resetState()

    for (let i = 0; i < start; i++) garbage.add(found[i])

    let stoppedEarly = false

    for (let i = start; i < found.length; i++) {
      const file = found[i]
      if (garbage.has(file)) continue

      if (stoppedEarly) {
        // After a corrupt or torn record nothing later can be trusted.
        garbage.add(file)
        continue
      }

      const result = i === start && baseResult !== null ? baseResult : this._replayFile(file)

      if (result.kind === 0) {
        // No valid header at all (for example, a crash right after creating
        // the file). There is nothing in it to keep.
        garbage.add(file)
        stoppedEarly = result.corrupt
        continue
      }

      file.size = result.end
      this._addLive(file)
      if (result.corrupt) stoppedEarly = true
    }

    for (const file of garbage) await this._discard(file)

    if (this.live.length === 0) {
      if (this.readOnly) return // an empty, read-only view
      await this._startNewLog()
      return
    }

    if (!this.readOnly) {
      // Appends continue at the end of the newest live file. Cut off any torn
      // tail first so the next record starts on a clean boundary.
      const last = this.live[this.live.length - 1]
      if (last.handle.getSize() !== last.size) {
        last.handle.truncate(last.size)
        last.handle.flush()
      }
      this.active = last
    }
  }

  _resetState() {
    this.roots = new Map()
    this.cfIds = new Map([[DEFAULT_CF, DEFAULT_CF_ID]])
    this.nextCfId = DEFAULT_CF_ID + 1
    this.sequence = 0
  }

  // The kind from a file's header record, or 0 if it has no valid header.
  _readFileKind(file) {
    const size = file.handle.getSize()
    const record = log.readRecord(file.handle, 0, size)
    if (record === null) return 0
    try {
      const decoded = log.decodeBody(record.body)
      return decoded.type === log.RECORD_HEADER ? decoded.kind : 0
    } catch {
      return 0
    }
  }

  // Replays every valid record of one file into the current state.
  // Returns { kind, end, corrupt, baseComplete }:
  //   kind          header kind, or 0 if there's no valid header
  //   end           offset just past the last valid record
  //   corrupt       true if there are bytes after `end` (a torn or bad record)
  //   baseComplete  true for a base file whose BASE_END was reached
  _replayFile(file) {
    const handle = file.handle
    const size = handle.getSize()
    const result = { kind: 0, end: 0, corrupt: size > 0, baseComplete: false }

    const first = log.readRecord(handle, 0, size)
    if (first === null) return result

    let header
    try {
      header = log.decodeBody(first.body)
    } catch {
      return result
    }
    if (header.type !== log.RECORD_HEADER) return result

    result.kind = header.kind
    file.startSequence = this.sequence

    let inBase = header.kind === log.FILE_BASE
    let offset = first.next

    while (true) {
      const record = log.readRecord(handle, offset, size)
      if (record === null) break

      let decoded
      try {
        decoded = log.decodeBody(record.body)
      } catch {
        break
      }

      if (decoded.type === log.RECORD_BATCH) {
        this._replayBatch(decoded.ops, file, record.bodyOffset, inBase)
      } else if (decoded.type === log.RECORD_BASE_END && inBase) {
        inBase = false
        result.baseComplete = true
      } else {
        break // a record that can't appear here: treat as corruption
      }

      offset = record.next
    }

    result.end = offset
    result.corrupt = offset < size
    return result
  }

  _replayBatch(ops, file, bodyOffset, inBase) {
    // Read-only opens may filter what is replayed by key prefix, following
    // librocksdb's rules: a batch touching only the default column family
    // keeps just its matching records (and range deletes); any other batch is
    // kept whole if anything in it matches, and dropped otherwise. Bases are
    // never filtered: they play the role of RocksDB's SST files.
    if (!inBase && this.walFilterPrefixes.length > 0) {
      ops = this._filterBatch(ops)
      if (ops === null) return
    }

    for (const op of ops) {
      let location = null
      if (op.type === log.OP_PUT) {
        location = { file: file.number, offset: bodyOffset + op.value.start, length: op.value.length }
      }
      this._applyOp(op, location)
    }

    this.sequence += ops.length
  }

  _filterBatch(ops) {
    const matches = (key) => this.walFilterPrefixes.some((p) => startsWith(key, p))

    let defaultOnly = true
    let matched = false

    for (const op of ops) {
      if (op.type === log.OP_DEFINE_CF) continue
      if (op.cf !== DEFAULT_CF_ID) defaultOnly = false
      if (op.type === log.OP_DELETE_RANGE || matches(op.key)) matched = true
    }

    if (defaultOnly) {
      return ops.filter((op) => op.type === log.OP_DEFINE_CF || op.type === log.OP_DELETE_RANGE || matches(op.key))
    }

    return matched ? ops : null
  }

  // Applies one op to the in-memory state. `location` is where a PUT's value
  // is on disk.
  _applyOp(op, location) {
    switch (op.type) {
      case log.OP_PUT:
        this.roots.set(op.cf, tree.set(this._root(op.cf), op.key, location))
        break
      case log.OP_DELETE:
        this.roots.set(op.cf, tree.remove(this._root(op.cf), op.key))
        break
      case log.OP_DELETE_RANGE:
        this.roots.set(op.cf, tree.removeRange(this._root(op.cf), op.start, op.end))
        break
      case log.OP_DEFINE_CF: {
        const name = textDecoder.decode(op.name)
        this.cfIds.set(name, op.cf)
        if (op.cf >= this.nextCfId) this.nextCfId = op.cf + 1
        break
      }
    }
  }

  _root(cf) {
    const root = this.roots.get(cf)
    return root === undefined ? tree.EMPTY : root
  }

  // --- Column families ------------------------------------------------------

  _defineColumnFamilies(names) {
    const missing = []
    for (const name of names) {
      if (this.cfIds.has(name) || missing.includes(name)) continue
      if (this.readOnly || !this.createMissingColumnFamilies) {
        throw makeError(`Column family not found: ${name}`)
      }
      missing.push(name)
    }

    if (missing.length === 0) return

    const ops = missing.map((name) => ({
      type: log.OP_DEFINE_CF,
      cf: this.nextCfId++,
      name: textEncoder.encode(name)
    }))

    this._append(ops)
  }

  cfId(name) {
    const id = this.cfIds.get(name)
    if (id === undefined) throw makeError(`Column family not found: ${name}`)
    return id
  }

  // --- Writing --------------------------------------------------------------

  _assertOpen() {
    if (this.state !== 'open') throw makeError('RocksDB session is closed')
  }

  // Writes a batch atomically. ops: [{ type, cf, key, value } | { type, cf, start, end }]
  // using log.OP_PUT / OP_DELETE / OP_DELETE_RANGE.
  write(ops) {
    this._assertOpen()
    if (this.readOnly) throw makeError('Not supported operation in read only mode.', 'ENOTSUP')

    const own = new Array(ops.length)
    for (let i = 0; i < ops.length; i++) {
      const op = ops[i]
      switch (op.type) {
        case log.OP_PUT:
          own[i] = { type: op.type, cf: op.cf, key: ownCopy(op.key), value: op.value }
          break
        case log.OP_DELETE:
          own[i] = { type: op.type, cf: op.cf, key: ownCopy(op.key) }
          break
        case log.OP_DELETE_RANGE:
          if (tree.compare(op.start, op.end) > 0) throw makeError('end key comes before start key')
          own[i] = { type: op.type, cf: op.cf, start: ownCopy(op.start), end: ownCopy(op.end) }
          break
        default:
          throw makeError('Unknown write op ' + op.type)
      }
    }

    this._append(own)
  }

  // Appends one batch record, then applies it in memory. If the append fails
  // (quota exceeded, say), nothing is applied and the file is cut back.
  _append(ops) {
    const { record, valueOffsets } = log.encodeBatch(ops)
    const file = this.active
    const at = file.size

    try {
      const written = file.handle.write(record, { at })
      if (written !== record.byteLength) throw makeError('Short write to log file', 'EIO')
    } catch (err) {
      try {
        file.handle.truncate(at)
      } catch {}
      throw err
    }

    file.size = at + record.byteLength

    for (let i = 0; i < ops.length; i++) {
      const op = ops[i]
      let location = null
      if (op.type === log.OP_PUT) {
        location = { file: file.number, offset: at + valueOffsets[i], length: op.value.byteLength }
        this.counters.bytesWritten += op.value.byteLength
      }
      if (op.type !== log.OP_DEFINE_CF) this.counters.keysWritten++
      this._applyOp(op, location)
    }

    this.sequence += ops.length
    this._scheduleFlush()
    this._maybeScheduleCompaction()
  }

  // Writes are flushed once per tick rather than once per batch, so a burst
  // of batches costs one flush. flushNow() forces it.
  _scheduleFlush() {
    if (this.flushPending) return
    this.flushPending = true
    queueMicrotask(() => {
      if (!this.flushPending) return
      this.flushPending = false
      if (this.state === 'open' && this.active !== null) this.active.handle.flush()
    })
  }

  flushNow() {
    this._assertOpen()
    this.flushPending = false
    if (this.active !== null) this.active.handle.flush()
  }

  // --- Reading --------------------------------------------------------------

  // Returns the value (an ArrayBuffer) or null. Reads from `view` if given,
  // otherwise from the current state.
  get(cf, key, view = null) {
    this._assertOpen()
    const root = view === null ? this._root(cf) : view.roots.get(cf) || tree.EMPTY
    const location = tree.get(root, key)
    this.counters.keysRead++
    return location === undefined ? null : this._readValue(location)
  }

  _readValue(location) {
    const bytes = new Uint8Array(location.length)
    if (location.length > 0) {
      const file = this.files.get(location.file)
      if (file === undefined) throw makeError('Value refers to a missing log file', 'EIO')
      if (file.handle.read(bytes, { at: location.offset }) !== location.length) {
        throw makeError('Short read from log file', 'EIO')
      }
    }
    this.counters.bytesRead += location.length
    return bytes.buffer
  }

  // --- Views (snapshots and iterators) ---------------------------------------

  // A frozen copy of the current state (or of another view). Must be released.
  createView(from = null) {
    const view = {
      roots: new Map(from === null ? this.roots : from.roots),
      files: from === null ? this.live.slice() : from.files.slice(),
      released: false
    }
    for (const file of view.files) file.refs++
    return view
  }

  releaseView(view) {
    if (view.released) return
    view.released = true
    for (const file of view.files) this._unref(file)
  }

  // Drops one reference. When an obsolete file loses its last reference it is
  // retired: released and marked for deletion. Deletion is decided only here,
  // never at compaction time, because a snapshot may still be reading the
  // file, and suspend() releases handles without meaning to delete anything.
  //
  // If the engine is suspended at that moment (no handle to release), the
  // file is left on disk; the next writable open recognises it as superseded
  // and deletes it.
  _unref(file) {
    if (--file.refs > 0 || !file.obsolete) return
    this.files.delete(file.number)
    if (file.shared !== null) {
      const shared = file.shared
      file.shared = null
      files.markObsolete(shared)
      files.release(shared).catch(() => {})
    }
  }

  // Opens an iterator. Bounds are byte strings; an empty bound means "none"
  // (that is how rocksdb-native passes them).
  iterator(cf, { gt, gte, lt, lte, reverse, keysOnly }, from = null) {
    this._assertOpen()
    return new EngineIterator(this, this.createView(from), cf, { gt, gte, lt, lte, reverse, keysOnly })
  }

  // --- Maintenance and introspection ----------------------------------------

  compact() {
    if (this.compacting === null) {
      this.compacting = this._compact().finally(() => {
        this.compacting = null
      })
    }
    return this.compacting
  }

  async _compact() {
    this._assertOpen()
    if (this.readOnly) throw makeError('Not supported operation in read only mode.', 'ENOTSUP')

    const number = this.maxFileNumber + 1
    const file = await this._openLogFile(number, { create: true })

    if (this.state !== 'open') {
      // Suspended or closed while the file was being opened.
      await this._discard(file)
      return
    }

    // Everything from here on is synchronous, so no write can slip in between
    // copying the data and switching over to the new file.
    let roots
    try {
      roots = this._writeBase(file)
    } catch (err) {
      await this._discard(file)
      throw err
    }

    const old = this.live
    this.live = []
    this._addLive(file)
    this.active = file
    this.roots = roots

    for (const f of old) {
      f.obsolete = true
      this._unref(f) // deleted now, or when the last view holding it is released
    }

    this.counters.compactions++
  }

  // Writes every live entry into `file` as a base, flushes it, and returns the
  // new tree roots pointing into it. Synchronous.
  _writeBase(file) {
    const handle = file.handle
    handle.truncate(0)

    const header = log.encodeHeader(log.FILE_BASE)
    handle.write(header, { at: 0 })
    let offset = header.byteLength
    let entries = 0

    const writeRecord = (ops) => {
      const { record, valueOffsets } = log.encodeBatch(ops)
      if (handle.write(record, { at: offset }) !== record.byteLength) {
        throw makeError('Short write to log file', 'EIO')
      }
      const at = offset
      offset += record.byteLength
      return { at, valueOffsets }
    }

    // Column family definitions come first, so a replay knows every family
    // before it meets their data.
    const definitions = []
    for (const [name, id] of this.cfIds) {
      if (id === DEFAULT_CF_ID) continue
      definitions.push({ type: log.OP_DEFINE_CF, cf: id, name: textEncoder.encode(name) })
    }
    if (definitions.length > 0) writeRecord(definitions)

    const roots = new Map()

    for (const [cf, root] of this.roots) {
      const sorted = []
      let ops = []
      let pendingBytes = 0

      const flushChunk = () => {
        if (ops.length === 0) return
        const { at, valueOffsets } = writeRecord(ops)
        for (let i = 0; i < ops.length; i++) {
          sorted.push({
            key: ops[i].key,
            value: { file: file.number, offset: at + valueOffsets[i], length: ops[i].value.byteLength }
          })
        }
        entries += ops.length
        ops = []
        pendingBytes = 0
      }

      tree.forEach(root, (key, location) => {
        const value = new Uint8Array(this._readValue(location))
        ops.push({ type: log.OP_PUT, cf, key, value })
        pendingBytes += key.byteLength + value.byteLength
        if (pendingBytes >= config.baseChunkBytes) flushChunk()
      })
      flushChunk()

      roots.set(cf, tree.fromSorted(sorted))
    }

    const end = log.encodeBaseEnd(entries)
    handle.write(end, { at: offset })
    offset += end.byteLength
    handle.flush()

    file.size = offset
    file.startSequence = this.sequence
    return roots
  }

  _maybeScheduleCompaction() {
    if (this.readOnly || this.state !== 'open' || this.compacting !== null || this.compactTimer !== null) return

    const logBytes = this.logBytes()
    if (logBytes < config.autoCompactMinBytes) return
    if (logBytes < config.autoCompactRatio * this.liveBytes()) return

    this.compactTimer = setTimeout(() => {
      this.compactTimer = null
      if (this.state === 'open') this.compact().catch(() => {})
    }, 0)
    if (typeof this.compactTimer.unref === 'function') this.compactTimer.unref()
  }

  logBytes() {
    let total = 0
    for (const file of this.live) total += file.size
    return total
  }

  liveBytes(cf = null) {
    if (cf !== null) return tree.bytes(this._root(cf))
    let total = 0
    for (const root of this.roots.values()) total += tree.bytes(root)
    return total
  }

  numKeys(cf) {
    return tree.size(this._root(cf))
  }

  approximateSize(cf, start, end) {
    this._assertOpen()
    return tree.bytesInRange(this._root(cf), start.byteLength > 0 ? start : null, end.byteLength > 0 ? end : null)
  }

  currentLogFile() {
    this._assertOpen()
    const file = this.active !== null ? this.active : this.live[this.live.length - 1]
    if (file === undefined) return null
    return {
      path: `${this.path}/${file.name}`,
      number: file.number,
      startSequence: file.startSequence,
      size: file.size
    }
  }

  // --- Suspend, resume, close -------------------------------------------------
  //
  // Suspending lets go of every OPFS handle (and the lock) without forgetting
  // anything in memory, so another tab can open the store meanwhile. Resuming
  // takes them back, and is refused if another writer has used the store since.

  async suspend() {
    if (this.state !== 'open') throw makeError('RocksDB session is not open')
    if (this.compacting !== null) await this.compacting.catch(() => {})
    if (this.state !== 'open') throw makeError('RocksDB session is not open')

    this.flushNow()
    this.state = 'suspended'

    for (const file of this.files.values()) {
      if (file.shared === null) continue
      const shared = file.shared
      file.shared = null
      await files.release(shared)
    }

    if (this.lock !== null) {
      this.lock.close()
      this.lock = null
    }
  }

  async resume() {
    if (this.state !== 'suspended') throw makeError('RocksDB session is not suspended')

    if (!this.readOnly) {
      await this._takeLock()
      try {
        if ((await this._readSession()) !== this.sessionId) {
          throw makeError('Session ID does not match')
        }
      } catch (err) {
        this.lock.close()
        this.lock = null
        throw err
      }
    }

    const reopened = []
    try {
      for (const file of this.files.values()) {
        file.shared = await files.acquire(this.dir, this.path, file.name)
        reopened.push(file)
      }
    } catch (err) {
      for (const file of reopened) {
        await files.release(file.shared)
        file.shared = null
      }
      if (this.lock !== null) {
        this.lock.close()
        this.lock = null
      }
      throw err
    }

    this.state = 'open'
  }

  async close() {
    if (this.state === 'closed') return

    if (this.compactTimer !== null) {
      clearTimeout(this.compactTimer)
      this.compactTimer = null
    }
    if (this.compacting !== null) await this.compacting.catch(() => {})

    if (this.state === 'open' && this.active !== null) {
      this.flushPending = false
      this.active.handle.flush()
    }

    this.state = 'closed'

    // Views still open at close no longer matter, so obsolete files go now.
    for (const file of this.files.values()) {
      if (file.shared === null) continue
      const shared = file.shared
      file.shared = null
      if (file.obsolete) files.markObsolete(shared)
      await files.release(shared)
    }
    this.files.clear()

    if (this.lock !== null) {
      this.lock.close()
      this.lock = null
    }
  }
}

// An open iterator. Follows librocksdb's rules exactly: position on the start
// bound (gte, else gt; for reverse, lte, else lt), then return entries while
// every non-empty bound holds, stopping at the first entry that fails one.
class EngineIterator {
  constructor(engine, view, cf, { gt, gte, lt, lte, reverse, keysOnly }) {
    this.engine = engine
    this.view = view
    this.bounds = { gt, gte, lt, lte }
    this.keysOnly = !!keysOnly
    this.ended = false

    const cursor = new tree.Cursor(view.roots.get(cf) || tree.EMPTY, !!reverse)

    if (!reverse) {
      if (gte.byteLength > 0) cursor.seekForward(gte, false)
      else if (gt.byteLength > 0) cursor.seekForward(gt, true)
      else cursor.seekToEdge()
    } else {
      if (lte.byteLength > 0) cursor.seekBackward(lte, false)
      else if (lt.byteLength > 0) cursor.seekBackward(lt, true)
      else cursor.seekToEdge()
    }

    this.cursor = cursor
  }

  _inBounds(key) {
    const { gt, gte, lt, lte } = this.bounds
    return (
      (lt.byteLength === 0 || tree.compare(key, lt) < 0) &&
      (lte.byteLength === 0 || tree.compare(key, lte) <= 0) &&
      (gt.byteLength === 0 || tree.compare(key, gt) > 0) &&
      (gte.byteLength === 0 || tree.compare(key, gte) >= 0)
    )
  }

  // Returns up to `n` entries as { keys, values } (arrays of ArrayBuffers;
  // values is empty for keys-only iterators).
  read(n) {
    this.engine._assertOpen()
    const keys = []
    const values = []

    while (!this.ended && keys.length < n) {
      const node = this.cursor.peek()
      if (node === null || !this._inBounds(node.key)) {
        this.ended = true
        break
      }
      this.cursor.next()
      keys.push(node.key.slice().buffer)
      if (!this.keysOnly) values.push(this.engine._readValue(node.value))
    }

    return { keys, values }
  }

  close() {
    this.engine.releaseView(this.view)
  }
}

module.exports = { Engine, configure, config, makeError }
