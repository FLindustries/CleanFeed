'use strict';
// Tiny test registry shared by tests/run-unit.js and the *.test.js files.
// Usage in a test file:
//   const test = require('./registry');
//   test('does the thing', () => { assert.strictEqual(...); });
// Async functions are awaited. A thrown error (e.g. from node:assert) fails the test.

const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

test.drain = function drain() {
  return tests.splice(0, tests.length);
};

module.exports = test;
