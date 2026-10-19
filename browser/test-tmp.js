// Browser stand-in for `test-tmp` (also what brittle's t.tmp() uses).
// Creates a fresh, uniquely named directory under /tmp in OPFS and deletes it
// when the test finishes. Returns its path as a string, like the original.

async function tmp(t, { name = null, order = Infinity, force = true } = {}) {
  if (typeof name !== 'string' || !/^[^<>:/\\|?*]{1,64}$/.test(name)) {
    name = Math.random().toString(16).slice(2)
  }

  const dirName = 'tmp-test-' + name
  const root = await navigator.storage.getDirectory()
  const parent = await root.getDirectoryHandle('tmp', { create: true })

  await gc()
  await parent.getDirectoryHandle(dirName, { create: true })

  if (t) t.teardown(gc, { order, force })
  return '/tmp/' + dirName

  async function gc() {
    try {
      await parent.removeEntry(dirName, { recursive: true })
    } catch (err) {
      if (!err || err.name !== 'NotFoundError') throw err
    }
  }
}

module.exports = tmp
