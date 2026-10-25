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
//   - Quota/eviction and origin-wide Web Locks across independent Node workers.
//   - move() is not implemented. The project engine intentionally uses
//     createWritable() and getFile(), both modelled below.

const fs = require('fs')
const path = require('path')
const { isMainThread } = require('worker_threads')

// The test shim also models sync handles for API-specific tests, but the
// rocksdb-native-opfs engine must not call createSyncAccessHandle().
// File locks are per Node thread; real OPFS/Web Locks coordinate by origin.
const locks = new Map() // absolute file path -> open FileSystemSyncAccessHandle
const writers = new Map() // absolute file path -> open FileSystemWritableFileStream

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
  for (const p of writers.keys()) {
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

    if (locks.has(p) || writers.has(p)) {
      throw domError('NoModificationAllowedError', 'The file is locked by an open access handle or writable stream.')
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
    // createWritable() edits a staging file and publishes it only on close, so
    // getFile() can safely snapshot the currently committed target while a
    // writable stream is open. Sync access handles are exclusive and block it.
    if (locks.has(this._path)) {
      throw domError('NoModificationAllowedError', 'opfs-node refuses getFile() while a sync access handle is open.')
    }
    if (!statOrNull(this._path)) {
      throw domError('NotFoundError', 'A requested file or directory could not be found.')
    }
    return new File([await fs.promises.readFile(this._path)], this.name)
  }

  async createWritable({ keepExistingData = false } = {}) {
    if (locks.has(this._path) || writers.has(this._path)) {
      throw domError('NoModificationAllowedError', 'A file access handle or writable stream is already open.')
    }
    if (!statOrNull(this._path)) {
      throw domError('NotFoundError', 'A requested file or directory could not be found.')
    }

    const tempPath = this._path + '.opfs-tmp-' + Math.random().toString(16).slice(2)
    if (keepExistingData) await fs.promises.copyFile(this._path, tempPath)
    const fd = await fs.promises.open(tempPath, keepExistingData ? 'r+' : 'w+')
    const stream = new FileSystemWritableFileStream(this._path, tempPath, fd, this._options)
    writers.set(this._path, stream)
    return stream
  }

  async createSyncAccessHandle() {
    // Browsers only expose this method in dedicated workers. On the main thread
    // the method simply isn't there, which surfaces as a TypeError.
    if (isMainThread) {
      throw new TypeError('createSyncAccessHandle is not a function (only available in dedicated workers)')
    }
    if (locks.has(this._path) || writers.has(this._path)) {
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

class FileSystemWritableFileStream {
  constructor(targetPath, tempPath, fileHandle, options) {
    this._targetPath = targetPath
    this._tempPath = tempPath
    this._fd = fileHandle
    this._options = options
    this._position = 0
    this._closed = false
  }

  _assertOpen() {
    if (this._closed) throw domError('InvalidStateError', 'The writable stream is closed.')
  }

  async write(chunk) {
    this._assertOpen()

    if (chunk && typeof chunk === 'object' && chunk.type === 'seek') {
      this._position = toPosition(chunk.position)
      return
    }
    if (chunk && typeof chunk === 'object' && chunk.type === 'truncate') {
      return this.truncate(chunk.size)
    }

    let data = chunk
    if (chunk && typeof chunk === 'object' && chunk.type === 'write') {
      data = chunk.data
      if (chunk.position !== undefined) this._position = toPosition(chunk.position)
    }

    let view
    if (typeof data === 'string') view = Buffer.from(data)
    else if (data instanceof Blob) view = Buffer.from(await data.arrayBuffer())
    else view = toView(data)

    let total = 0
    while (total < view.byteLength) {
      const result = await this._fd.write(view, total, view.byteLength - total, this._position + total)
      if (result.bytesWritten <= 0) throw new Error('Short write to OPFS shim file')
      total += result.bytesWritten
    }
    this._position += total
  }

  async seek(position) {
    this._assertOpen()
    this._position = toPosition(position)
  }

  async truncate(size) {
    this._assertOpen()
    size = toPosition(size)
    await this._fd.truncate(size)
    if (this._position > size) this._position = size
  }

  async close() {
    if (this._closed) return
    this._closed = true
    try {
      if (this._options.fsync) await this._fd.sync()
      await this._fd.close()
      await fs.promises.rename(this._tempPath, this._targetPath)
    } catch (err) {
      try { await this._fd.close() } catch {}
      try { await fs.promises.unlink(this._tempPath) } catch {}
      throw err
    } finally {
      writers.delete(this._targetPath)
    }
  }

  async abort() {
    if (this._closed) return
    this._closed = true
    try {
      await this._fd.close()
    } finally {
      writers.delete(this._targetPath)
      try { await fs.promises.unlink(this._tempPath) } catch {}
    }
  }
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

// Minimal Web Locks API model for Node tests. It handles same-thread shared
// and exclusive locks; the real browser is responsible for cross-tab/worker
// arbitration during the browser tests.
class LockManager {
  constructor() {
    this._states = new Map()
  }

  request(name, options, callback) {
    if (typeof options === 'function') {
      callback = options
      options = {}
    }
    options = options || {}

    const state = this._states.get(name) || { active: [], queue: [] }
    this._states.set(name, state)
    const mode = options.mode || 'exclusive'
    const canGrantNow = () => {
      if (state.queue.length > 0) return false
      if (state.active.some((entry) => entry.mode === 'exclusive')) return false
      return mode === 'shared' || state.active.length === 0
    }

    if (options.ifAvailable && !canGrantNow()) {
      return Promise.resolve().then(() => callback(null))
    }

    return new Promise((resolve, reject) => {
      state.queue.push({ mode, callback, resolve, reject })
      this._drain(name, state)
    })
  }

  _drain(name, state) {
    if (state.active.some((entry) => entry.mode === 'exclusive')) return
    if (state.queue.length === 0) return

    if (state.active.length > 0 && state.queue[0].mode !== 'shared') return

    do {
      const entry = state.queue.shift()
      state.active.push(entry)
      const lock = { name, mode: entry.mode }
      Promise.resolve().then(() => entry.callback(lock)).then(entry.resolve, entry.reject).finally(() => {
        const index = state.active.indexOf(entry)
        if (index !== -1) state.active.splice(index, 1)
        if (state.active.length === 0 && state.queue.length === 0) this._states.delete(name)
        else this._drain(name, state)
      })
      if (entry.mode === 'exclusive') return
    } while (state.queue.length > 0 && state.queue[0].mode === 'shared')
  }
}

// Creates a StorageManager-like object whose getDirectory() returns the OPFS
// root, backed by the `root` directory on disk.
//
// Options:
//   root  - directory on disk that acts as the OPFS root (created if missing)
//   fsync - when enabled, sync writable test streams before close. Off by default
//           because it makes test runs slow; browser durability needs real-browser tests.
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
  if (!globalThis.navigator.locks) {
    Object.defineProperty(globalThis.navigator, 'locks', {
      value: new LockManager(),
      configurable: true,
      enumerable: true,
      writable: true
    })
  }

  return storage
}

// For tests: how many sync handles and async writable streams are open right now.
function openHandleCount() {
  return locks.size + writers.size
}

module.exports = {
  install,
  createStorageManager,
  openHandleCount,
  FileSystemDirectoryHandle,
  FileSystemFileHandle,
  FileSystemSyncAccessHandle,
  FileSystemWritableFileStream,
  LockManager
}
