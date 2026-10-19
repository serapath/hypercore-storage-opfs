// The shim must refuse what browsers refuse. Each rule here is one a browser
// enforces; if the shim stopped enforcing it, code could pass in Node and
// fail in a browser.

const test = require('brittle')
const { execFileSync } = require('child_process')
const os = require('os')
const path = require('path')
const opfs = require('../opfs-node')

async function scratch() {
  const root = await navigator.storage.getDirectory()
  const parent = await root.getDirectoryHandle('shim-tests', { create: true })
  return parent.getDirectoryHandle('t' + Math.random().toString(16).slice(2), { create: true })
}

async function rejectsWith(t, promise, name) {
  try {
    await promise
    t.fail('expected ' + name)
  } catch (err) {
    t.is(err.name, name)
  }
}

function throwsWith(t, fn, name) {
  try {
    fn()
    t.fail('expected ' + name)
  } catch (err) {
    t.is(err.name, name)
  }
}

test('sync access handles are refused on the main thread', (t) => {
  const script = `
    const opfs = require(${JSON.stringify(path.join(__dirname, '..', 'opfs-node'))})
    opfs.install({ root: ${JSON.stringify(path.join(os.tmpdir(), 'opfs-main-thread-check'))} })
    ;(async () => {
      const root = await navigator.storage.getDirectory()
      const file = await root.getFileHandle('f', { create: true })
      try { await file.createSyncAccessHandle(); console.log('allowed') }
      catch (err) { console.log(err.name) }
    })()
  `
  t.is(execFileSync(process.execPath, ['-e', script]).toString().trim(), 'TypeError')
})

test('one sync access handle per file', async (t) => {
  const dir = await scratch()
  const file = await dir.getFileHandle('f', { create: true })
  const first = await file.createSyncAccessHandle()
  await rejectsWith(t, file.createSyncAccessHandle(), 'NoModificationAllowedError')
  first.close()
  const second = await file.createSyncAccessHandle()
  second.close()
})

test('locked files, and directories containing them, cannot be removed', async (t) => {
  const dir = await scratch()
  const sub = await dir.getDirectoryHandle('sub', { create: true })
  const handle = await (await sub.getFileHandle('f', { create: true })).createSyncAccessHandle()
  await rejectsWith(t, sub.removeEntry('f'), 'NoModificationAllowedError')
  await rejectsWith(t, dir.removeEntry('sub', { recursive: true }), 'NoModificationAllowedError')
  handle.close()
  await sub.removeEntry('f')
  await dir.removeEntry('sub')
})

test('closed handles throw InvalidStateError; close is idempotent', async (t) => {
  const dir = await scratch()
  const handle = await (await dir.getFileHandle('f', { create: true })).createSyncAccessHandle()
  handle.close()
  handle.close()
  throwsWith(t, () => handle.getSize(), 'InvalidStateError')
  throwsWith(t, () => handle.read(new Uint8Array(1), { at: 0 }), 'InvalidStateError')
  throwsWith(t, () => handle.write(new Uint8Array(1), { at: 0 }), 'InvalidStateError')
  throwsWith(t, () => handle.flush(), 'InvalidStateError')
})

test('names are validated', async (t) => {
  const dir = await scratch()
  for (const name of ['', '.', '..', 'a/b', 'a\\b']) {
    await rejectsWith(t, dir.getFileHandle(name, { create: true }), 'TypeError')
  }
})

test('missing entries, wrong kinds, non-empty directories', async (t) => {
  const dir = await scratch()
  await rejectsWith(t, dir.getFileHandle('nope'), 'NotFoundError')
  await rejectsWith(t, dir.getDirectoryHandle('nope'), 'NotFoundError')
  await rejectsWith(t, dir.removeEntry('nope'), 'NotFoundError')

  await dir.getFileHandle('file', { create: true })
  const sub = await dir.getDirectoryHandle('sub', { create: true })
  await rejectsWith(t, dir.getDirectoryHandle('file'), 'TypeMismatchError')
  await rejectsWith(t, dir.getFileHandle('sub'), 'TypeMismatchError')

  await sub.getFileHandle('inner', { create: true })
  await rejectsWith(t, dir.removeEntry('sub'), 'InvalidModificationError')
  await dir.removeEntry('sub', { recursive: true })
})

test('read/write positions and the file cursor', async (t) => {
  const dir = await scratch()
  const handle = await (await dir.getFileHandle('f', { create: true })).createSyncAccessHandle()

  t.is(handle.write(Buffer.from('hello')), 5) // cursor starts at 0
  t.is(handle.write(Buffer.from(' world')), 6) // continues at the cursor
  t.is(handle.getSize(), 11)

  const buf = Buffer.alloc(5)
  t.is(handle.read(buf, { at: 6 }), 5)
  t.is(buf.toString(), 'world')
  t.is(handle.read(Buffer.alloc(4), { at: 20 }), 0, 'reading past the end returns 0')

  handle.write(Buffer.from('!'), { at: 14 }) // writing past the end extends the file
  t.is(handle.getSize(), 15)

  handle.truncate(5)
  t.is(handle.getSize(), 5)
  throwsWith(t, () => handle.read(Buffer.alloc(1), { at: -1 }), 'TypeError')
  handle.close()
})

test('entries() lists files and directories', async (t) => {
  const dir = await scratch()
  await dir.getFileHandle('a', { create: true })
  await dir.getDirectoryHandle('b', { create: true })
  const seen = []
  for await (const [name, handle] of dir.entries()) seen.push(name + ':' + handle.kind)
  t.alike(seen.sort(), ['a:file', 'b:directory'])
})

test('openHandleCount reports open sync handles', async (t) => {
  const before = opfs.openHandleCount()
  const dir = await scratch()
  const handle = await (await dir.getFileHandle('f', { create: true })).createSyncAccessHandle()
  t.is(opfs.openHandleCount(), before + 1)
  handle.close()
  t.is(opfs.openHandleCount(), before)
})
