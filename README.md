# rocksdb-native-opfs

rocksdb-native's native binding, reimplemented in plain, commented JavaScript on top of the browser's Origin Private File System (OPFS). Swapped in with a bundler alias, it lets current hypercore-storage, and so current Hypercore, run in browsers. Nothing upstream is edited.

rocksdb-native is two layers: a JavaScript layer (sessions, batches, iterators, snapshots, suspend/resume) and a native binding of 29 functions underneath. This project replaces only the binding, so rocksdb-native's own JavaScript, hypercore-storage and Hypercore all run unchanged on top.

Status: a working first version, tested in Node against a strict OPFS shim. **It has not yet been run in a real browser** (none was available where it was built). See "Running the browser smoke test".

## Results

All suites run unchanged from upstream, at pinned versions, in Node `worker_threads` against the strict OPFS shim.

| Suite | Result |
| --- | --- |
| rocksdb-native 3.19.1 `test.js` | 78 pass, 6 skipped (reasons below) |
| hypercore-storage 3.4.0 `test/` | 78 pass, 1 skipped by upstream itself (macOS-only fixture) |
| Hypercore 11.39.0 `test/` | 423 pass, 9 skipped (8 by Hypercore itself, 1 here: see "Known limits") |
| Differential fuzzing against native RocksDB | 2,000 sequences of 150 ops and 100 of 1,500 ops: no differences |
| This project's own tests | 33 pass: tree, log format, shim strictness, crash recovery, locking, compaction |
| Browser bundle, run in a browser-like Node worker | 6 pass, 1 skipped (replication: see "Known limits") |

Skipped rocksdb-native tests, with the full reasons in `test/skip-list.js`:

- **4 fd-lock tests.** They hand RocksDB an OS file descriptor and check it gets closed. Browsers have no file descriptors; the store takes its own lock instead.
- **2 manual-compaction tests.** They inspect RocksDB's LSM layout (SST files per level), or expect a key-count estimate that includes an old version kept for a snapshot. There are no levels here, and the count is exact.

## How it works

```
Hypercore, Corestore                     unchanged
hypercore-storage                        unchanged
rocksdb-native (JavaScript layer)        unchanged
index.js        the 29 binding functions          ← new
lib/engine.js   recovery, batches, views, compaction, suspend/resume, locking
lib/log.js      checksummed log records
lib/tree.js     copy-on-write sorted tree (in memory)
lib/files.js    shared OPFS file handles
OPFS (browser) or opfs-node/ (Node, for tests)
```

- **Writes.** Each write batch is appended to a log file as one record with a length and a CRC-32. On open, the log is replayed; a record that was only partly written fails its checksum and is discarded with everything after it. So every batch is all-or-nothing, and the store reopens exactly as it was after the last complete batch.
- **Index.** In memory, each column family is a persistent (copy-on-write) AVL tree mapping keys to where their values sit in the log. Values stay on disk and are read on demand.
- **Snapshots and iterators.** A snapshot or iterator keeps the tree roots it started with, plus a reference on the log files they point into. Trees are never modified in place, so a view never changes.
- **Compaction.** Compaction writes every live entry into a new "base" log file, marks the end with a `BASE_END` record, and switches to it. Old files are deleted once no view needs them. A base without `BASE_END` (an interrupted compaction) is ignored on open.
- **Locking.** A writer holds an exclusive OPFS handle on the store's `LOCK` file, so a second writer (another tab, say) gets a clear error. Read-only opens take no lock.
- **Suspend/resume.** `suspend()` releases every OPFS handle. `resume()` refuses if another writer opened the store meanwhile, detected through a random `SESSION_ID`, as librocksdb does.

`BINDING.md` documents exactly what each of the 29 functions does.

## Using it in a browser build (e.g. `datweb`)

**1. Run the storage stack in a dedicated Web Worker.** OPFS's synchronous file handles only exist there.

**2. Apply these bundler substitutions.** `scripts/aliases.js` has them as an esbuild plugin. for browserify theres `scripts/browserify-aliases.js`, a global transform (`browserify -g rocksdb-native-opfs/scripts/browserify-aliases.js worker.js`). `-r` or a "browser" map dont work here btw, they never reach rocksdb-native's own `require('../binding')`. the transform also handles package.json "exports" subpaths, browserify 17 cant find those on its own (hypercore-storage needs `hyperschema/runtime`).

