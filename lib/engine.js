// The storage engine: a small ordered key-value store on OPFS that provides
// what rocksdb-native's binding needs (column families, atomic write batches,
// point reads, snapshots, range iterators, suspend/resume).
//
// How it works, in short:
//
//   - Every write batch is committed as one checksummed record in its own
//     immutable delta file (see log.js), so a batch is either fully visible
//     after recovery or not at all.
//   - In memory, each column family is a persistent sorted tree (see tree.js)
//     mapping keys to where their value bytes sit in the log. Values are read
//     from disk on demand; only keys live in memory.
//   - A snapshot or iterator is a "view": a copy of the current tree roots
//     plus a reference on the log files those roots point into. Because trees
//     are never modified in place, a view never changes.
//   - Compaction writes every live entry into a fresh "base" log file and
//     switches to it only after the asynchronous writable stream closes. Old
//     files are deleted once no view or in-flight read needs them.
//   - Opening a store replays its log files to rebuild the trees.
//
// Directory layout of a store:
//
//   000001.log, 000002.log, ...   log files (see log.js)
//   (Web Lock)                    exclusive origin-scoped writer lock
//   SESSION_ID                    random id written by each writable open
//
// Database file I/O uses only asynchronous OPFS APIs. Mutations are serialized
// through a promise queue so an await cannot interleave a write batch with
// compaction or another mutation. Tree lookups and immutable-root updates stay
// synchronous in memory.

