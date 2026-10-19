// Fetches the upstream test suites this project is checked against, at the
// exact versions it targets, into ./upstream. The test files are used as
// published; nothing in them is edited.
//
//   upstream/rocksdb-native     its JavaScript layer + test.js (84 tests)
//   upstream/hypercore-storage  its source + test/ (79 tests)
//   upstream/hypercore          its source + test/ (integration: Hypercore on this storage)

const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const UPSTREAM = [
  { name: 'rocksdb-native', repo: 'https://github.com/holepunchto/rocksdb-native.git', tag: 'v3.19.1' },
  { name: 'hypercore-storage', repo: 'https://github.com/holepunchto/hypercore-storage.git', tag: 'v3.4.0' },
  { name: 'hypercore', repo: 'https://github.com/holepunchto/hypercore.git', tag: 'v11.39.0' }
]

const root = path.join(__dirname, '..', 'upstream')
fs.mkdirSync(root, { recursive: true })

for (const { name, repo, tag } of UPSTREAM) {
  const dir = path.join(root, name)
  if (fs.existsSync(dir)) {
    console.log(`${name}: already present (delete upstream/${name} to refetch)`)
    continue
  }
  console.log(`${name}: cloning ${tag}`)
  execFileSync('git', ['-c', 'advice.detachedHead=false', 'clone', '--quiet', '--depth', '1', '--branch', tag, repo, dir], { stdio: 'inherit' })
}
