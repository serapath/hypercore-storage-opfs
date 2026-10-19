// opfs-node: the browser's Origin Private File System (OPFS) API, implemented
// on top of Node's `fs`, so code written for OPFS can be developed and tested
// in Node without a browser.
//
// The shim is deliberately STRICT. Anything it allows that a browser refuses is
// a bug that would only surface later in a real browser, so it refuses the same
// things browsers refuse, with the same error names:
//
//   - createSyncAccessHandle() only works off the main thread. Browsers only
//     expose it inside dedicated Web Workers, so run code under test inside
//     `worker_threads`.
//   - A file can have only one sync access handle open at a time (an exclusive
//     lock). A second one fails with NoModificationAllowedError.
//   - Removing a locked file, or a directory containing one, fails with
//     NoModificationAllowedError.
//   - Using a closed sync access handle fails with InvalidStateError.
//   - Names are validated: '', '.', '..', or names containing '/' or '\'
//     throw TypeError.
//   - A missing entry gives NotFoundError; asking for a file where a directory
//     is (or the reverse) gives TypeMismatchError.
//   - Removing a non-empty directory without { recursive: true } gives
//     InvalidModificationError.
//
// Not modelled (documented so nobody relies on them):
//   - Locks are per Node thread. Real OPFS locks are origin-wide, across all
//     tabs and workers.
//   - Storage quota and eviction.
//   - getFile() while a sync access handle is open: browsers differ, so the shim
//     refuses it (NoModificationAllowedError). Code that passes here won't
//     depend on it.
//   - createWritable() and move() are not implemented.

const fs = require('fs')
const path = require('path')
const { isMainThread } = require('worker_threads')

// Every storage created by this module shares one lock table per thread,
// mirroring how OPFS locks are shared by everything in an origin.
const locks = new Map() // absolute file path -> open FileSystemSyncAccessHandle

function domError(name, message) {
  return new DOMException(message, name)
}

function validateName(name) {
  if (typeof name !== 'string') name = String(name)
  if (name === '' || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
    throw new TypeError(`Name is not allowed: '${name}'`)
  }
  return name
}