const tree = require('./tree')
const log = require('./log')
const files = require('./files')

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
  baseChunkBytes: 1024 * 1024,
  // Async OPFS stores each committed write batch in an immutable delta file.
  // Compact when there are too many small files even if the byte threshold
  // has not been reached.
  autoCompactMaxLogFiles: 256
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
    this.blob = null // immutable File snapshot; may outlive its directory entry
    this.size = 0 // length of the last valid prefix during recovery, else file size
    this.refs = 0 // 1 while part of the live state, +1 per view holding it
    this.obsolete = false // replaced by compaction; deleted when refs reach 0
    this.startSequence = 0 // sequence number of the first op in this file
  }

  async getBlob() {
    if (this.blob !== null) return this.blob
    if (this.shared === null) throw makeError('RocksDB session is closed')
    this.blob = await this.shared.fileHandle.getFile()
    return this.blob
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
    this.resumeMaxFileNumber = null

    this.files = new Map() // number -> LogFile, every file this engine has open
    this.live = [] // LogFiles making up the current state, oldest first
    this.active = null // LogFile receiving appends (writable engines only)
    this.maxFileNumber = 0

    this.roots = new Map() // column family id -> tree root
    this.cfIds = new Map([[DEFAULT_CF, DEFAULT_CF_ID]]) // name -> id
    this.nextCfId = DEFAULT_CF_ID + 1

    this.sequence = 0 // ops applied so far, like RocksDB's sequence number
    this.compacting = null
    this.compactTimer = null
    this.mutations = Promise.resolve()
    this.accepting = true
    this.needsCheckpoint = false

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

    if (!this.readOnly) {
      await this._takeLock()
      // Change the session before modifying or cleaning any log files. A
      // suspended former writer must never mistake a failed new open for an
      // unchanged store and resume with a stale in-memory index.
      await this._writeSession()
    } else {
      this.sessionId = await this._readSession()
    }

    // Read-only opens can overlap a writer because committed log files are
    // immutable. A compaction race can remove a file between directory listing
    // and getFile(); retry the snapshot if that happens.
    let opened = false
    for (let attempt = 0; attempt < 4 && !opened; attempt++) {
      try {
        const numbers = await this._listLogFiles()

        if (numbers.length === 0) {
          if (!create) {
            throw makeError(`${this.path}: does not exist (create_if_missing is false)`, 'ENOENT')
          }
          await this._startNewLog()
        } else {
          await this._recover(numbers)
        }
        opened = true
      } catch (err) {
        if (!this.readOnly || !err || err.name !== 'NotFoundError' || attempt === 3) throw err
        await this._resetFilesForRetry()
      }
    }

    if (!this.readOnly && this.needsCheckpoint) await this._checkpointRecoveredState()

    await this._defineColumnFamilies(cfNames)

    this.resumeMaxFileNumber = this.maxFileNumber
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

  async _resetFilesForRetry() {
    for (const file of this.files.values()) {
      if (file.shared !== null) await files.release(file.shared)
    }
    this.files.clear()
    this.live = []
    this.active = null
    this.maxFileNumber = 0
    this.roots = new Map()
    this.cfIds = new Map([[DEFAULT_CF, DEFAULT_CF_ID]])
    this.nextCfId = DEFAULT_CF_ID + 1
    this.sequence = 0
    this.needsCheckpoint = false
  }

  // Writable stores use an origin-scoped exclusive Web Lock. Read-only opens
  // deliberately do not take it: they read immutable File snapshots, and the
  // recovery path retries if compaction removes an entry mid-open.
  async _takeLock() {
    try {
      this.lock = await files.acquireStoreLock(this.path)
    } catch (err) {
      if (err && err.code === 'EBUSY') throw makeError(err.message, 'EBUSY')
      throw err
    }
  }

  // A suspended writer compares this id when resuming. If a different writer
  // has opened the store meanwhile, its id differs and the in-memory index is
  // stale, so resuming is refused.
  async _writeSession() {
    this.sessionId = randomId()
    await files.writeFile(this.dir, SESSION_FILE, textEncoder.encode(this.sessionId))
  }

  async _readSession() {
    try {
      return textDecoder.decode(await files.readFile(this.dir, SESSION_FILE))
    } catch (err) {
      if (err && err.name === 'NotFoundError') return null
      throw err
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
    this.maxFileNumber = numbers.length > 0 ? numbers[numbers.length - 1] : 0
    return numbers
  }

  async _openLogFile(number, { create = false } = {}) {
    const name = logName(number)
    let shared
    try {
      shared = await files.acquire(this.dir, this.path, name, { create, lease: this.readOnly })
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

  // Creates the first log file of a new store. The header is committed by
  // closing an asynchronous writable stream.
  async _startNewLog() {
    const number = this.maxFileNumber + 1
    const name = logName(number)
    const write_lock = await files.acquireFileWriteLock(this.path, name)
    let file = null
    let writer = null

    try {
      file = await this._openLogFile(number, { create: true })
      const header = log.encodeHeader(log.FILE_DELTA)
      writer = await files.createWriter(file.shared)
      await writer.write(header)
      await writer.close()
      file.size = header.byteLength
      file.startSequence = this.sequence
      this._addLive(file)
      this.active = file
    } catch (err) {
      if (writer !== null) {
        try { await writer.abort() } catch {}
      }
      if (file !== null) {
        try { await this._discard(file) } catch {}
        try {
          // Keep readers from seeing a failed/empty log as committed history.
          await files.removeFileWhileLocked(this.dir, name)
        } catch {
          this.accepting = false
        }
      }
      throw err
    } finally {
      write_lock.close()
    }
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
  // The database has its own checksummed log format. Recovery replays the
  // newest complete base and subsequent deltas, stopping at the first torn or
  // corrupt record. Since committed files are immutable, a writable open that
  // finds corruption checkpoints the recovered prefix into a fresh base
  // instead of truncating a log file in place.

  async _recover(numbers) {
    const found = []
    for (const n of numbers) found.push(await this._openLogFile(n))

    const garbage = new Set()
    let start = 0
    let baseResult = null

    for (let i = found.length - 1; i >= 0; i--) {
      if (await this._readFileKind(found[i]) !== log.FILE_BASE) continue
      this._resetState()
      const result = await this._replayFile(found[i])
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

      const result = i === start && baseResult !== null ? baseResult : await this._replayFile(file)

      if (result.kind === 0) {
        // No valid header at all (for example, an interrupted first write).
        garbage.add(file)
        stoppedEarly = result.corrupt
        if (result.corrupt) this.needsCheckpoint = true
        continue
      }

      file.size = result.end
      this._addLive(file)
      if (result.corrupt) {
        stoppedEarly = true
        this.needsCheckpoint = true
      }
    }

    for (const file of garbage) await this._discard(file)

    if (this.live.length === 0) {
      if (this.readOnly) return // an empty, read-only view
      await this._startNewLog()
      return
    }

    // Delta files are immutable. New writes always go into a new file, so a
    // damaged tail does not need an in-place truncate.
    this.active = this.live[this.live.length - 1]
  }

  _resetState() {
    this.roots = new Map()
    this.cfIds = new Map([[DEFAULT_CF, DEFAULT_CF_ID]])
    this.nextCfId = DEFAULT_CF_ID + 1
    this.sequence = 0
  }

  // The kind from a file's header, or 0 if it has no valid header.
  async _readFileKind(file) {
    const blob = await file.getBlob()
    const record = await log.readRecord(blob, 0, blob.size)
    if (record === null) return 0
    try {
      const decoded = log.decodeBody(record.body)
      return decoded.type === log.RECORD_HEADER ? decoded.kind : 0
    } catch {
      return 0
    }
  }

  // Replays every valid record of one immutable file into the current state.
  // Returns { kind, end, corrupt, baseComplete }.
  async _replayFile(file) {
    const blob = await file.getBlob()
    const size = blob.size
    const result = { kind: 0, end: 0, corrupt: size > 0, baseComplete: false }

    const first = await log.readRecord(blob, 0, size)
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
      const record = await log.readRecord(blob, offset, size)
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

  async _checkpointRecoveredState() {
    // Never truncate a damaged file: create a complete base file first, then
    // atomically switch the live set and retire the old files. An exclusive
    // file lease hides the incomplete base from read-only openers until commit.
    const number = this.maxFileNumber + 1
    const name = logName(number)
    const write_lock = await files.acquireFileWriteLock(this.path, name)
    let file = null

    try {
      file = await this._openLogFile(number, { create: true })
      const roots = await this._writeBase(file)

      const old = this.live
      this.live = []
      this._addLive(file)
      this.active = file
      this.roots = roots
      for (const oldFile of old) {
        oldFile.obsolete = true
        this._unref(oldFile)
      }
      this.needsCheckpoint = false
    } catch (err) {
      if (file !== null) {
        try { await this._discard(file) } catch {}
        try {
          await files.removeFileWhileLocked(this.dir, name)
        } catch {
          this.accepting = false
        }
      }
      throw err
    } finally {
      write_lock.close()
    }
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
  _applyOp(op, location, state = this) {
    switch (op.type) {
      case log.OP_PUT:
        state.roots.set(op.cf, tree.set(this._root(op.cf, state), op.key, location))
        break
      case log.OP_DELETE:
        state.roots.set(op.cf, tree.remove(this._root(op.cf, state), op.key))
        break
      case log.OP_DELETE_RANGE:
        state.roots.set(op.cf, tree.removeRange(this._root(op.cf, state), op.start, op.end))
        break
      case log.OP_DEFINE_CF: {
        const name = textDecoder.decode(op.name)
        state.cfIds.set(name, op.cf)
        if (op.cf >= state.nextCfId) state.nextCfId = op.cf + 1
        break
      }
    }
  }

  _root(cf, state = this) {
    const root = state.roots.get(cf)
    return root === undefined ? tree.EMPTY : root
  }

  // --- Column families ------------------------------------------------------

  async _defineColumnFamilies(names) {
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

    await this._append(ops)
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

  _enqueueMutation(fn) {
    const result = this.mutations.then(fn)
    this.mutations = result.catch(() => {})
    return result
  }

  // Writes a batch atomically. Input bytes are copied because the actual write
  // now occurs asynchronously after this call returns.
  write(ops) {
    this._assertOpen()
    if (!this.accepting) throw makeError('RocksDB session is closed')
    if (this.readOnly) throw makeError('Not supported operation in read only mode.', 'ENOTSUP')

    const own = new Array(ops.length)
    for (let i = 0; i < ops.length; i++) {
      const op = ops[i]
      switch (op.type) {
        case log.OP_PUT:
          own[i] = { type: op.type, cf: op.cf, key: ownCopy(op.key), value: ownCopy(op.value) }
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

    return this._enqueueMutation(() => this._append(own))
  }

  // Each batch is written as a new immutable delta file: header + one atomic
  // batch record. Closing the writable stream is the publication boundary.
  // Only after close succeeds do we publish the new tree roots in memory.
  async _append(ops) {
    const { record, valueOffsets } = log.encodeBatch(ops)
    const number = this.maxFileNumber + 1
    const name = logName(number)
    const header = log.encodeHeader(log.FILE_DELTA)
    const at = header.byteLength

    // Stage all mutations against private roots before touching disk. Readers
    // continue to see the old roots while the OPFS write is pending, and a
    // failed encoding/tree update can't publish a partial batch.
    const staged = {
      roots: new Map(this.roots),
      cfIds: new Map(this.cfIds),
      nextCfId: this.nextCfId
    }
    let bytes_written = 0
    let keys_written = 0
    for (let i = 0; i < ops.length; i++) {
      const op = ops[i]
      let location = null
      if (op.type === log.OP_PUT) {
        location = { file: number, offset: at + valueOffsets[i], length: op.value.byteLength }
        bytes_written += op.value.byteLength
      }
      if (op.type !== log.OP_DEFINE_CF) keys_written++
      this._applyOp(op, location, staged)
    }

    // Acquire the exclusive file lease before creating the directory entry. A
    // read-only opener that sees this number must wait until the stream closes
    // or fails and cleanup removes it.
    const write_lock = await files.acquireFileWriteLock(this.path, name)
    let file = null
    let writer = null

    try {
      try {
        file = await this._openLogFile(number, { create: true })
        writer = await files.createWriter(file.shared)
        await writer.write(header)
        await writer.write(record)
        await writer.close()
      } catch (err) {
        if (writer !== null) {
          try { await writer.abort() } catch {}
        }
        if (file !== null) {
          try { await this._discard(file) } catch {}
          try {
            await files.removeFileWhileLocked(this.dir, name)
          } catch {
            // If cleanup fails, stop accepting writes. Otherwise a later valid
            // delta could appear after an unreadable delta and be lost on replay.
            this.accepting = false
          }
        }
        throw err
      }

      // The stream close committed the whole batch. Publish its staged state
      // synchronously while still holding the file lease, then let readers see
      // the completed file. No await occurs between these state changes.
      file.size = header.byteLength + record.byteLength
      file.startSequence = this.sequence
      this._addLive(file)
      this.active = file
      this.roots = staged.roots
      this.cfIds = staged.cfIds
      this.nextCfId = staged.nextCfId
      this.counters.bytesWritten += bytes_written
      this.counters.keysWritten += keys_written
      this.sequence += ops.length
    } finally {
      write_lock.close()
    }

    this._maybeScheduleCompaction()
  }

  // Every write callback is resolved only after its file has been committed.
  // Thus there is no deferred flush to perform; this method is a barrier for
  // earlier mutations and is still awaited by flushWal/flush.
  async flushNow() {
    this._assertOpen()
    await this.mutations
  }

  // --- Reading --------------------------------------------------------------

  // Returns the value (an ArrayBuffer) or null. Reads from `view` if given,
  // otherwise from the current state.
  async get(cf, key, view = null) {
    this._assertOpen()
    // Capture the root before the first await: the operation observes the state
    // at invocation, even if a write or compaction completes during file I/O.
    const root = view === null ? this._root(cf) : view.roots.get(cf) || tree.EMPTY
    const location = tree.get(root, key)
    this.counters.keysRead++
    return location === undefined ? null : this._readValue(location)
  }

  async _readValue(location) {
    const bytes = new Uint8Array(location.length)
    const file = this.files.get(location.file)
    if (file === undefined) throw makeError('Value refers to a missing log file', 'EIO')

    // An awaited OPFS read yields to the event loop. Compaction may switch the
    // live roots and retire this file meanwhile, even when the caller did not
    // create a snapshot. Pin it until the in-flight read completes.
    file.refs++
    try {
      if (location.length > 0) {
        const blob = await file.getBlob()
        const data = new Uint8Array(await blob.slice(location.offset, location.offset + location.length).arrayBuffer())
        if (data.byteLength !== location.length) throw makeError('Short read from log file', 'EIO')
        bytes.set(data)
      }
      this.counters.bytesRead += location.length
      return bytes.buffer
    } finally {
      this._unref(file)
    }
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
      if (this.state !== 'open' || !this.accepting) {
        return Promise.reject(makeError('RocksDB session is closed'))
      }
      const queued = this._enqueueMutation(() => this._compact())
      this.compacting = queued.finally(() => {
        this.compacting = null
      })
    }
    return this.compacting
  }

  async _compact() {
    this._assertOpen()
    if (this.readOnly) throw makeError('Not supported operation in read only mode.', 'ENOTSUP')

    const number = this.maxFileNumber + 1
    const name = logName(number)
    const write_lock = await files.acquireFileWriteLock(this.path, name)
    let file = null

    try {
      file = await this._openLogFile(number, { create: true })
      const roots = await this._writeBase(file)

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
    } catch (err) {
      if (file !== null) {
        try { await this._discard(file) } catch {}
        try {
          await files.removeFileWhileLocked(this.dir, name)
        } catch {
          this.accepting = false
        }
      }
      throw err
    } finally {
      write_lock.close()
    }
  }

  // Writes every live entry into a new base using an async writable stream.
  // The target file remains unpublished until close() commits the complete
  // stream, including BASE_END. A crashed/incomplete compaction is ignored.
  async _writeBase(file) {
    let writer = null
    const header = log.encodeHeader(log.FILE_BASE)
    let offset = 0
    let entries = 0

    const writeBytes = async (bytes) => {
      await writer.write(bytes)
      offset += bytes.byteLength
    }

    const writeRecord = async (ops) => {
      const { record, valueOffsets } = log.encodeBatch(ops)
      const at = offset
      await writeBytes(record)
      return { at, valueOffsets }
    }

    try {
      writer = await files.createWriter(file.shared)
      await writeBytes(header)

      // Column family definitions come first, so a replay knows every family
      // before it meets their data.
      const definitions = []
      for (const [name, id] of this.cfIds) {
        if (id === DEFAULT_CF_ID) continue
        definitions.push({ type: log.OP_DEFINE_CF, cf: id, name: textEncoder.encode(name) })
      }
      if (definitions.length > 0) await writeRecord(definitions)

      const roots = new Map()

      for (const [cf, root] of this.roots) {
        const rows = []
        tree.forEach(root, (key, location) => rows.push({ key, location }))
        const sorted = []
        let ops = []
        let pendingBytes = 0

        const flushChunk = async () => {
          if (ops.length === 0) return
          const { at, valueOffsets } = await writeRecord(ops)
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

        for (const row of rows) {
          const value = new Uint8Array(await this._readValue(row.location))
          ops.push({ type: log.OP_PUT, cf, key: row.key, value })
          pendingBytes += row.key.byteLength + value.byteLength
          if (pendingBytes >= config.baseChunkBytes) await flushChunk()
        }
        await flushChunk()
        roots.set(cf, tree.fromSorted(sorted))
      }

      await writeBytes(log.encodeBaseEnd(entries))
      await writer.close()
      file.size = offset
      file.startSequence = this.sequence
      return roots
    } catch (err) {
      if (writer !== null) {
        try { await writer.abort() } catch {}
      }
      throw err
    }
  }

  _maybeScheduleCompaction() {
    if (this.readOnly || this.state !== 'open' || this.compacting !== null || this.compactTimer !== null) return

    const logBytes = this.logBytes()
    const tooManyFiles = this.live.length >= config.autoCompactMaxLogFiles
    if (!tooManyFiles && logBytes < config.autoCompactMinBytes) return
    if (!tooManyFiles && logBytes < config.autoCompactRatio * this.liveBytes()) return

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
  // anything in memory, so another tab can open the store meanwhile. A writer
  // validates SESSION_ID before resuming. A read-only engine also checks the
  // session and log generation, since a writer may already have been open when
  // that reader suspended and could append without changing SESSION_ID.

  async suspend() {
    if (this.state !== 'open' || !this.accepting) throw makeError('RocksDB session is not open')
    this.accepting = false

    const operation = this.mutations.then(async () => {
      if (this.state !== 'open') throw makeError('RocksDB session is not open')
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
    })
    this.mutations = operation.catch(() => {})
    await operation
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
    } else {
      // A read-only engine has no writer lock to keep its view current while
      // suspended. The session ID detects a replacement writer; the maximum
      // log number detects batches/compactions by a writer that was already
      // open when this reader suspended. Ensure every log still referenced by
      // the old roots also exists before reacquiring any handles.
      const session_id = await this._readSession()
      const expected_max = this.resumeMaxFileNumber
      const current_numbers = await this._listLogFiles()
      const current = new Set(current_numbers)
      const missing_live_file = this.live.some((file) => !current.has(file.number))
      if (session_id !== this.sessionId || this.maxFileNumber !== expected_max || missing_live_file) {
        throw makeError('Store changed while suspended')
      }
    }

    const reopened = []
    try {
      for (const file of this.files.values()) {
        file.shared = await files.acquire(this.dir, this.path, file.name, { lease: this.readOnly })
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
    this.accepting = true
  }

  async close() {
    if (this.state === 'closed') return
    this.accepting = false

    if (this.compactTimer !== null) {
      clearTimeout(this.compactTimer)
      this.compactTimer = null
    }

    const operation = this.mutations.then(async () => {
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
    })
    this.mutations = operation.catch(() => {})
    await operation
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
  async read(n) {
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
      if (!this.keysOnly) values.push(await this.engine._readValue(node.value))
    }

    return { keys, values }
  }

  close() {
    this.engine.releaseView(this.view)
  }
}

module.exports = { Engine, configure, config, makeError }
