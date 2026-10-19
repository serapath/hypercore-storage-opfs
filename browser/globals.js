// Node globals some dependencies expect, for browser bundles. Injected by
// the bundler (see scripts/build-browser-test.js).
import { Buffer } from 'buffer'
import process from 'process/browser.js'

export { Buffer, process }
