// Runs inside a worker thread, because the OPFS shim (like browsers) only
// allows sync access handles off the main thread.
//
// Sets up an OPFS root in a temporary directory, installs the module aliases,
// then loads the test files, which brittle runs.

const { workerData } = require('worker_threads')
const fs = require('fs')
const os = require('os')
const path = require('path')
const opfs = require('../../opfs-node')
const aliases = require('./aliases')

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opfs-root-'))
opfs.install({ root })
globalThis.OPFS_TEST_ROOT = root // for tests that start their own workers
process.on('exit', () => fs.rmSync(root, { recursive: true, force: true }))

aliases.install()

for (const file of workerData.files) require(file)
