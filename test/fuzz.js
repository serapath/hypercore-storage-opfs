// Differential fuzzing: runs the same random sequence of operations against
// real RocksDB (the native rocksdb-native package) and against this project
// (rocksdb-native's own JavaScript layer on the OPFS binding), and compares
// every result. Any difference fails the test and is shrunk to the shortest
// sequence that still shows it, ready to paste into a regression test.
//
// Operations: multi-op write batches (put, delete, range delete) in two column
// families, point reads, iterators with every combination of bounds, reverse
// and limit, snapshots read long after later writes, reopening, compaction,
// and suspend/resume.
//
// Compaction thresholds are set very low so the engine compacts constantly,
// including while snapshots and iterators are open.
//
// Options (after `node test/run.js fuzz`):
//   --seeds N    number of random sequences (default 300)
//   --ops N      operations per sequence (default 150)
//   --seed N     run only this seed (to reproduce a failure)

const test = require('brittle')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { PROJECT, ROCKSDB } = require('./harness/aliases')

const Native = require(path.join(PROJECT, 'node_modules', 'rocksdb-native'))
const Opfs = require(ROCKSDB) // its binding.js is redirected to this project
const binding = require(path.join(PROJECT, 'index.js'))

binding.configure({ autoCompactMinBytes: 2048, autoCompactRatio: 1.5, baseChunkBytes: 256 })

const args = parseArgs(process.argv.slice(2))
const SEEDS = args.seeds || 300
const OPS = args.ops || 150
const CFS = ['default', 'b']

// --- Random generation ----------------------------------------------------------

