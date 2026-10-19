// Builds browser-test/smoke.bundle.js: the smoke test (browser-test/smoke.js)
// bundled for the browser with the substitutions in scripts/aliases.js.
//
// Then open browser-test/index.html through a local web server (OPFS needs a
// secure context; http://localhost counts), for example:
//
//   npx http-server browser-test     or     python3 -m http.server -d browser-test
//
// The same bundle also runs in Node against the strict OPFS shim, which
// checks that nothing in it still needs Node's fs: npm run test:bundle

const esbuild = require('esbuild')
const path = require('path')
const { opfsAliases, PROJECT } = require('./aliases')

async function build() {
  const result = await esbuild.build({
    entryPoints: [path.join(PROJECT, 'browser-test', 'smoke.js')],
    outfile: path.join(PROJECT, 'browser-test', 'smoke.bundle.js'),
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'es2020',
    mainFields: ['browser', 'module', 'main'],
    inject: [path.join(PROJECT, 'browser', 'globals.js')],
    define: { global: 'globalThis' },
    plugins: [opfsAliases()],
    logLevel: 'warning',
    metafile: true
  })

  const inputs = Object.keys(result.metafile.inputs)
  const bytes = result.metafile.outputs[Object.keys(result.metafile.outputs)[0]].bytes
  console.log(`built browser-test/smoke.bundle.js: ${(bytes / 1024).toFixed(0)} KB from ${inputs.length} modules`)
  return inputs
}

module.exports = build

if (require.main === module) {
  build().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
