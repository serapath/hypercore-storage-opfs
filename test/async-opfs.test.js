// Guard the browser runtime against accidentally reintroducing synchronous OPFS I/O.
// The opfs-node test shim intentionally models synchronous handles separately.
const test = require('brittle')
const fs = require('fs')
const path = require('path')

const project = path.join(__dirname, '..')
const runtime_files = [
  'index.js',
  'lib/engine.js',
  'lib/files.js',
  'lib/log.js',
  'browser/fs.js',
  'browser/device-file.js',
  'browser-test/smoke.js'
]

test('browser runtime does not use synchronous OPFS access handles', (t) => {
  for (const name of runtime_files) {
    const source = fs.readFileSync(path.join(project, name), 'utf8')
    t.is(source.includes('createSyncAccessHandle'), false, name + ' must not use createSyncAccessHandle')
  }
})
