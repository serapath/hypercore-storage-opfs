# The binding contract

rocksdb-native (3.19.1) is a JavaScript layer (`index.js`, `lib/`) on top of a native binding (`binding.js`, implemented in `binding.cc` over [librocksdb](https://github.com/holepunchto/librocksdb)). This document describes the 29 functions that binding exports, as this project implements them. It was written from `binding.cc`, librocksdb's `src/rocksdb.cc`, and how rocksdb-native's JavaScript layer calls each function.

## General rules

**Handles.** `init`, `columnFamilyInit`, `readInit`, `writeInit`, `iteratorInit` and `snapshotCreate` return handles. In the native binding these are ArrayBuffers wrapping C structs; here they are plain objects. The JavaScript layer never looks inside them; it only stores them and passes them back.

**Callbacks.** Asynchronous functions take a context and one or more callbacks. A callback is always called with the context as `this`, and always on a later task, never synchronously and never as a microtask. The native binding behaves this way, and callers depend on it: Hypercore's replication tests stall if callbacks arrive as microtasks. Here a later task means `setImmediate` where it exists, otherwise a `MessageChannel` message.

**Errors.** Errors are `Error` objects with a `code`. Where callers or tests match on the message, the message is RocksDB's own:

| Situation | Message | Code |
| --- | --- | --- |
| Writing to a read-only database | `Not supported operation in read only mode.` | `ENOTSUP` |
| Range delete with start after end | `end key comes before start key` | `EINVAL` |
| Resuming after another writer opened the store | `Session ID does not match` | `EINVAL` |
| `approximateSize` with both include flags false | `Invalid options` | `EINVAL` |
| `walFilterPrefixes` without `readOnly` | `wal_filter_prefixes requires read_only` | `EINVAL` |
| Any call on a closed or suspended database | `RocksDB session is closed` | `EINVAL` |
| Opening a store whose lock is held | `lock <path>/LOCK: already held by another open database` | `EBUSY` |

**Byte strings.** Keys, values and bounds arrive as Buffers (or other Uint8Arrays). Keys are copied before they are kept, because callers' buffers may be views into larger reusable memory. Values and keys handed back are ArrayBuffers, which the JavaScript layer wraps with `Buffer.from`.

## Database

### `init(readOnly, createIfMissing, createMissingColumnFamilies, maxBackgroundJobs, bytesPerSync, maxOpenFiles, useDirectReads, avoidUnnecessaryBlockingIO, skipStatsUpdateOnOpen, useDirectIOForFlushAndCompaction, maxFileOpeningThreads, walRecoveryMode, bestEffortsRecovery, enableStatistics, statsLevel, walTtlSeconds, walSizeLimitMegabytes, avoidFlushDuringShutdown, walFilterPrefixes) → db`

Synchronous. Records the options; opens nothing. Used: `readOnly`, `createIfMissing`, `createMissingColumnFamilies`, `enableStatistics`, `statsLevel`, `walFilterPrefixes`. The rest tune RocksDB internals with no counterpart here and are accepted and ignored. Recovery always behaves like RocksDB's default `POINT_IN_TIME` mode.

### `open(db, ctx, path, columnFamilies, lock, req, onopen)`

Opens or creates the store at `path` (a path under the OPFS root; `/` and `\` separate directories). `columnFamilies` is an array of column family handles; each one gets its id. Missing families are created when `createMissingColumnFamilies` is set and the database is writable, otherwise opening fails with `Column family not found: <name>`. The `default` family always exists.

A writable open takes the store's lock (an exclusive OPFS handle on its `LOCK` file), recovers the log files (see `lib/engine.js`), and writes a fresh random id to `SESSION_ID`. A read-only open takes no lock and changes nothing on disk.

`lock` is a file descriptor from fd-lock or device-file in Node, or `-1`. Browsers have no file descriptors, so it is ignored; the store's own lock does that job.

Calls `onopen.call(ctx, err | null)`.

### `close(db, req, onclose)`

Releases any snapshots still open, flushes, closes every OPFS handle and releases the lock. Calls `onclose.call(req)`. Never fails.

### `suspend(db, req, onsuspend)` / `resume(db, req, onresume)`

`suspend` flushes, then closes every OPFS handle and releases the lock, keeping everything in memory, so another tab or worker can open the store meanwhile. `resume` takes the lock and handles back. For a writable store it first checks `SESSION_ID`: if another writer has opened the store in the meantime, the in-memory index no longer matches the files, and resume fails with `Session ID does not match` (librocksdb does the same). A failed resume leaves the store suspended. Both call back with `(err | null)` and `req` as `this`.

### `flushWal(db, req, onflushwal)` / `flush(db, columnFamily, req, onflush)`

Flush the log file to disk. There is no memtable, so `flush` is the same as `flushWal`. Call back with `(err | null)`.

## Column families

### `columnFamilyInit(name, ...tuning) → columnFamily`

Synchronous. The arguments after `name` are RocksDB table and blob tuning options, accepted and ignored. Returns `{ name, id: -1 }`; `open` sets `id`. A column family created after `open` was never given to `open` and is refused when used.

### `columnFamilyDestroy(columnFamily)`

Releases the handle. Does not drop the family's data.

## Reads

### `readInit() → batch`, `readBuffer(batch, capacity) → ArrayBuffer`

The native binding hands out buffers for zero-copy transfer; the JavaScript layer only stores them. Here they are empty.

### `read(db, batch, ops, snapshot, asyncIO, fillCache, ctx, onread)`

`ops` is an array of `{ type: GET, key, columnFamily }`. Each key is looked up in `snapshot` if given (a snapshot handle), otherwise in the current state, at the time of the call. Calls `onread.call(ctx, errors, values)` with two arrays the length of `ops`: `errors[i]` is `null` or an Error, and `values[i]` is an ArrayBuffer (empty values are zero-length ArrayBuffers) or `null` when the key is absent. `asyncIO` and `fillCache` are ignored.

## Writes

### `writeInit() → batch`, `writeBuffer(batch, capacity) → ArrayBuffer`

As for reads.

### `write(db, batch, ops, ctx, onwrite)`

`ops` is an array of `{ type: PUT, key, value, columnFamily }`, `{ type: DELETE, key, columnFamily }` and `{ type: DELETE_RANGE, start, end, columnFamily }`. The batch is applied atomically: encoded as one checksummed log record, appended, then applied in memory. Either the whole batch is visible afterwards, or (on error) none of it. A range delete removes keys `k` with `start <= k < end`; `start == end` is a no-op and `start > end` fails the batch. Calls `onwrite.call(ctx, err | null)`.

Writes are flushed to disk once per tick rather than once per batch, so a burst of batches costs one flush. `flushWal` forces a flush.

### Constants

`GET = 1`, `PUT = 1`, `DELETE = 2`, `DELETE_RANGE = 3`: the same values as the native binding, which numbers read and write ops separately.

## Iterators

### `iteratorInit() → iterator`, `iteratorBuffer(iterator, capacity) → ArrayBuffer`

As for reads.

### `iteratorOpen(db, iterator, columnFamily, gt, gte, lt, lte, reverse, keysOnly, snapshot, ctx, onopen, onclose, onread)`

Opens the iterator on a frozen view of the data: `snapshot` if given, otherwise the current state at this moment. Later writes are never seen. Stores `ctx` and the three callbacks for later calls, then calls `onopen.call(ctx, err | null)`.

Bounds follow librocksdb exactly. An empty bound means no bound. The iterator is positioned on `gte` if set, otherwise on the first key after `gt` if set, otherwise on the first key (reverse: `lte`, otherwise the last key before `lt`, otherwise the last key). It then returns entries while every non-empty bound holds, and stops at the first entry that fails one. That last rule means, for example, that `{ gte: 'b', gt: 'c' }` returns nothing.

### `iteratorRead(iterator, count)`

Returns up to `count` entries through `onread.call(ctx, err | null, keys, values)`, as arrays of ArrayBuffers. `values` is empty for a keys-only iterator. Fewer than requested means the end.

### `iteratorClose(iterator)`

Releases the view, then calls `onclose.call(ctx, null)`.

## Snapshots

### `snapshotCreate(db) → snapshot`

Synchronous. Freezes the current state: a copy of each column family's tree root, and a reference on every log file those roots point into, so compaction can't delete them. Costs a few small allocations, whatever the size of the store.

### `snapshotDestroy(snapshot)`

Releases the references. A log file that compaction replaced is deleted once the last snapshot or iterator using it is released.

## Maintenance and introspection

### `compact(db, columnFamily, exclusive, blobGcPolicy, blobGcAgeCutoff, bottommostLevelCompaction, req, oncompact)`, `compactRange(db, columnFamily, start, end, ...same, req, oncompactrange)`

Rewrite every live entry, in every column family, into a fresh base log file, then switch to it. The range and tuning arguments are ignored: compaction always covers the whole store. Read-only databases fail with `Not supported operation in read only mode.` Call back with `(err | null)`.

Compaction also runs automatically once the log files hold at least 64 MB and at least twice the live data (configurable; see `configure` below).

### `approximateSize(db, columnFamily, start, end, includeMemtables, includeFiles, filesSizeErrorMargin, req, onapproximatesize)`

Calls back with `(err | null, bytes)`: the total size of keys plus values in `[start, end)`, exact rather than approximate. Empty `start` or `end` means unbounded. There is no memtable/file split, so either include flag counts everything; both false fails with `Invalid options`.

### `currentWalFile(db, req, oncurrentwalfile)`

Calls back with `(err | null, path, number, type, startSequence, size)` for the log file receiving appends. `type` is always 1 (alive).

### `statsLevelGet(db) → level`, `statsLevelSet(db, level)`

Synchronous. Throw unless the database was opened with `enableStatistics`. The level is stored and reported but changes nothing.

### `propertyGet(db, columnFamily, name) → string | undefined`

Synchronous. Supported names: `rocksdb.estimate-num-keys` (exact key count), `rocksdb.estimate-live-data-size`, `rocksdb.total-sst-files-size` and `rocksdb.live-sst-files-size` (bytes of keys plus values in the family), and `rocksdb.options-statistics` (only with `enableStatistics`; RocksDB's text format with this engine's counters, and block-cache counters that are always zero). Anything else returns `undefined`, as RocksDB does for unknown properties.

## Not part of the native binding

### `configure({ autoCompactMinBytes, autoCompactRatio, baseChunkBytes })`

Tuning for this implementation: when automatic compaction starts (defaults: 64 MB of log, 2× the live data), and the record size compaction writes (1 MB). Mainly for tests.
