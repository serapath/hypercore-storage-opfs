// Browser stand-in for Node's `fs`, for the browser build of hypercore-storage.
//
// hypercore-storage touches the real filesystem in a few places that matter
// only for stores created by older versions or for Node-specific recovery.
// For a store that lives in OPFS there is nothing on a "real" filesystem, so
// this stub behaves like an empty one: reads report "not found", listings are
// empty. Anything that would write throws a clear error, so unexpected use is
// visible instead of silently ignored.

function notFound(path) {
  const err = new Error(`ENOENT: no such file or directory, '${path}'`)
  err.code = 'ENOENT'
  err.errno = -2
  return err
}

function unsupported(name) {
  const err = new Error(`fs.${name} is not available in the browser build`)
  err.code = 'ENOSYS'
  return err
}

function callbackOf(args) {
  return typeof args[args.length - 1] === 'function' ? args[args.length - 1] : null
}

function failLater(args, err) {
  const cb = callbackOf(args)
  if (cb) queueMicrotask(() => cb(err))
}

module.exports = {
  existsSync: () => false,
  readdirSync: () => [],
  statSync: (path) => {
    throw notFound(path)
  },
  readFileSync: (path) => {
    throw notFound(path)
  },
  mkdirSync: () => {
    throw unsupported('mkdirSync')
  },
  renameSync: () => {
    throw unsupported('renameSync')
  },
  writeFileSync: () => {
    throw unsupported('writeFileSync')
  },
  unlinkSync: () => {
    throw unsupported('unlinkSync')
  },
  openSync: (path) => {
    throw notFound(path)
  },
  open: (path, ...args) => failLater(args, notFound(path)),
  read: (...args) => failLater(args, unsupported('read')),
  close: (...args) => {
    const cb = callbackOf(args)
    if (cb) queueMicrotask(() => cb(null))
  },
  createReadStream: () => {
    throw unsupported('createReadStream')
  },
  promises: {
    stat: async (path) => {
      throw notFound(path)
    },
    readdir: async (path) => {
      throw notFound(path)
    },
    readFile: async (path) => {
      throw notFound(path)
    },
    unlink: async (path) => {
      throw notFound(path)
    },
    mkdir: async () => {
      throw unsupported('promises.mkdir')
    },
    rm: async () => {}
  }
}
