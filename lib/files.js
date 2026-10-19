// Opening OPFS directories and files, and sharing open files.
//
// OPFS lets only one sync access handle be open per file. A writer and a
// read-only reader of the same store in the same worker both need the same
// log files, so handles are shared here, keyed by path, and reference-counted.
// A handle is closed when its last user releases it.
//
// Files can also be marked obsolete (compaction has replaced them). An
// obsolete file is deleted once its last user releases it, so a reader still
// looking at old data keeps it alive until it's done.
//
// The sharing only works within one JavaScript realm (one worker). Across
// tabs or workers, OPFS's own exclusive lock applies and a second opener gets
// an error.

const open = new Map() // key -> SharedFile

class SharedFile {
  constructor(key, dir, name, handle) {
    this.key = key
    this.dir = dir
    this.name = name
    this.handle = handle
    this.refs = 1
    this.obsolete = false
  }
}

function storage() {
  const nav = globalThis.navigator
  if (!nav || !nav.storage || typeof nav.storage.getDirectory !== 'function') {
    throw new Error('OPFS is not available (navigator.storage.getDirectory is missing)')
  }
  return nav.storage
}

// Splits a store path into directory names under the OPFS root. Both '/' and
// '\' separate segments; empty and '.' segments are ignored; '..' is refused
// because OPFS has no parent links and silently ignoring it would be surprising.
function pathSegments(path) {
  const segments = String(path)
    .split(/[\\/]+/)
    .filter((s) => s !== '' && s !== '.')

  for (const s of segments) {
    if (s === '..') throw new Error(`Invalid path (contains '..'): ${path}`)
  }

  return segments
}

// Returns the directory handle for `path`, creating it if `create` is set.
// Returns null if it doesn't exist and `create` is false.
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

// A stable string identifying a file, used as the sharing key.
function fileKey(path, name) {
  return '/' + pathSegments(path).join('/') + '/' + name
}

// Acquires a shared sync access handle for `name` in `dir`. Creates the file
// if `create` is set. Throws NotFoundError if it doesn't exist, and
// NoModificationAllowedError if someone outside this realm holds it.
async function acquire(dir, path, name, { create = false } = {}) {
  const key = fileKey(path, name)
  const existing = open.get(key)

  if (existing) {
    existing.refs++
    return existing
  }

  const fileHandle = await dir.getFileHandle(name, { create })
  const handle = await fileHandle.createSyncAccessHandle()

  // Another caller may have opened the same file while we were awaiting.
  // OPFS would normally have refused our handle in that case, but be safe.
  const raced = open.get(key)
  if (raced) {
    handle.close()
    raced.refs++
    return raced
  }

  const shared = new SharedFile(key, dir, name, handle)
  open.set(key, shared)
  return shared
}

// Releases one reference. Closes the handle when none are left, and deletes
// the file if it was marked obsolete.
async function release(shared) {
  if (--shared.refs > 0) return

  open.delete(shared.key)
  shared.handle.close()

  if (shared.obsolete) {
    try {
      await shared.dir.removeEntry(shared.name)
    } catch {
      // Best effort. A leftover obsolete file is harmless: the next writable
      // open of the store recognises and deletes it.
    }
  }
}

function markObsolete(shared) {
  shared.obsolete = true
}

// True if any handle for a file under `path` is open in this realm.
function isOpenWithin(path) {
  const prefix = fileKey(path, '')
  for (const key of open.keys()) {
    if (key.startsWith(prefix)) return true
  }
  return false
}

// Opens a small file outside the sharing table, for exclusive use (LOCK,
// SESSION_ID). The caller must close the returned handle.
async function openExclusive(dir, name, { create = false } = {}) {
  const fileHandle = await dir.getFileHandle(name, { create })
  return fileHandle.createSyncAccessHandle()
}

module.exports = {
  pathSegments,
  openDirectory,
  acquire,
  release,
  markObsolete,
  isOpenWithin,
  openExclusive
}
