// Test runner. Usage: node test/run.js <suite>
//
//   unit               this project's own tests (test/*.test.js)
//   rocksdb-native     upstream rocksdb-native test.js, unchanged
//   hypercore-storage  upstream hypercore-storage tests, unchanged
//   hypercore          upstream Hypercore tests, unchanged, on this storage
//   fuzz               differential fuzzing against real (native) RocksDB
//
// Each suite runs in a worker thread (see harness/worker.js).

const { Worker } = require('worker_threads')
const fs = require('fs')
const path = require('path')
const { ROCKSDB, STORAGE, HYPERCORE } = require('./harness/aliases')

const suite = process.argv[2]

function upstreamPresent() {
  if (fs.existsSync(ROCKSDB) && fs.existsSync(STORAGE) && fs.existsSync(HYPERCORE)) return true
  console.error('Upstream test suites are missing. Run: npm run fetch-upstream')
  process.exit(1)
}

const suites = {
  unit: () => fs.readdirSync(__dirname).filter((f) => f.endsWith('.test.js')).sort().map((f) => path.join(__dirname, f)),
  'rocksdb-native': () => upstreamPresent() && [path.join(ROCKSDB, 'test.js')],
  // The same order as hypercore-storage's own test/all.js.
  'hypercore-storage': () =>
    upstreamPresent() &&
    ['atomic', 'basic', 'core', 'groups', 'snapshot', 'streams', 'tree-cache', 'migration', 'delete'].map((n) =>
      path.join(STORAGE, 'test', n + '.js')
    ),
  // The files Hypercore's own test/all.js runs (commented-out ones excluded).
  hypercore: () =>
    upstreamPresent() &&
    fs
      .readFileSync(path.join(HYPERCORE, 'test', 'all.js'), 'utf8')
      .split('\n')
      .map((line) => /^\s*await import\('\.\/(.+\.js)'\)/.exec(line))
      .filter(Boolean)
      .map((m) => path.join(HYPERCORE, 'test', m[1])),
  fuzz: () => upstreamPresent() && [path.join(__dirname, 'fuzz.js')]
}

if (!suites[suite]) {
  console.error('Usage: node test/run.js <' + Object.keys(suites).join('|') + '>')
  process.exit(1)
}

// rocksdb-native's test.js opens test/fixtures/lock relative to the working
// directory, so its tests run from its own folder.
const cwd = suite === 'rocksdb-native' ? ROCKSDB : process.cwd()
process.chdir(cwd)

const worker = new Worker(path.join(__dirname, 'harness', 'worker.js'), {
  workerData: { suite, files: suites[suite]() },
  argv: process.argv.slice(3)
})

worker.on('error', (err) => {
  console.error(err)
  process.exitCode = 1
})

worker.on('exit', (code) => {
  if (code !== 0) process.exitCode = code
})
