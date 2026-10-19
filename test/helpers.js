// Shared helpers for this project's own tests. Everything here goes through
// the OPFS API (navigator.storage), never Node's fs, so the tests can also run
// in a browser.

const path = require('path')
const { ROCKSDB, PROJECT } = require('./harness/aliases')

// rocksdb-native's JavaScript layer, running on this project's binding.
const RocksDB = require(ROCKSDB)
const binding = require(path.join(PROJECT, 'index.js'))

let counter = 0

function storePath(name = 'store') {
  return `/project-tests/${name}-${Date.now().toString(36)}-${counter++}`
}

async function dirOf(storePath) {
  let dir = await navigator.storage.getDirectory()
  for (const segment of storePath.split('/').filter(Boolean)) {
    dir = await dir.getDirectoryHandle(segment)
  }
  return dir
}

async function listFiles(storePath) {
  const names = []
  for await (const [name] of (await dirOf(storePath)).entries()) names.push(name)
  return names.sort()
}

async function logFiles(storePath) {
  return (await listFiles(storePath)).filter((n) => n.endsWith('.log'))
}

// Opens a file in the store with an exclusive sync access handle, runs fn,
// closes it. The store must be closed (OPFS allows one handle per file).
async function withFile(storePath, name, fn) {
  const fileHandle = await (await dirOf(storePath)).getFileHandle(name)
  const handle = await fileHandle.createSyncAccessHandle()
  try {
    return await fn(handle)
  } finally {
    handle.close()
  }
}

async function readAll(storePath, name) {
  return withFile(storePath, name, (h) => {
    const bytes = new Uint8Array(h.getSize())
    h.read(bytes, { at: 0 })
    return bytes
  })
}

async function writeAll(storePath, name, bytes, { create = false } = {}) {
  const fileHandle = await (await dirOf(storePath)).getFileHandle(name, { create })
  const handle = await fileHandle.createSyncAccessHandle()
  try {
    handle.truncate(0)
    handle.write(bytes, { at: 0 })
    handle.flush()
  } finally {
    handle.close()
  }
}

async function entries(db, range = {}) {
  const out = []
  for await (const { key, value } of db.iterator(range)) out.push([key.toString(), value.toString()])
  return out
}

module.exports = { RocksDB, binding, storePath, dirOf, listFiles, logFiles, withFile, readAll, writeAll, entries }
