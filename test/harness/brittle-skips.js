// brittle, with the upstream skip list (test/skip-list.js) applied by test name.
// A skipped test still shows up in the output, marked SKIP.

const { workerData } = require('worker_threads')
const brittle = require('brittle')
const skipList = require('../skip-list')

const skips = skipList[workerData.suite] || {}

function test(name, ...rest) {
  if (typeof name === 'string' && Object.prototype.hasOwnProperty.call(skips, name)) {
    return brittle.skip(name, () => {})
  }
  return brittle(name, ...rest)
}

for (const key of Object.keys(brittle)) test[key] = brittle[key]
test.test = test

module.exports = test
