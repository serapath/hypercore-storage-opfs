// Async OPFS file access and store locking.
//
// This module deliberately does not use FileSystemSyncAccessHandle. Files are
// read through immutable File snapshots and written through
// FileSystemWritableFileStream. Database log files are treated as immutable
// after each commit; the engine creates a new log file for each atomic batch.
//
// `open` shares FileSystemFileHandle objects and reference-counts obsolete
// files within one realm. Read-only engines hold shared Web Lock leases on
// every log file their views may need; compaction acquires the corresponding
// exclusive lock before deleting a file. Do not assume a File snapshot stays
// readable after its underlying directory entry is removed.

const open = new Map() // key -> SharedFile

class SharedFile {
  constructor(key, dir, name, fileHandle) {
    this.key = key
    this.dir = dir
    this.name = name
    this.fileHandle = fileHandle
    this.refs = 1
    this.obsolete = false
    this.readerLease = null
    this.readerLeasePromise = null
  }
}

function storage() {
  const nav = globalThis.navigator
  if (!nav || !nav.storage || typeof nav.storage.getDirectory !== 'function') {
    throw new Error('OPFS is not available (navigator.storage.getDirectory is missing)')
  }
  return nav.storage
}

function locks() {
  const nav = globalThis.navigator
  if (!nav || !nav.locks || typeof nav.locks.request !== 'function') {
    throw new Error('Web Locks API is not available (navigator.locks.request is missing)')
  }
  return nav.locks
}

// Splits a store path into directory names under the OPFS root. Both '/' and
// '\\' separate segments; empty and '.' segments are ignored; '..' is refused.
function pathSegments(path) {
  const segments = String(path)
    .split(/[\\/]+/)
    .filter((s) => s !== '' && s !== '.')

  for (const s of segments) {
    if (s === '..') throw new Error(`Invalid path (contains '..'): ${path}`)
  }

  return segments
}

async function openDirectory(path, { create }) {
  let dir = await storage().getDirectory()

  for (const segment of pathSegments(path)) {
    try {
      dir = await dir.getDirectoryHandle(segment, { create })
    } catch (err) {
      if (err && err.name === 'NotFoundError') return null
      throw err
    }
  }

  return dir
}

function fileKey(path, name) {
  return '/' + pathSegments(path).join('/') + '/' + name
}

function fileLeaseName(key) {
  return 'rocksdb-native-opfs:file:' + key
}

async function acquireWebLock(name, { mode = 'exclusive', ifAvailable = false } = {}) {
  let resolve_acquired
  let reject_acquired
  let release_lock
  const acquired = new Promise((resolve, reject) => {
    resolve_acquired = resolve
    reject_acquired = reject
  })

  const options = { mode }
  if (ifAvailable) options.ifAvailable = true

  const request = locks().request(name, options, async (lock) => {
    if (!lock) {
      resolve_acquired(null)
      return
    }

    const held = new Promise((resolve) => { release_lock = resolve })
    resolve_acquired({
      close() {
        if (release_lock) {
          const release = release_lock
          release_lock = null
          release()
        }
      }
    })
    await held
  })

  request.catch(reject_acquired)
  const acquired_lock = await acquired
  if (acquired_lock === null) return null

  // The request promise intentionally remains pending while we own the lock.
  // Consume any later rejection so context shutdown cannot cause an unhandled
  // rejection after the caller has already received the lock handle.
  request.catch(() => {})
  return acquired_lock
}

async function acquireReaderLease(shared) {
  if (shared.readerLease !== null) return
  if (shared.readerLeasePromise !== null) return shared.readerLeasePromise

  shared.readerLeasePromise = (async () => {
    const lease = await acquireWebLock(fileLeaseName(shared.key), { mode: 'shared' })
    shared.readerLease = lease
  })()

  try {
    await shared.readerLeasePromise
  } finally {
    shared.readerLeasePromise = null
  }
}