function statOrNull(p) {
  try {
    return fs.statSync(p)
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
}

function isLockedWithin(dirPath) {
  const prefix = dirPath + path.sep
  for (const p of locks.keys()) {
    if (p.startsWith(prefix)) return true
  }
  return false
}

class FileSystemHandle {
  constructor(kind, name, fullPath) {
    this.kind = kind
    this.name = name
    this._path = fullPath
  }

  async isSameEntry(other) {
    return !!other && other.kind === this.kind && other._path === this._path
  }
}

class FileSystemDirectoryHandle extends FileSystemHandle {
  constructor(name, fullPath, options) {
    super('directory', name, fullPath)
    this._options = options
  }

  _child(name) {
    return path.join(this._path, validateName(name))
  }

  _assertExists() {
    if (!statOrNull(this._path)) {
      throw domError('NotFoundError', 'A requested file or directory could not be found.')
    }
  }

  async getDirectoryHandle(name, { create = false } = {}) {
    const p = this._child(name)
    this._assertExists()
    const st = statOrNull(p)

    if (st === null) {
      if (!create) {
        throw domError('NotFoundError', 'A requested file or directory could not be found.')
      }
      fs.mkdirSync(p)
    } else if (!st.isDirectory()) {
      throw domError('TypeMismatchError', 'The path supplied exists, but was not an entry of requested type.')
    }

    return new FileSystemDirectoryHandle(name, p, this._options)
  }

  async getFileHandle(name, { create = false } = {}) {
    const p = this._child(name)
    this._assertExists()
    const st = statOrNull(p)

    if (st === null) {
      if (!create) {
        throw domError('NotFoundError', 'A requested file or directory could not be found.')
      }
      fs.writeFileSync(p, new Uint8Array(0))
    } else if (!st.isFile()) {
      throw domError('TypeMismatchError', 'The path supplied exists, but was not an entry of requested type.')
    }

    return new FileSystemFileHandle(name, p, this._options)
  }

  async removeEntry(name, { recursive = false } = {}) {
    const p = this._child(name)
    const st = statOrNull(p)

    if (st === null) {
      throw domError('NotFoundError', 'A requested file or directory could not be found.')
    }

    if (st.isDirectory()) {
      if (isLockedWithin(p)) {
        throw domError('NoModificationAllowedError', 'An entry inside the directory is locked.')
      }
      if (!recursive && fs.readdirSync(p).length > 0) {
        throw domError('InvalidModificationError', 'The directory is not empty.')
      }
      fs.rmSync(p, { recursive: true, force: true })
      return
    }

    if (locks.has(p)) {
      throw domError('NoModificationAllowedError', 'The file is locked by an open access handle.')
    }
    fs.unlinkSync(p)
  }

  async resolve(possibleDescendant) {
    const rel = path.relative(this._path, possibleDescendant._path)
    if (rel.startsWith('..') || path.isAbsolute(rel)) return null
    return rel === '' ? [] : rel.split(path.sep)
  }

  async *entries() {
    this._assertExists()
    for (const dirent of fs.readdirSync(this._path, { withFileTypes: true })) {
      const p = path.join(this._path, dirent.name)
      if (dirent.isDirectory()) {
        yield [dirent.name, new FileSystemDirectoryHandle(dirent.name, p, this._options)]
      } else if (dirent.isFile()) {
        yield [dirent.name, new FileSystemFileHandle(dirent.name, p, this._options)]
      }
    }
  }

  async *keys() {
    for await (const [name] of this.entries()) yield name
  }

  async *values() {
    for await (const [, handle] of this.entries()) yield handle
  }

  [Symbol.asyncIterator]() {
    return this.entries()
  }
}

class FileSystemFileHandle extends FileSystemHandle {
  constructor(name, fullPath, options) {
    super('file', name, fullPath)
    this._options = options
  }

  async getFile() {
    if (locks.has(this._path)) {
      throw domError('NoModificationAllowedError', 'opfs-node refuses getFile() while a sync access handle is open.')
    }
    if (!statOrNull(this._path)) {
      throw domError('NotFoundError', 'A requested file or directory could not be found.')
    }
    return new File([fs.readFileSync(this._path)], this.name)
  }

  async createSyncAccessHandle() {
    // Browsers only expose this method in dedicated workers. On the main thread
    // the method simply isn't there, which surfaces as a TypeError.
    if (isMainThread) {
      throw new TypeError('createSyncAccessHandle is not a function (only available in dedicated workers)')
    }
    if (locks.has(this._path)) {
      throw domError('NoModificationAllowedError', 'Access Handles cannot be created if there is another open Access Handle or Writable stream associated with the file.')
    }
    if (!statOrNull(this._path)) {
      throw domError('NotFoundError', 'A requested file or directory could not be found.')
    }

    const fd = fs.openSync(this._path, 'r+')
    const handle = new FileSystemSyncAccessHandle(this._path, fd, this._options)
    locks.set(this._path, handle)
    return handle
  }

  async createWritable() {
    throw domError('NotSupportedError', 'opfs-node does not implement createWritable().')
  }

  async move() {
    throw domError('NotSupportedError', 'opfs-node does not implement move().')
  }
}

function toView(buffer) {
  if (buffer instanceof ArrayBuffer) return new Uint8Array(buffer)
  if (ArrayBuffer.isView(buffer)) return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  throw new TypeError('The provided value is not of type (ArrayBuffer or ArrayBufferView)')
}

function toPosition(at) {
  // WebIDL "unsigned long long" with [EnforceRange]: must be a finite,
  // non-negative integer.
  if (typeof at !== 'number' || !Number.isFinite(at) || at < 0) {
    throw new TypeError(`Value is outside the 'unsigned long long' value range: ${at}`)
  }
  return Math.floor(at)
}

class FileSystemSyncAccessHandle {
  constructor(filePath, fd, options) {
    this._path = filePath
    this._fd = fd
    this._closed = false
    this._cursor = 0 // the "file position cursor" from the spec
    this._fsync = !!options.fsync
  }

  _assertOpen() {
    if (this._closed) throw domError('InvalidStateError', 'The access handle was already closed')
  }

  read(buffer, { at } = {}) {
    this._assertOpen()
    const view = toView(buffer)
    const position = at === undefined ? this._cursor : toPosition(at)

    let total = 0
    while (total < view.byteLength) {
      const n = fs.readSync(this._fd, view, total, view.byteLength - total, position + total)
      if (n === 0) break
      total += n
    }

    this._cursor = position + total
    return total
  }

  write(buffer, { at } = {}) {
    this._assertOpen()
    const view = toView(buffer)
    const position = at === undefined ? this._cursor : toPosition(at)

    let total = 0
    while (total < view.byteLength) {
      total += fs.writeSync(this._fd, view, total, view.byteLength - total, position + total)
    }

    this._cursor = position + total
    return total
  }

  truncate(newSize) {
    this._assertOpen()
    newSize = toPosition(newSize)
    fs.ftruncateSync(this._fd, newSize)
    if (this._cursor > newSize) this._cursor = newSize
  }

  getSize() {
    this._assertOpen()
    return fs.fstatSync(this._fd).size
  }

  flush() {
    this._assertOpen()
    if (this._fsync) fs.fsyncSync(this._fd)
  }

  close() {
    if (this._closed) return
    this._closed = true
    fs.closeSync(this._fd)
    locks.delete(this._path)
  }
}

// Creates a StorageManager-like object whose getDirectory() returns the OPFS
// root, backed by the `root` directory on disk.
//
// Options:
//   root  - directory on disk that acts as the OPFS root (created if missing)
//   fsync - make flush() call fsync. Off by default because it makes test runs
//           slow and the durability being tested belongs to the browser anyway.
function createStorageManager({ root, fsync = false } = {}) {
  if (!root) throw new Error('opfs-node: a root directory is required')
  const absolute = path.resolve(root)
  fs.mkdirSync(absolute, { recursive: true })
  const options = { fsync }

  return {
    async getDirectory() {
      return new FileSystemDirectoryHandle('', absolute, options)
    },
    async persist() {
      return true
    },
    async persisted() {
      return true
    },
    async estimate() {
      return { usage: 0, quota: Number.MAX_SAFE_INTEGER }
    }
  }
}

// Installs the shim as `navigator.storage`, which is where browsers expose it.
function install(options) {
  const storage = createStorageManager(options)

  if (typeof globalThis.navigator === 'undefined') {
    globalThis.navigator = {}
  }
  Object.defineProperty(globalThis.navigator, 'storage', {
    value: storage,
    configurable: true,
    enumerable: true,
    writable: true
  })

  return storage
}

// For tests: how many sync access handles are open in this thread right now.
function openHandleCount() {
  return locks.size
}

module.exports = {
  install,
  createStorageManager,
  openHandleCount,
  FileSystemDirectoryHandle,
  FileSystemFileHandle,
  FileSystemSyncAccessHandle
}
