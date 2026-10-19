// Helper for the "terminated mid-write" test: a worker that writes numbered
// batches as fast as it can until it is killed. Batch i sets 'n' to i and
// adds the key 'k<i>', so a reader can check that what survived is exactly a
// prefix of the batches.

const { workerData, parentPort } = require('worker_threads')
const opfs = require('../opfs-node')
const aliases = require('./harness/aliases')

opfs.install({ root: workerData.root })
aliases.install()

const RocksDB = require(aliases.ROCKSDB)

;(async () => {
  const db = new RocksDB(workerData.path)
  await db.ready()
  for (let i = 0; ; i++) {
    const batch = db.write()
    batch.tryPut('n', String(i))
    batch.tryPut('k' + String(i).padStart(8, '0'), Buffer.alloc(200, i % 256))
    await batch.flush()
    batch.destroy()
    if (i === 10) parentPort.postMessage('writing')
  }
})()