async function acquire(dir, path, name, { create = false, lease = false } = {}) {
  const key = fileKey(path, name)
  let existing = open.get(key)

  if (existing) {
    // Take a temporary reference before awaiting the lock, otherwise a writer
    // could retire and delete this shared entry while a reader is acquiring its
    // lease. Roll the reference back if lock acquisition fails.
    existing.refs++
    try {
      if (lease) await acquireReaderLease(existing)
      return existing
    } catch (err) {
      await release(existing)
      throw err
    }
  }

  // Acquire a shared file lease before opening the entry. A compactor obtains
  // the corresponding exclusive lock before deleting an obsolete log. If a
  // deletion is already in progress, this request waits and the subsequent
  // getFileHandle can cleanly report that the entry disappeared.
  const reader_lease = lease
    ? await acquireWebLock(fileLeaseName(key), { mode: 'shared' })
    : null

  let fileHandle
  try {
    fileHandle = await dir.getFileHandle(name, { create })
  } catch (err) {
    if (reader_lease !== null) reader_lease.close()
    throw err
  }

  const raced = open.get(key)
  if (raced) {
    if (reader_lease !== null) reader_lease.close()
    raced.refs++
    try {
      if (lease) await acquireReaderLease(raced)
      return raced
    } catch (err) {
      await release(raced)
      throw err
    }
  }

  const shared = new SharedFile(key, dir, name, fileHandle)
  shared.readerLease = reader_lease
  open.set(key, shared)
  return shared
}

async function release(shared) {
  if (--shared.refs > 0) return

  open.delete(shared.key)

  const reader_lease = shared.readerLease
  shared.readerLease = null
  if (reader_lease !== null) reader_lease.close()

  if (!shared.obsolete) return

  // Obsolete files can only be removed while holding the exclusive side of
  // the same Web Lock readers hold shared for as long as their views need the
  // file. If any reader is still active, leave the orphan for a later writable
  // open to collect; never invalidate a live reader's File snapshot.
  const deletion_lock = await acquireWebLock(fileLeaseName(shared.key), {
    mode: 'exclusive',
    ifAvailable: true
  })
  if (deletion_lock === null) return

  try {
    await shared.dir.removeEntry(shared.name)
  } catch (err) {
    if (!err || err.name !== 'NotFoundError') throw err
  } finally {
    deletion_lock.close()
  }
}

function markObsolete(shared) {
  shared.obsolete = true
}

function isOpenWithin(path) {
  const prefix = fileKey(path, '')
  for (const key of open.keys()) {
    if (key.startsWith(prefix)) return true
  }
  return false
}

// A writer holds an exclusive Web Lock for the store's lifetime. Read-only
// opens do not hold the writer lock, but lease each log file in shared mode for
// as long as any view may need it. Writers and readers can coexist; deletion of
// obsolete files is deferred while a reader's lease is held.
async function acquireFileWriteLock(path, name) {
  return acquireWebLock(fileLeaseName(fileKey(path, name)), { mode: 'exclusive' })
}

// Caller must hold acquireFileWriteLock(path, name). Used to remove an
// incomplete newly-created log before readers are allowed to lease its name.
async function removeFileWhileLocked(dir, name) {
  try {
    await dir.removeEntry(name)
  } catch (err) {
    if (!err || err.name !== 'NotFoundError') throw err
  }
}

async function acquireStoreLock(path) {
  const name = 'rocksdb-native-opfs:writer:' + '/' + pathSegments(path).join('/')
  const lock = await acquireWebLock(name, { mode: 'exclusive', ifAvailable: true })
  if (lock === null) {
    throw Object.assign(new Error(`lock ${path}/LOCK: already held by another open database`), { code: 'EBUSY' })
  }
  return lock
}

async function createWriter(shared, options = {}) {
  return shared.fileHandle.createWritable(options)
}

async function writeFile(dir, name, bytes) {
  const fileHandle = await dir.getFileHandle(name, { create: true })
  const writer = await fileHandle.createWritable()
  try {
    await writer.write(bytes)
    await writer.close()
  } catch (err) {
    try {
      await writer.abort()
    } catch {}
    throw err
  }
}

async function readFile(dir, name) {
  const fileHandle = await dir.getFileHandle(name)
  const file = await fileHandle.getFile()
  return new Uint8Array(await file.arrayBuffer())
}

module.exports = {
  pathSegments,
  openDirectory,
  acquire,
  release,
  markObsolete,
  isOpenWithin,
  acquireStoreLock,
  acquireFileWriteLock,
  removeFileWhileLocked,
  createWriter,
  writeFile,
  readFile
}