| Module | Replace with |
| --- | --- |
| rocksdb-native's `../binding` (from `rocksdb-native/lib/*.js`) | `rocksdb-native-opfs` (this package's `index.js`) |
| `fs` | `rocksdb-native-opfs/browser/fs.js` |
| `device-file` | `rocksdb-native-opfs/browser/device-file.js` |
| `path` | `path-browserify` |
| `Buffer`, `process` globals | `buffer`, `process` (see `browser/globals.js`, it also puts `process` on globalThis cuz corestore's which-runtime reads `global.process`. browserify only gives each module a local `process`, so with browserify do `globalThis.process = process` at the top of the worker) |

**3. Add the browser packages any Holepunch browser build needs anyway:** `events`, `buffer`, `process`, `path-browserify`, and `sodium-javascript` (sodium-universal maps to it in browsers but doesn't install it).

**4. Consider asking for persistent storage** (`navigator.storage.persist()`). Otherwise the browser may evict OPFS data under storage pressure.

Store paths are ordinary path strings, interpreted as directories under the OPFS root (`'datweb/corestore'` and so on).

## Demo

`npm run demo` serves `demo/` with budo. two corestores on opfs in a worker, `a` makes a core and `b` replicates it. reload the page (or restart the browser) and both still have the data, then one more block gets replicated. `?reset` starts over. replication needs `crypto_scalarmult_ed25519_noclamp` which sodium-javascript doesnt have, so the demo adds it from `libsodium-wrappers-sumo` for now

## Running the tests

```sh
npm install
npm run fetch-upstream      # clones the pinned upstream suites into ./upstream
npm test                    # everything below, in order

npm run test:unit           # this project's own tests
npm run test:rocksdb        # rocksdb-native's test.js, unchanged
npm run test:storage        # hypercore-storage's tests, unchanged
npm run test:hypercore      # Hypercore's tests, unchanged (about 3 minutes)
npm run test:fuzz           # differential fuzzing (default 300 sequences)
npm run test:bundle         # builds the browser bundle and runs it in a browser-like worker
```

The fuzzer takes `--seeds N`, `--ops N` and `--seed N` (to reproduce one failure): `node test/run.js fuzz --seeds 2000`. On a difference it prints the shortest sequence of operations that still shows it.

Every suite runs in a `worker_threads` worker because the OPFS shim, like browsers, refuses synchronous file handles on the main thread. `test/harness/aliases.js` redirects module resolution the same way a bundler alias would. Skips live in one file, `test/skip-list.js`, each with its reason; upstream test files are never edited.

### Running the browser smoke test

```sh
npm run build:browser-test
npx http-server browser-test     # or: python3 -m http.server -d browser-test
```

Open the printed `http://localhost` address (OPFS needs a secure context, which localhost is) in Chrome, Firefox and Safari. The page runs `browser-test/smoke.js` in a dedicated worker. It covers OPFS access, reads and writes, snapshots, compaction, suspend/resume, the writer lock, and Hypercore append/read/reopen, and shows each result.

## Known limits

- **Every key is held in memory.** Measured with Hypercore, this costs about 1 KB per block retained (native RocksDB: about 15 bytes), and several times that at peak during one very large append. Hypercore's test that appends a million blocks in one batch needs more memory than the 4 GB machine this was built on, so it is skipped. Small and medium cores are fine; very large ones need the planned fix, a persisted on-disk index.
- **Opening replays the log.** Startup time grows with the log size since the last compaction.
- **Compaction is synchronous and rewrites the whole store.** It blocks the worker while it copies, and the range arguments of `compactRange` are ignored.
- **Read-only opens across tabs.** A read-only reader in the *same* worker as the writer shares its file handles and works, and is tested. In another tab or worker it can't open files the writer holds, because OPFS locks them exclusively.
- **Durability.** Writes are flushed once per tick. A crashed tab or browser loses at most the batches since the last flush and never leaves a half-applied batch. Real power-loss behaviour depends on the browser's `flush()`, which can't be tested from here.
- **Hypercore replication in browsers is blocked by crypto, not storage.** `sodium-javascript` 0.8.0, the latest on npm and what browsers get, lacks `crypto_scalarmult_ed25519_noclamp`. `noise-curve-ed` 2.1.0 needs it for Hypercore's Noise handshake, so the handshake fails. Replication works over this storage in Node. The smoke test detects the missing function and reports replication as skipped, with that reason.
- **The shim only models what it knows.** Locks are per Node thread (OPFS's are origin-wide); quota and eviction aren't modelled; `getFile()` while a handle is open is refused, to be safe. The real-browser run is the check on all of this.

## Audit guide

Most of the risk sits in a few places. In suggested reading order:

1. **`lib/log.js`.** The record format, CRC-32, and `readRecord`, which decides what counts as a valid record. This is what makes a batch all-or-nothing.
2. **`lib/engine.js`, recovery (`_recover`, `_replayFile`).** Finding the newest complete base, point-in-time replay, and what gets deleted.
3. **`lib/tree.js`.** Copy-on-write correctness. A node changed in place after creation would silently break snapshots. Every node is built in `makeNode`, and nothing assigns to a node's fields after that.
4. **`lib/engine.js`, compaction (`_compact`, `_writeBase`, `_unref`).** The switch-over is synchronous, so no write can interleave. Files are deleted only when their last reference goes; this is where the fuzzer found a real bug, since fixed.
5. **`index.js` against `BINDING.md`.** Callback ordering (always a later task) and error paths.
6. **`opfs-node/index.js`.** Any rule it relaxes compared with real OPFS is a bug the Node tests can't see.
7. **`test/skip-list.js`.** Every skipped upstream test and its reason.

## Layout

```
index.js                 the binding (29 functions)
lib/                     engine, log format, tree, file sharing
opfs-node/               strict OPFS shim for Node
browser/                 stand-ins for the browser build (fs, device-file, test-tmp, globals)
scripts/                 fetch-upstream, bundler aliases (esbuild, browserify), browser test build
demo/                    corestore replication + reload demo (budo)
browser-test/            smoke test page and worker script
test/                    own tests, fuzzer, harness, skip list
BINDING.md               the binding contract
```

Licence: Apache-2.0, matching the upstream projects.
