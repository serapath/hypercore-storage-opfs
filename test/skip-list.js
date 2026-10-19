// Upstream tests that are skipped, and why. This is the only place a skip can
// be added; the upstream test files themselves are never edited.
//
// Keys are exact test names from the upstream files.

const FD_LOCK =
  'Passes rocksdb-native an OS file descriptor (from fd-lock) and checks the binding closes it. ' +
  'Browsers have no file descriptors; the store takes its own exclusive lock on a LOCK file instead, ' +
  "covered by 'suspend + open new writer' and this project's own lock tests."

const LSM_FILES =
  "Counts RocksDB's SST files per LSM level ('rocksdb.num-files-at-level0') before and after range " +
  'compactions. There are no SST files or levels here: compaction always rewrites the whole store into one base log.'

const ESTIMATE_WITH_SNAPSHOT =
  "Expects RocksDB's key-count estimate to include an old version kept alive for a snapshot during " +
  'compaction (3 instead of 2). This implementation reports the exact number of live keys, so it sees 2. ' +
  'Its second assertion (2 after a forced compaction) passes.'

module.exports = {
  'rocksdb-native': {
    'manual compaction, buffer keys': LSM_FILES,
    'manual compaction, buffer keys with options': ESTIMATE_WITH_SNAPSHOT,
    'fd lock': FD_LOCK,
    'fd lock + suspend + resume': FD_LOCK,
    'fd lock + suspend + close': FD_LOCK,
    'fd lock + suspend + open new writer, attempt to overwrite': FD_LOCK
  },
  'hypercore-storage': {},
  hypercore: {
    'one missing block, big core (slow)':
      'Appends 1,000,000 blocks in one batch. This implementation keeps every key in memory: measured at about ' +
      '1 KB retained per block (native RocksDB: about 15 bytes), with several times that at peak during one huge ' +
      'batch, so this test needs more memory than the 4 GB machine it was developed on. A persisted index would ' +
      'remove the limit; see README.md, "Known limits".'
  }
}