function mulberry32(seed) {
  return function () {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function generate(seed, count) {
  const rand = mulberry32(seed)
  const int = (n) => Math.floor(rand() * n)
  const pick = (list) => list[int(list.length)]

  // Short keys over a small alphabet, so operations collide often.
  const key = () => {
    const length = int(4)
    let s = ''
    for (let i = 0; i < length; i++) s += pick(['a', 'b', 'c'])
    return s
  }
  const value = () => {
    const length = rand() < 0.05 ? 500 + int(1500) : int(12)
    const bytes = []
    for (let i = 0; i < length; i++) bytes.push(int(256))
    return bytes
  }
  const ordered = () => {
    const a = key()
    const b = key()
    return a <= b ? [a, b] : [b, a]
  }
  const bound = () => (rand() < 0.5 ? null : key())

  const ops = []
  let nextSnapshot = 0
  const snapshots = []

  for (let i = 0; i < count; i++) {
    const r = rand()
    const cf = pick(CFS)
    const snapshot = snapshots.length > 0 && rand() < 0.3 ? pick(snapshots) : null

    if (r < 0.4) {
      const writes = []
      const n = 1 + int(4)
      for (let j = 0; j < n; j++) {
        const w = rand()
        if (w < 0.6) writes.push(['put', key(), value()])
        else if (w < 0.85) writes.push(['del', key()])
        else writes.push(['range', ...ordered()])
      }
      ops.push({ op: 'batch', cf, writes })
    } else if (r < 0.6) {
      const keys = []
      const n = 1 + int(3)
      for (let j = 0; j < n; j++) keys.push(key())
      ops.push({ op: 'get', cf, keys, snapshot })
    } else if (r < 0.8) {
      const range = { gt: bound(), gte: bound(), lt: bound(), lte: bound() }
      const limit = rand() < 0.3 ? int(4) : -1
      ops.push({ op: 'iter', cf, range, reverse: rand() < 0.5, limit, snapshot })
    } else if (r < 0.88) {
      const id = nextSnapshot++
      snapshots.push(id)
      ops.push({ op: 'snapshot', id })
    } else if (r < 0.92 && snapshots.length > 0) {
      const id = snapshots.splice(int(snapshots.length), 1)[0]
      ops.push({ op: 'release', id })
    } else if (r < 0.95) {
      ops.push({ op: 'compact' })
    } else if (r < 0.98) {
      ops.push({ op: 'reopen' })
      snapshots.length = 0
    } else {
      ops.push({ op: 'suspendResume' })
    }
  }

  return ops
}

// --- Running a sequence against one implementation -------------------------------

class Runner {
  constructor(RocksDB, dir) {
    this.RocksDB = RocksDB
    this.dir = dir
    this.db = null
    this.snapshots = new Map()
  }

  async open() {
    this.db = new this.RocksDB(this.dir, { columnFamilies: ['b'] })
    await this.db.ready()
  }

  session(cf, snapshotId) {
    let base = this.db
    if (snapshotId !== null && snapshotId !== undefined) {
      base = this.snapshots.get(snapshotId)
      if (base === undefined) return null // snapshot gone (sequence was shrunk)
    }
    return cf === 'default' ? base : base.columnFamily(cf)
  }

  async closeSnapshots() {
    for (const s of this.snapshots.values()) await s.close()
    this.snapshots.clear()
  }

  // Runs one op and returns a plain, comparable result.
  async run(op) {
    switch (op.op) {
      case 'batch': {
        const session = this.session(op.cf, null)
        const batch = session.write()
        for (const w of op.writes) {
          if (w[0] === 'put') batch.tryPut(Buffer.from(w[1]), Buffer.from(w[2]))
          else if (w[0] === 'del') batch.tryDelete(Buffer.from(w[1]))
          else batch.tryDeleteRange(Buffer.from(w[1]), Buffer.from(w[2]))
        }
        const result = await settle(batch.flush())
        batch.destroy()
        if (session !== this.db) await session.close()
        return result.ok ? 'ok' : 'error'
      }
      case 'get': {
        const session = this.session(op.cf, op.snapshot)
        if (session === null) return 'skipped'
        const batch = session.read()
        const promises = op.keys.map((k) => batch.get(Buffer.from(k)))
        await batch.flush()
        batch.destroy()
        const values = []
        for (const p of promises) values.push(show(await p))
        if (session !== this.db && !this.isSnapshotRoot(session)) await session.close()
        return values
      }
      case 'iter': {
        const session = this.session(op.cf, op.snapshot)
        if (session === null) return 'skipped'
        const range = {}
        for (const k of ['gt', 'gte', 'lt', 'lte']) if (op.range[k] !== null) range[k] = Buffer.from(op.range[k])
        const entries = []
        for await (const { key, value } of session.iterator(range, { reverse: op.reverse, limit: op.limit })) {
          entries.push(show(key) + '=' + show(value))
        }
        if (session !== this.db && !this.isSnapshotRoot(session)) await session.close()
        return entries
      }
      case 'snapshot':
        this.snapshots.set(op.id, this.db.snapshot())
        return 'ok'
      case 'release': {
        const s = this.snapshots.get(op.id)
        if (s === undefined) return 'skipped'
        this.snapshots.delete(op.id)
        await s.close()
        return 'ok'
      }
      case 'compact':
        await this.db.compactRange()
        return 'ok'
      case 'reopen':
        await this.closeSnapshots()
        await this.db.close()
        await this.open()
        return 'ok'
      case 'suspendResume':
        await this.db.suspend()
        await this.db.resume()
        return 'ok'
    }
    throw new Error('Unknown op ' + op.op)
  }

  isSnapshotRoot(session) {
    for (const s of this.snapshots.values()) if (s === session) return true
    return false
  }

  async close() {
    if (this.db === null) return
    await this.closeSnapshots()
    await this.db.close()
    this.db = null
  }
}

function show(buf) {
  return buf === null ? 'null' : Buffer.from(buf).toString('hex')
}

async function settle(promise) {
  try {
    return { ok: true, value: await promise }
  } catch (err) {
    return { ok: false, error: err }
  }
}

// An op's result as a string. If it throws, only the fact that it threw is
// compared: the two implementations word their errors differently.
async function outcome(runner, op) {
  try {
    return JSON.stringify(await runner.run(op))
  } catch (err) {
    return 'threw (' + err.message + ')'
  }
}

let counter = 0

// Runs `ops` on both implementations. Returns null if they agree, otherwise
// { index, op, native, opfs }.
async function compare(ops) {
  const id = `${process.pid}-${counter++}`
  const nativeDir = fs.mkdtempSync(path.join(os.tmpdir(), `fuzz-native-${id}-`))
  const native = new Runner(Native, nativeDir)
  const opfs = new Runner(Opfs, `/fuzz/${id}`)

  try {
    await native.open()
    await opfs.open()

    for (let i = 0; i < ops.length; i++) {
      const a = await outcome(native, ops[i])
      const b = await outcome(opfs, ops[i])
      const bothThrew = a.startsWith('threw') && b.startsWith('threw')
      if (a !== b && !bothThrew) return { index: i, op: ops[i], native: a, opfs: b }
    }

    return null
  } finally {
    await native.close().catch(() => {})
    await opfs.close().catch(() => {})
    fs.rmSync(nativeDir, { recursive: true, force: true })
  }
}

// Shrinks a failing sequence by removing ever smaller chunks while it still
// fails. Ops that refer to a removed snapshot are skipped at run time.
async function shrink(ops) {
  let current = ops.slice(0, (await compare(ops)).index + 1)
  let chunk = Math.max(1, Math.floor(current.length / 2))

  while (chunk >= 1) {
    let removed = false
    for (let start = 0; start < current.length; ) {
      const candidate = current.slice(0, start).concat(current.slice(start + chunk))
      const failure = candidate.length > 0 ? await compare(candidate) : null
      if (failure !== null) {
        current = candidate.slice(0, failure.index + 1)
        removed = true
      } else {
        start += chunk
      }
    }
    if (!removed) chunk = Math.floor(chunk / 2)
  }

  return current
}

// --- Tests ------------------------------------------------------------------------

const seeds = args.seed !== undefined ? [args.seed] : Array.from({ length: SEEDS }, (_, i) => i + 1)
const GROUP = 25

for (let g = 0; g < seeds.length; g += GROUP) {
  const group = seeds.slice(g, g + GROUP)

  test(`differential fuzz, seeds ${group[0]}-${group[group.length - 1]} (${OPS} ops each)`, { timeout: 0 }, async (t) => {
    for (const seed of group) {
      const ops = generate(seed, OPS)
      const failure = await compare(ops)

      if (failure !== null) {
        const minimal = await shrink(ops)
        const last = await compare(minimal)
        t.fail(
          `seed ${seed}: results differ at op ${failure.index} (${failure.op.op}).\n` +
            `  native: ${clip(failure.native)}\n  opfs:   ${clip(failure.opfs)}\n` +
            `  shortest failing sequence (${minimal.length} ops):\n` +
            minimal.map((op) => '    ' + JSON.stringify(op)).join('\n') +
            `\n  native: ${clip(last && last.native)}\n  opfs:   ${clip(last && last.opfs)}`
        )
        return
      }
    }
    t.pass(`${group.length} sequences agree`)
  })
}

function clip(s, max = 400) {
  s = String(s)
  return s.length <= max ? s : s.slice(0, max) + `... (${s.length} chars)`
}

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const m = /^--(seeds|ops|seed)$/.exec(argv[i])
    if (m) out[m[1]] = parseInt(argv[++i], 10)
  }
  return out
}

