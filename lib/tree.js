// A persistent (copy-on-write) sorted map from byte-string keys to value
// locations, used as the in-memory index of each column family.
//
// "Persistent" means nodes are never changed after they are created. Every
// update builds a few new nodes along one path and reuses everything else, and
// returns a new root. Old roots stay valid and unchanged, which is what makes
// snapshots and iterators cheap and safe: a snapshot is just an old root.
//
// The tree is an AVL tree built from two primitives, `join` and `split`
// (following Blelloch, Ferizovic and Sun, "Just Join for Parallel Ordered
// Sets", 2016). Insert, delete and range delete are all expressed with them,
// which keeps the rebalancing logic in one place (`join`).
//
// Each node also records the number of entries (`size`) and the total bytes of
// keys plus values (`bytes`) in its subtree, so counting keys and estimating
// the size of a key range never have to walk the whole tree.
//
// Values are value locations: objects with at least a `length` property
// (see engine.js). The tree never looks inside them except to read `length`.
//
// An empty tree is `null`.

const EMPTY = null

// Bytewise comparison, the same ordering as RocksDB's default comparator.
function compare(a, b) {
  const n = Math.min(a.byteLength, b.byteLength)
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1
  }
  return a.byteLength === b.byteLength ? 0 : a.byteLength < b.byteLength ? -1 : 1
}

function height(node) {
  return node === null ? 0 : node.height
}

function size(node) {
  return node === null ? 0 : node.size
}

function bytes(node) {
  return node === null ? 0 : node.bytes
}

// The only place nodes are created. Derived fields are computed here so they
// can never get out of step with the children.
function makeNode(left, key, value, right) {
  return {
    left,
    key,
    value,
    right,
    height: Math.max(height(left), height(right)) + 1,
    size: size(left) + size(right) + 1,
    bytes: bytes(left) + bytes(right) + key.byteLength + value.length
  }
}

function rotateLeft(node) {
  const r = node.right
  return makeNode(makeNode(node.left, node.key, node.value, r.left), r.key, r.value, r.right)
}

function rotateRight(node) {
  const l = node.left
  return makeNode(l.left, l.key, l.value, makeNode(l.right, node.key, node.value, node.right))
}

// joinRight / joinLeft: attach a much shorter tree on one side, walking down
// the taller tree's spine until heights are close, then rebalancing on the
// way back up. These are the only functions that rebalance.
function joinRight(left, key, value, right) {
  const l = left.left
  const c = left.right

  if (height(c) <= height(right) + 1) {
    const t = makeNode(c, key, value, right)
    if (height(t) <= height(l) + 1) return makeNode(l, left.key, left.value, t)
    return rotateLeft(makeNode(l, left.key, left.value, rotateRight(t)))
  }

  const t = joinRight(c, key, value, right)
  const result = makeNode(l, left.key, left.value, t)
  if (height(t) <= height(l) + 1) return result
  return rotateLeft(result)
}

function joinLeft(left, key, value, right) {
  const c = right.left
  const r = right.right

  if (height(c) <= height(left) + 1) {
    const t = makeNode(left, key, value, c)
    if (height(t) <= height(r) + 1) return makeNode(t, right.key, right.value, r)
    return rotateRight(makeNode(rotateLeft(t), right.key, right.value, r))
  }

  const t = joinLeft(left, key, value, c)
  const result = makeNode(t, right.key, right.value, r)
  if (height(t) <= height(r) + 1) return result
  return rotateRight(result)
}

// Joins two trees and a middle entry, where every key in `left` < key < every
// key in `right`. Returns a balanced tree.
function join(left, key, value, right) {
  if (height(left) > height(right) + 1) return joinRight(left, key, value, right)
  if (height(right) > height(left) + 1) return joinLeft(left, key, value, right)
  return makeNode(left, key, value, right)
}

// Removes the largest entry. Returns { tree, key, value }.
function splitLast(node) {
  if (node.right === null) return { tree: node.left, key: node.key, value: node.value }
  const last = splitLast(node.right)
  return { tree: join(node.left, node.key, node.value, last.tree), key: last.key, value: last.value }
}

// Joins two trees where every key in `left` < every key in `right`.
function join2(left, right) {
  if (left === null) return right
  const last = splitLast(left)
  return join(last.tree, last.key, last.value, right)
}

// Splits a tree around `key`. Returns { left, match, right } where `left` holds
// keys < key, `right` holds keys > key, and `match` is the node with exactly
// `key` (or null). Only `match.key` and `match.value` should be used.
function split(node, key) {
  if (node === null) return { left: null, match: null, right: null }

  const cmp = compare(key, node.key)
  if (cmp === 0) return { left: node.left, match: node, right: node.right }

  if (cmp < 0) {
    const s = split(node.left, key)
    return { left: s.left, match: s.match, right: join(s.right, node.key, node.value, node.right) }
  }

  const s = split(node.right, key)
  return { left: join(node.left, node.key, node.value, s.left), match: s.match, right: s.right }
}

