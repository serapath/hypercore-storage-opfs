const test = require('brittle')
const tree = require('../lib/tree')

const enc = (s) => Buffer.from(s)

// Checks AVL balance, ordering and the derived size/bytes fields everywhere.
function invariants(node) {
  if (node === null) return { height: 0, size: 0, bytes: 0 }
  const l = invariants(node.left)
  const r = invariants(node.right)
  if (Math.abs(l.height - r.height) > 1) throw new Error('unbalanced')
  if (node.height !== Math.max(l.height, r.height) + 1) throw new Error('wrong height')
  if (node.left && tree.compare(node.left.key, node.key) >= 0) throw new Error('out of order (left)')
  if (node.right && tree.compare(node.right.key, node.key) <= 0) throw new Error('out of order (right)')
  const size = l.size + r.size + 1
  const bytes = l.bytes + r.bytes + node.key.byteLength + node.value.length
  if (node.size !== size || node.bytes !== bytes) throw new Error('wrong size/bytes')
  return { height: node.height, size, bytes }
}

function contents(root) {
  const out = []
  tree.forEach(root, (k, v) => out.push([k.toString(), v.length]))
  return out
}

function modelContents(model) {
  return [...model.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([k, v]) => [k, v.length])
}

test('compare is bytewise, shorter prefix first', (t) => {
  t.is(tree.compare(enc('a'), enc('b')), -1)
  t.is(tree.compare(enc('b'), enc('a')), 1)
  t.is(tree.compare(enc('a'), enc('a')), 0)
  t.is(tree.compare(enc('a'), enc('ab')), -1)
  t.is(tree.compare(enc(''), enc('a')), -1)
  t.is(tree.compare(Buffer.from([0xff]), Buffer.from([0x01, 0x02])), 1)
})

test('random operations match a Map model; old roots never change', (t) => {
  let seed = 7
  const rnd = (n) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed % n
  }
  const key = () => enc('abcdef'[rnd(6)] + (rnd(3) ? 'abcdef'[rnd(6)] : ''))

  for (let round = 0; round < 100; round++) {
    let root = tree.EMPTY
    const model = new Map()
    const snapshots = []

    for (let i = 0; i < 200; i++) {
      const op = rnd(10)
      if (op < 6) {
        const k = key()
        const v = { length: rnd(5) }
        root = tree.set(root, k, v)
        model.set(k.toString(), v)
      } else if (op < 8) {
        const k = key()
        root = tree.remove(root, k)
        model.delete(k.toString())
      } else if (op < 9) {
        let a = key()
        let b = key()
        if (tree.compare(a, b) > 0) [a, b] = [b, a]
        root = tree.removeRange(root, a, b)
        for (const k of [...model.keys()]) if (k >= a.toString() && k < b.toString()) model.delete(k)
      } else {
        snapshots.push({ root, expected: modelContents(model) })
      }

      invariants(root)
      if (JSON.stringify(contents(root)) !== JSON.stringify(modelContents(model))) {
        t.fail(`contents differ in round ${round} at step ${i}`)
        return
      }

      const lo = key()
      const hi = key()
      const expectedBytes = [...model.entries()]
        .filter(([k]) => k >= lo.toString() && k < hi.toString())
        .reduce((sum, [k, v]) => sum + Buffer.byteLength(k) + v.length, 0)
      if (tree.bytesInRange(root, lo, hi) !== expectedBytes) {
        t.fail(`bytesInRange differs in round ${round} at step ${i}`)
        return
      }
    }

    for (const s of snapshots) {
      if (JSON.stringify(contents(s.root)) !== JSON.stringify(s.expected)) {
        t.fail('an old root changed')
        return
      }
    }
  }

  t.pass('20,000 operations, invariants hold, snapshots unchanged')
})

test('cursors: forward/backward seeks, inclusive and exclusive', (t) => {
  let root = tree.EMPTY
  for (const k of ['b', 'd', 'f', 'h']) root = tree.set(root, enc(k), { length: 0 })

  const walk = (reverse, seek) => {
    const c = new tree.Cursor(root, reverse)
    seek(c)
    const out = []
    let n
    while ((n = c.next()) !== null) out.push(n.key.toString())
    return out
  }

  t.alike(walk(false, (c) => c.seekToEdge()), ['b', 'd', 'f', 'h'])
  t.alike(walk(true, (c) => c.seekToEdge()), ['h', 'f', 'd', 'b'])
  t.alike(walk(false, (c) => c.seekForward(enc('d'), false)), ['d', 'f', 'h'])
  t.alike(walk(false, (c) => c.seekForward(enc('d'), true)), ['f', 'h'])
  t.alike(walk(false, (c) => c.seekForward(enc('e'), false)), ['f', 'h'])
  t.alike(walk(true, (c) => c.seekBackward(enc('f'), false)), ['f', 'd', 'b'])
  t.alike(walk(true, (c) => c.seekBackward(enc('f'), true)), ['d', 'b'])
  t.alike(walk(true, (c) => c.seekBackward(enc('a'), false)), [])
})

test('fromSorted builds a balanced tree', (t) => {
  const sorted = Array.from({ length: 1000 }, (_, i) => ({ key: enc(String(i).padStart(4, '0')), value: { length: 1 } }))
  const root = tree.fromSorted(sorted)
  invariants(root)
  t.is(tree.size(root), 1000)
  t.ok(tree.height(root) <= 11)
})
