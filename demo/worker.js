// Runs in a dedicated Web Worker, OPFS sync access handles only exist there.
// Bundled with browserify, see "npm run demo".

// browserify gives every module its own `process` variable but doesn't put it
// on globalThis. corestore requires which-runtime, which reads
// global.process.platform (esbuild builds get this from browser/globals.js)
globalThis.process = globalThis.process || process

const reset = new URLSearchParams(self.location.search).has('reset')

main().catch((err) => send('not ok', 'crashed', String((err && err.stack) || err)))

async function main() {
  await addNoclamp()
  const Corestore = require('corestore')
  const root = await navigator.storage.getDirectory()
  if (reset) await root.removeEntry('rocksdb-native-opfs-demo', { recursive: true }).catch(() => {})

  const a = new Corestore('rocksdb-native-opfs-demo/a')
  const b = new Corestore('rocksdb-native-opfs-demo/b')
  const core = a.get({ name: 'log' })
  await core.ready()
  const copy = b.get({ key: core.key })
  await copy.ready()
  const firstVisit = core.length === 0
  send('info', `${firstVisit ? 'first visit' : 'reopened'}, core ${Buffer.from(core.key).toString('hex').slice(0, 16)}… a has ${core.length} blocks, b has ${copy.length}`)

  if (firstVisit) {
    for (let i = 0; i < 10; i++) await core.append(Buffer.from(`block-${i}`))
    check(core.length === 10, 'a appended 10 blocks')
    check(copy.length === 0, 'b has nothing before replicating')
  } else {
    check(copy.length === core.length, `b still has all ${core.length} blocks`)
    check(await readAll(copy, copy.length, false), 'b reads them from OPFS, no replication')
    await core.append(Buffer.from(`block-${core.length}`))
  }

  const want = core.length
  const s1 = a.replicate(true)
  const s2 = b.replicate(false)
  s1.pipe(s2).pipe(s1)
  s1.on('error', (err) => send('not ok', 'replication', String(err)))
  await copy.update({ wait: true })
  while (copy.length < want) await new Promise((resolve) => copy.once('append', resolve))
  check(copy.length === want, `b got ${want} blocks over replication`)
  check(await readAll(copy, want, true), `b reads all ${want} blocks with the right content`)

  s1.destroy()
  s2.destroy()
  await a.close()
  await b.close()
  send('done', firstVisit ? 'reload the page to check the data is still there' : 'reload again to add one more block')
}

// Replication needs a Noise handshake, and noise-curve-ed calls
// crypto_scalarmult_ed25519_noclamp, which sodium-javascript doesn't have.
// libsodium.js (libsodium compiled to wasm) does. Under browserify the
// sodium-universal object is not the same as require('sodium-javascript'), so
// patch the one noise-curve-ed uses.
async function addNoclamp() {
  const libsodium = require('libsodium-wrappers-sumo')
  await libsodium.ready
  const sodium = require('sodium-universal')
  sodium.crypto_scalarmult_ed25519_BYTES = libsodium.crypto_scalarmult_ed25519_BYTES
  sodium.crypto_scalarmult_ed25519_noclamp = (q, n, p) => q.set(libsodium.crypto_scalarmult_ed25519_noclamp(n, p))
}

async function readAll(core, n, wait) {
  for (let i = 0; i < n; i++) {
    const block = await core.get(i, { wait })
    if (!block || Buffer.from(block).toString() !== `block-${i}`) return false
  }
  return true
}

function check(ok, what) {
  send(ok ? 'ok' : 'not ok', what)
}

function send(type, what, error) {
  self.postMessage({ type, what, error })
}