// --- Public operations -------------------------------------------------------

function get(node, key) {
  while (node !== null) {
    const cmp = compare(key, node.key)
    if (cmp === 0) return node.value
    node = cmp < 0 ? node.left : node.right
  }
  return undefined
}

// Inserts or replaces. Returns the new root.
function set(node, key, value) {
  const s = split(node, key)
  return join(s.left, key, value, s.right)
}

// Returns the new root (the same root if the key was absent).
function remove(node, key) {
  const s = split(node, key)
  if (s.match === null) return node
  return join2(s.left, s.right)
}

// Removes every key k with start <= k < end (RocksDB DeleteRange semantics).
// Callers must ensure start <= end.
function removeRange(node, start, end) {
  if (node === null || compare(start, end) >= 0) return node

  const below = split(node, start).left // keys < start
  const fromEnd = split(node, end) // keys > end, plus `end` itself if present

  let above = fromEnd.right
  if (fromEnd.match !== null) above = join(null, fromEnd.match.key, fromEnd.match.value, above)

  return join2(below, above)
}

// Total bytes of entries with key < `key`. Walks one path; no allocation.
function bytesBelow(node, key) {
  let total = 0
  while (node !== null) {
    if (compare(node.key, key) < 0) {
      total += bytes(node.left) + node.key.byteLength + node.value.length
      node = node.right
    } else {
      node = node.left
    }
  }
  return total
}

// Total bytes of entries with start <= key < end. A null bound is open.
function bytesInRange(node, start, end) {
  const upper = end === null ? bytes(node) : bytesBelow(node, end)
  const lower = start === null ? 0 : bytesBelow(node, start)
  return Math.max(0, upper - lower)
}

// Builds a balanced tree from entries already sorted by key, in O(n).
// `entries` is an array of { key, value }.
function fromSorted(entries, lo = 0, hi = entries.length) {
  if (lo >= hi) return null
  const mid = (lo + hi) >>> 1
  return makeNode(
    fromSorted(entries, lo, mid),
    entries[mid].key,
    entries[mid].value,
    fromSorted(entries, mid + 1, hi)
  )
}

// Calls fn(key, value) for every entry in key order.
function forEach(node, fn) {
  const stack = []
  while (stack.length > 0 || node !== null) {
    if (node !== null) {
      stack.push(node)
      node = node.left
    } else {
      node = stack.pop()
      fn(node.key, node.value)
      node = node.right
    }
  }
}

// --- Cursors -----------------------------------------------------------------
//
// A cursor walks a fixed root in key order (or reverse order). Because roots
// never change, a cursor keeps seeing exactly the entries that existed when it
// was positioned, however many writes happen meanwhile.
//
// The stack holds the nodes still to visit on the way back up: for a forward
// cursor, nodes whose key is >= the current position; for reverse, <=.

class Cursor {
  constructor(root, reverse) {
    this.root = root
    this.reverse = reverse
    this.stack = []
  }

  // Forward: position on the first key. Reverse: on the last key.
  seekToEdge() {
    this.stack = []
    let node = this.root
    while (node !== null) {
      this.stack.push(node)
      node = this.reverse ? node.right : node.left
    }
  }

  // Forward cursors only: position on the first key >= key (or > key when
  // `exclusive`).
  seekForward(key, exclusive) {
    this.stack = []
    let node = this.root
    while (node !== null) {
      const cmp = compare(node.key, key)
      if (cmp > 0 || (cmp === 0 && !exclusive)) {
        this.stack.push(node)
        node = node.left
      } else {
        node = node.right
      }
    }
  }

  // Reverse cursors only: position on the last key <= key (or < key when
  // `exclusive`).
  seekBackward(key, exclusive) {
    this.stack = []
    let node = this.root
    while (node !== null) {
      const cmp = compare(node.key, key)
      if (cmp < 0 || (cmp === 0 && !exclusive)) {
        this.stack.push(node)
        node = node.right
      } else {
        node = node.left
      }
    }
  }

  // The entry the cursor is on, without moving. Null at the end.
  peek() {
    return this.stack.length === 0 ? null : this.stack[this.stack.length - 1]
  }

  // Returns the current node and moves on. Null at the end.
  next() {
    if (this.stack.length === 0) return null
    const node = this.stack.pop()
    let child = this.reverse ? node.left : node.right
    while (child !== null) {
      this.stack.push(child)
      child = this.reverse ? child.right : child.left
    }
    return node
  }
}

module.exports = {
  EMPTY,
  compare,
  get,
  set,
  remove,
  removeRange,
  size,
  bytes,
  bytesInRange,
  fromSorted,
  forEach,
  height,
  Cursor
}
