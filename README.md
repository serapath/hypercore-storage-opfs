# rocksdb-native-opfs

rocksdb-native's native binding, reimplemented in plain, commented JavaScript on top of the browser's Origin Private File System (OPFS). Swapped in with a bundler alias, it lets current hypercore-storage, and so current Hypercore, run in browsers. Nothing upstream is edited.

rocksdb-native is two layers: a JavaScript layer (sessions, batches, iterators, snapshots, suspend/resume) and a native binding of 29 functions underneath. This project replaces only the binding, so rocksdb-native's own JavaScript, hypercore-storage and Hypercore all run unchanged on top.

Status: asynchronous OPFS implementation in progress. The runtime storage code uses `FileSystemWritableFileStream`, `FileSystemFileHandle.getFile()` and `Blob.arrayBuffer()`; it does not call `createSyncAccessHandle()`. The updated code and tests still need to be run against the full upstream suites and in real browsers before production use.

## Verification status

This async-only refactor is not yet production-validated. The uploaded baseline had prior test results for a synchronous implementation; those results do **not** apply to the current code.

- Syntax checks have been run on the modified engine, binding, async OPFS shim and updated browser smoke test.
- A standalone Node smoke test passed through the OPFS shim, covering reads/writes, snapshots and iterators, compaction/reopen, torn and corrupt tails, interrupted compaction, read-only file leases, a reader racing an in-flight commit, suspended-reader invalidation, and injected writable-close failure. The test harness was external to this repository, so this result is not a replacement for the committed test suites.
- The full unit, upstream integration and differential-fuzz suites still need to be run against this refactor. Dependency installation did not complete in the editing environment.
- The browser smoke test has been updated to exercise asynchronous OPFS, but it still needs to run in real Chrome, Firefox and Safari.

The upstream test skip list remains relevant to the original binding compatibility strategy, but no pass counts are claimed for this async refactor until the suites have actually been re-run.

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

- **Writes.** Each write batch is stored in a new immutable delta file as one checksummed record. A write is published to the in-memory index only after the asynchronous writable stream closes successfully. On open, complete batches are replayed; a torn or invalid tail is ignored. Browser stream close is the implementation's commit boundary, not a guarantee of survival under every possible hardware power-loss scenario.
- **Index.** In memory, each column family is a persistent (copy-on-write) AVL tree mapping keys to where their values sit in the log. Values stay on disk and are read on demand.
- **Snapshots and iterators.** A snapshot or iterator keeps the tree roots it started with, plus a reference on the log files they point into. Trees are never modified in place, so a view never changes.
- **Compaction.** Compaction asynchronously writes every live entry into a new "base" log file, marks the end with `BASE_END`, closes the stream, then switches to it. Old files are retired only after no view or in-flight read needs them. A base without `BASE_END` (an interrupted compaction) is ignored on open.
- **Locking.** A writable store holds an exclusive origin-scoped Web Lock for its lifetime, so another writer for the same origin/path is refused. Read-only opens don't take the writer lock, but hold shared Web Lock leases on the log files their views depend on. Compaction deletes an old file only if it can obtain the matching exclusive file lock; otherwise cleanup is deferred until a later writable open.
- **Suspend/resume.** `suspend()` releases every OPFS handle. `resume()` refuses if another writer opened the store meanwhile, detected through a random `SESSION_ID`, as librocksdb does.

`BINDING.md` documents exactly what each of the 29 functions does.

## Using it in a browser build (e.g. `datweb`)

**1. Run the storage stack in a Web Worker.** This keeps indexing and compaction off the UI thread. The engine itself uses asynchronous OPFS APIs and does not require `FileSystemSyncAccessHandle`.

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

The unit and integration suites run in a `worker_threads` worker to isolate global state and model browser contexts. The engine's file I/O is asynchronous; `opfs-node` retains sync-handle emulation only for its own strict API tests, not for the database engine. `test/harness/aliases.js` redirects module resolution the same way a bundler alias would. Skips live in one file, `test/skip-list.js`, each with its reason; upstream test files are never edited.

### Running the browser smoke test

```sh
npm run build:browser-test
npx http-server browser-test     # or: python3 -m http.server -d browser-test
```

Open the printed `http://localhost` address (OPFS needs a secure context, which localhost is) in Chrome, Firefox and Safari. The page runs `browser-test/smoke.js` in a worker. It checks asynchronous OPFS write/close/read, snapshots, read-only readers across compaction, damaged-tail recovery, suspend/resume, the writer lock, and Hypercore append/read/reopen, and shows each result.

## Known limits

- **Every key is held in memory.** The index grows with the number of keys; a persisted on-disk index would be needed for very large stores.
- **Opening replays the log.** Startup time grows with the log size since the last compaction.
- **Compaction rewrites the whole store.** File I/O yields asynchronously, but compaction builds the key/value tree and base in one serialized mutation and can still consume substantial CPU and memory. The range arguments of `compactRange` are ignored.
- **Read-only opens across tabs.** Read-only opens use immutable `File` snapshots and shared per-log Web Lock leases. They can coexist with a writer, while preventing that writer from deleting log files that the reader might still need. This concurrency path must still be validated in real browsers.
- **Durability.** The engine awaits `FileSystemWritableFileStream.close()` before acknowledging a batch. Recovery discards incomplete records and uses immutable log/base files. Browser APIs do not provide a universal guarantee that every acknowledged write survives sudden power loss, so durability claims require testing across real browsers and operating systems.
- **Hypercore replication requires compatible browser crypto.** The smoke test checks the required crypto function and reports replication as skipped if it is unavailable; this is separate from the storage engine. Verify this against the dependency versions actually bundled in your application.
- **The shim only models what it knows.** Browser quota and eviction aren't modelled, and Node's Web Lock simulation does not coordinate independent Node workers exactly as a browser coordinates same-origin contexts. Real-browser runs remain required.

## Audit guide

Most of the risk sits in a few places. In suggested reading order:

1. **`lib/log.js`.** The record format, CRC-32, and `readRecord`, which decides what counts as a valid record. This is what makes a batch all-or-nothing.
2. **`lib/engine.js`, recovery (`_recover`, `_replayFile`).** Finding the newest complete base, point-in-time replay, and what gets deleted.
3. **`lib/tree.js`.** Copy-on-write correctness. A node changed in place after creation would silently break snapshots. Every node is built in `makeNode`, and nothing assigns to a node's fields after that.
4. **`lib/engine.js`, compaction (`_compact`, `_writeBase`, `_unref`).** Compaction and writes share a serialized mutation queue, so no later mutation can interleave while the base is being committed. Files are retired only after their last in-engine reference goes, and cross-context Web Lock leases prevent deletion while a read-only view may still depend on them.
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
