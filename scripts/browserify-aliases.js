// The substitutions from scripts/aliases.js as a browserify global transform:
//
//   browserify -g rocksdb-native-opfs/scripts/browserify-aliases.js worker.js
//
// `-r` or a "browser" map in your own package.json don't reach rocksdb-native's
// require('../binding'), so the transform rewrites the require calls instead.
//
// It also fills a browserify 17 gap: browserify doesn't read package.json
// "exports". hypercore-storage requires 'hyperschema/runtime', which only exists
// through hyperschema's "exports" (no "main", no runtime.js), so requires that
// browserify can't find on its own get the file Node resolves.

const fs = require('fs')
const path = require('path')
const { Transform } = require('stream')

const PROJECT = path.join(__dirname, '..')

const SWAPS = {
  fs: path.join(PROJECT, 'browser/fs.js'),
  'device-file': path.join(PROJECT, 'browser/device-file.js'),
  path: require.resolve('path-browserify')
}

module.exports = function browserifyAliases(file) {
  const fromRocksDB = file.split(path.sep).includes('rocksdb-native')
  let src = ''
  return new Transform({
    transform(chunk, enc, next) {
      src += chunk
      next()
    },
    flush(done) {
      src = src.replace(/require\((['"])([^'".][^'"]*)\1\)/g, (all, q, name) => {
        const to = SWAPS[name] || exportsTarget(name, file)
        return to ? `require(${JSON.stringify(to)})` : all
      })
      if (fromRocksDB) {
        src = src.replace(/require\((['"])\.\.?\/binding(\.js)?\1\)/g, () => `require(${JSON.stringify(path.join(PROJECT, 'index.js'))})`)
      }
      this.push(src)
      done()
    }
  })
}

// Only for packages that have "exports" and no "browser" field, and only when
// browserify can't find the file itself: a subpath, or no "main" and no index.js
function exportsTarget(name, file) {
  const parts = name.split('/')
  const scoped = name.startsWith('@')
  const pkgName = parts.slice(0, scoped ? 2 : 1).join('/')
  const pkgFile = findPackage(pkgName, path.dirname(file))
  if (!pkgFile) return null
  const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'))
  if (!pkg.exports || pkg.browser) return null
  const subpath = parts.length > (scoped ? 2 : 1)
  if (!subpath && (pkg.main || fs.existsSync(path.join(path.dirname(pkgFile), 'index.js')))) return null
  try {
    return require.resolve(name, { paths: [path.dirname(file)] })
  } catch {
    return null
  }
}

function findPackage(name, dir) {
  while (dir !== path.dirname(dir)) {
    const file = path.join(dir, 'node_modules', name, 'package.json')
    if (fs.existsSync(file)) return file
    dir = path.dirname(dir)
  }
  return null
}
