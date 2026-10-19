// Redirects module resolution so the upstream code runs on this project's
// binding, exactly as a bundler alias would in the browser build:
//
//   upstream/rocksdb-native/binding.js   -> this project's index.js
//   'rocksdb-native' from hypercore-storage -> upstream/rocksdb-native (the copy
//                                           whose binding is redirected)
//   'hypercore-storage' from hypercore   -> upstream/hypercore-storage
//   'device-file' from hypercore-storage -> browser/device-file.js
//   'brittle' from upstream test files   -> brittle with the skip list applied
//
// node_modules/rocksdb-native (the real, native one) is left alone, so the
// fuzzer can run both side by side.

const Module = require('module')
const path = require('path')

const PROJECT = path.join(__dirname, '..', '..')
const UPSTREAM = path.join(PROJECT, 'upstream')
const ROCKSDB = path.join(UPSTREAM, 'rocksdb-native')
const STORAGE = path.join(UPSTREAM, 'hypercore-storage')
const HYPERCORE = path.join(UPSTREAM, 'hypercore')

const targets = {
  binding: path.join(PROJECT, 'index.js'),
  rocksdb: path.join(ROCKSDB, 'index.js'),
  storage: path.join(STORAGE, 'index.js'),
  deviceFile: path.join(PROJECT, 'browser', 'device-file.js'),
  brittle: path.join(__dirname, 'brittle-skips.js')
}

function within(file, dir) {
  return !!file && (file === dir || file.startsWith(dir + path.sep))
}

function isUpstreamTest(file) {
  return (
    within(file, path.join(ROCKSDB, 'test.js')) ||
    within(file, path.join(STORAGE, 'test')) ||
    within(file, path.join(HYPERCORE, 'test'))
  )
}

function install() {
  const resolve = Module._resolveFilename

  Module._resolveFilename = function (request, parent, ...rest) {
    const from = parent && parent.filename
    const resolved = resolve.call(this, request, parent, ...rest)

    if (resolved === path.join(ROCKSDB, 'binding.js')) return targets.binding
    if (request === 'rocksdb-native' && (within(from, STORAGE) || within(from, HYPERCORE))) return targets.rocksdb
    if (request === 'hypercore-storage' && within(from, HYPERCORE)) return targets.storage
    if (request === 'device-file' && within(from, STORAGE)) return targets.deviceFile
    if (request === 'brittle' && isUpstreamTest(from)) return targets.brittle

    return resolved
  }
}

module.exports = { install, PROJECT, UPSTREAM, ROCKSDB, STORAGE, HYPERCORE }
