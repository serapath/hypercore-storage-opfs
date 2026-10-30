// Runs in a SharedWorker: one corestore on OPFS for every tab and iframe of
// this origin, like one process owning the store on the command line. Only
// works with the asynchronous OPFS engine, a SharedWorker has no
// createSyncAccessHandle. Loaded by demo/worker.js when it runs as a SharedWorker.
const Corestore = require('corestore')

const reset = new URLSearchParams(self.location.search).has('reset')
const state = { ports: [] }
const ready = open_store()

ready.catch(on_crash)
self.onconnect = on_connect

function on_connect (event) {
  const port = event.ports[0]
  state.ports.push(port)
  port.onmessage = msg => on_message(port, msg.data)
}

async function open_store () {
  const root = await navigator.storage.getDirectory()
  if (reset) await root.removeEntry('rocksdb-native-opfs-shared', { recursive: true }).catch(() => {})
  const store = new Corestore('rocksdb-native-opfs-shared/store')
  const core = store.get({ name: 'log' })
  await core.ready()
  return core
}

// a tab or iframe asks for something and only that port gets the answer,
// except new blocks, which every connected port hears about
async function on_message (port, { type, id, data }) {
  try {
    const core = await ready
    if (type === 'hello') return port.postMessage({ type: 'hello', id, key: Buffer.from(core.key).toString('hex'), length: core.length, ports: state.ports.length })
    if (type === 'append') {
      const { length } = await core.append(Buffer.from(data))
      port.postMessage({ type: 'appended', id, index: length - 1 })
      return broadcast({ type: 'block', index: length - 1, data })
    }
    if (type === 'get') {
      const block = await core.get(data, { wait: false })
      return port.postMessage({ type: 'got', id, index: data, data: block && Buffer.from(block).toString() })
    }
  } catch (err) {
    port.postMessage({ type: 'error', id, error: String((err && err.stack) || err) })
  }
}

function on_crash (err) { broadcast({ type: 'not ok', what: 'crashed', error: String((err && err.stack) || err) }) }

function broadcast (msg) {
  for (const port of state.ports) port.postMessage(msg)
}
