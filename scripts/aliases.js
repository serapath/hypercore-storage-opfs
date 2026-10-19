// The module substitutions a browser build needs. This is the whole recipe
// for getting hypercore-storage (and Hypercore on top of it) into a browser:
//
//   rocksdb-native's '../binding' -> this project's index.js
//   fs                            -> browser/fs.js
//   device-file                   -> browser/device-file.js
//   test-tmp                      -> browser/test-tmp.js (tests only)
//   path                          -> path-browserify
//   Buffer, process (globals)     -> buffer, process (see browser/globals.js)
//
// Written as an esbuild plugin. The same table translates directly to
// browserify (for example with `-r`, aliasify, or a package.json "browser"
// map) or any other bundler.

const path = require('path')

const PROJECT = path.join(__dirname, '..')

function opfsAliases({ includeTestTmp = false } = {}) {
  const to = (file) => ({ path: path.join(PROJECT, file) })

  return {
    name: 'rocksdb-native-opfs',
    setup(build) {
      build.onResolve({ filter: /^\.\.?\/binding(\.js)?$/ }, (args) => {
        const fromRocksDB = args.importer.split(path.sep).includes('rocksdb-native')
        return fromRocksDB ? to('index.js') : undefined
      })
      build.onResolve({ filter: /^fs$/ }, () => to('browser/fs.js'))
      build.onResolve({ filter: /^device-file$/ }, () => to('browser/device-file.js'))
      build.onResolve({ filter: /^path$/ }, () => ({ path: require.resolve('path-browserify') }))
      if (includeTestTmp) build.onResolve({ filter: /^test-tmp$/ }, () => to('browser/test-tmp.js'))
    }
  }
}

module.exports = { opfsAliases, PROJECT }
