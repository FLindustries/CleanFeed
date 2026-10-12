'use strict';
// Zero-dependency unit test runner.
//   node tests/run-unit.js            run every tests/unit/*.test.js
//   node tests/run-unit.js keyword    only files whose name contains "keyword"
// Prints one line per test and a summary, exits 1 on any failure.
// A test file registers cases with require('./registry') (see tests/unit/registry.js)
// or by exporting an object of { 'test name': fn }.

const fs = require('node:fs');
const path = require('node:path');
const registry = require('./unit/registry');

const UNIT_DIR = path.join(__dirname, 'unit');
const TEST_TIMEOUT_MS = 10000;

function withTimeout(promise, ms, name) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms: ${name}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function collect(file) {
  const label = path.basename(file);
  registry.drain();
  const exported = require(file);
  const cases = registry.drain().map(t => ({ file: label, ...t }));
  if (exported && typeof exported === 'object') {
    for (const [name, fn] of Object.entries(exported)) {
      if (typeof fn === 'function') cases.push({ file: label, name, fn });
    }
  }
  return cases;
}

async function main() {
  const filter = process.argv[2] || '';
  const files = fs.readdirSync(UNIT_DIR)
    .filter(f => f.endsWith('.test.js') && f.includes(filter))
    .sort();

  let passed = 0;
  let failed = 0;

  for (const f of files) {
    let cases;
    try {
      cases = collect(path.join(UNIT_DIR, f));
    } catch (err) {
      failed++;
      console.log(`FAIL ${f} > (could not load)\n     ${String(err && err.stack || err).split('\n').join('\n     ')}`);
      continue;
    }
    for (const c of cases) {
      try {
        await withTimeout(Promise.resolve().then(c.fn), TEST_TIMEOUT_MS, c.name);
        passed++;
        console.log(`PASS ${c.file} > ${c.name}`);
      } catch (err) {
        failed++;
        console.log(`FAIL ${c.file} > ${c.name}\n     ${String(err && err.message || err).split('\n').join('\n     ')}`);
      }
    }
  }

  const total = passed + failed;
  if (total === 0) {
    console.log('FAIL no tests found' + (filter ? ` for filter "${filter}"` : ''));
    process.exit(1);
  }
  console.log(`\n${passed} passed, ${failed} failed, ${total} total`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
