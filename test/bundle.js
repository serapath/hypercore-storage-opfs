// Runs the browser bundle (browser-test/smoke.bundle.js) in a Node worker,
// against the strict OPFS shim, with browser-like globals: no setImmediate
// (so callbacks take the MessageChannel path browsers use) and no `require`
// in scope. The global Buffer stays, because Node's own internals need it;
// the bundle doesn't, as it brings its own (see browser/globals.js). If anything in the bundle still
// needed Node's fs, native modules or Node-only globals, this would fail.
//
// Usage: npm run test:bundle  (builds the bundle first)

const { Worker, isMainThread, parentPort } = require('worker_threads')
const fs = require('fs')
const os = require('os')
const path = require('path')
const vm = require('vm')

const BUNDLE = path.join(__dirname, '..', 'browser-test', 'smoke.bundle.js')

if (isMainThread) {
  if (!fs.existsSync(BUNDLE)) {
    console.error('Bundle missing. Run: npm run build:browser-test')
    process.exit(1)
  }

  // A quick look at what went into the bundle.
  const source = fs.readFileSync(BUNDLE, 'utf8')
  for (const forbidden of ['require-addon', 'sodium-native/binding', 'rocksdb-native/binding.js']) {
    if (source.includes(forbidden)) {
      console.error(`not ok - bundle contains ${forbidden}`)
      process.exitCode = 1
    }
  }

  const worker = new Worker(__filename)
  let failed = null
  worker.on('message', (m) => {
    if (m.type === 'result') {
      if (m.skipped) console.log(`ok - ${m.name} # SKIP ${m.reason}`)
      else console.log(`${m.ok ? 'ok' : 'not ok'} - ${m.name} (${m.ms} ms)${m.error ? '\n  ' + m.error.split('\n').join('\n  ') : ''}`)
    }
    if (m.type === 'done') {
      failed = m.failed
      console.log(`# ${m.passed} passed, ${m.failed} failed, ${m.skipped || 0} skipped${m.error ? '\n' + m.error : ''}`)
      // The browser scheduler's MessageChannel keeps a Node worker alive, so stop it.
      worker.terminate()
    }
  })
  worker.on('error', (err) => {
    console.error(err)
    process.exitCode = 1
  })
  worker.on('exit', () => {
    if (failed !== 0) process.exitCode = 1
  })
} else {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opfs-bundle-'))
  require('../opfs-node').install({ root })
  process.on('exit', () => fs.rmSync(root, { recursive: true, force: true }))

  // Browser workers don't have these.
  delete globalThis.setImmediate
  delete globalThis.clearImmediate

  globalThis.__smokeReport = (message) => parentPort.postMessage(message)

  // runInThisContext, not require(): no `require`, `module` or `exports` in scope.
  vm.runInThisContext(fs.readFileSync(BUNDLE, 'utf8'), { filename: BUNDLE })
}
