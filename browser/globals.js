// Node globals some dependencies expect, for browser bundles. Injected by
// the bundler (see scripts/build-browser-test.js).
import { Buffer } from 'buffer'
import process from 'process/browser.js'

// Some dependencies read global.process instead of process (corestore ->
// which-runtime reads global.process.platform), so put it on globalThis too.
if (!globalThis.process) globalThis.process = process

export { Buffer, process }
