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

// Read and replace test files through the async OPFS API. Tests can corrupt
// records without relying on the sync access handle API that the engine avoids.
async function readAll(storePath, name) {
  const fileHandle = await (await dirOf(storePath)).getFileHandle(name)
  const file = await fileHandle.getFile()
  return new Uint8Array(await file.arrayBuffer())
}

async function writeAll(storePath, name, bytes, { create = false } = {}) {
  const fileHandle = await (await dirOf(storePath)).getFileHandle(name, { create })
  const writer = await fileHandle.createWritable()
  try {
    await writer.write(bytes)
    await writer.close()
  } catch (err) {
    try { await writer.abort() } catch {}
    throw err
  }
}

async function entries(db, range = {}) {
  const out = []
  for await (const { key, value } of db.iterator(range)) out.push([key.toString(), value.toString()])
  return out
}

module.exports = { RocksDB, binding, storePath, dirOf, listFiles, logFiles, readAll, writeAll, entries }
