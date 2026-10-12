'use strict';
// One source of truth for topics and synonyms (audit findings #3, #34).
//   - content-dom.js owns KEYWORD_SYNONYMS and CATEGORY_META (display name + order)
//   - options.html and popup.html load content-dom.js and read both from it
//   - the popup grid, the Options list and the content-script topic menu list every topic
//   - a raw key such as ai_hype / true_crime is never shown to the user

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('./registry');
const loadContentDom = require('./load-content-dom');

const { plain } = loadContentDom;
const ROOT = path.resolve(__dirname, '..', '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');

// --- the meta table covers exactly the topics blocking knows ---

test('every KEYWORD_SYNONYMS category has a CATEGORY_META entry, and the other way round', () => {
  const { KEYWORD_SYNONYMS, CATEGORY_META } = loadContentDom();
  const synonymKeys = Object.keys(KEYWORD_SYNONYMS).sort();
  const metaKeys = Object.keys(CATEGORY_META).sort();
  assert.deepStrictEqual(metaKeys, synonymKeys);
  assert.strictEqual(synonymKeys.length, 35);
});

test('every CATEGORY_META entry has a readable display name', () => {
  const { CATEGORY_META } = loadContentDom();
  const seen = new Set();
  for (const [key, meta] of Object.entries(CATEGORY_META)) {
    assert.strictEqual(typeof meta.label, 'string', `${key} has no label`);
    assert.ok(meta.label.trim() !== '', `${key} has an empty label`);
    assert.ok(!meta.label.includes('_'), `${key} label looks like a raw key: ${meta.label}`);
    assert.notStrictEqual(meta.label, key, `${key} label is just its key`);
    assert.ok(!seen.has(meta.label), `duplicate label: ${meta.label}`);
    seen.add(meta.label);
  }
});

test('cfCategoryList lists all 35 categories as { key, label } in CATEGORY_META order', () => {
  const { cfCategoryList, CATEGORY_META } = loadContentDom();
  const list = plain(cfCategoryList());
  assert.strictEqual(list.length, 35);
  assert.deepStrictEqual(list.map(c => c.key), Object.keys(CATEGORY_META));
  for (const c of list) assert.strictEqual(c.label, CATEGORY_META[c.key].label);
  // The topics the old popup/menu lists left out
  const keys = list.map(c => c.key);
  for (const key of ['fitness', 'tech', 'ai_hype', 'brainrot', 'paranormal']) {
    assert.ok(keys.includes(key), `missing ${key}`);
  }
});

// --- display names ---

test('cfCategoryLabel gives the display name of a topic key', () => {
  const { cfCategoryLabel } = loadContentDom();
  assert.strictEqual(cfCategoryLabel('true_crime'), 'True Crime');
  assert.strictEqual(cfCategoryLabel('ai_hype'), 'AI Hype');
  assert.strictEqual(cfCategoryLabel('kpop'), 'K-Pop');
  assert.strictEqual(cfCategoryLabel('gaming'), 'Gaming');
  assert.strictEqual(cfCategoryLabel('Gaming'), 'Gaming');
});

test('cfCategoryLabel leaves anything that is not a topic key untouched', () => {
  const { cfCategoryLabel } = loadContentDom();
  assert.strictEqual(cfCategoryLabel('sourdough'), 'sourdough');
  assert.strictEqual(cfCategoryLabel('Half-Life 2'), 'Half-Life 2');
  // Object.prototype names are not topics
  for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    assert.strictEqual(cfCategoryLabel(name), name);
  }
  assert.strictEqual(cfCategoryLabel(''), '');
  assert.strictEqual(cfCategoryLabel(null), '');
  assert.strictEqual(cfCategoryLabel(undefined), '');
});

// --- Options synonym chips are exactly the terms blocking uses ---

test('cfBuiltInTerms is the built-in part of getExpandedKeywords, topic key first, no repeats', () => {
  const { cfBuiltInTerms, getExpandedKeywords, cfCategoryList } = loadContentDom();
  for (const { key } of cfCategoryList()) {
    const terms = plain(cfBuiltInTerms(key));
    assert.strictEqual(terms[0], key);
    assert.strictEqual(new Set(terms).size, terms.length, `${key} lists a term twice`);
    assert.deepStrictEqual(terms, plain(getExpandedKeywords(key)), `${key} chips differ from blocking`);
  }
});

test('the Gaming terms come from the current list: new terms in, stale Options-only terms out', () => {
  const { cfBuiltInTerms } = loadContentDom();
  const gaming = plain(cfBuiltInTerms('gaming'));
  assert.ok(gaming.includes('giocare'), 'a term used for blocking is missing');
  for (const stale of ['game', 'games', 'steam', 'halo', 'destiny', 'mr beast gaming']) {
    assert.ok(!gaming.includes(stale), `stale term still listed: ${stale}`);
  }
});

test('cfBuiltInTerms of a non-topic is empty', () => {
  const { cfBuiltInTerms } = loadContentDom();
  assert.deepStrictEqual(plain(cfBuiltInTerms('bitcoin')), []);
  assert.deepStrictEqual(plain(cfBuiltInTerms('constructor')), []);
  assert.deepStrictEqual(plain(cfBuiltInTerms('')), []);
});

// --- extension pages can load content-dom.js ---

test('content-dom.js loads with no document, window or location (an extension page has no YouTube DOM)', () => {
  const source = read('content-dom.js');
  const context = vm.createContext({});
  assert.doesNotThrow(() => vm.runInContext(source, context, { filename: 'content-dom.js' }));
});

function topLevelNames(source) {
  const names = new Set();
  const fnRe = /^(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/gm;
  const varRe = /^(?:const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm;
  for (const re of [fnRe, varRe]) {
    let m;
    while ((m = re.exec(source)) !== null) names.add(m[1]);
  }
  return names;
}

test('options.js and popup.js declare no top-level name that content-dom.js also declares', () => {
  // Two classic scripts on one page share the global lexical scope: a repeated
  // const/let/class name is a SyntaxError that leaves the page without a script.
  const shared = topLevelNames(read('content-dom.js'));
  for (const file of ['options.js', 'popup.js']) {
    const clash = [...topLevelNames(read(file))].filter(n => shared.has(n));
    assert.deepStrictEqual(clash, [], `${file} redeclares: ${clash.join(', ')}`);
  }
});

test('options.html and popup.html load content-dom.js before their own script', () => {
  for (const [html, script] of [['options.html', 'options.js'], ['popup.html', 'popup.js']]) {
    const source = read(html);
    const shared = source.indexOf('<script src="content-dom.js"></script>');
    const own = source.indexOf(`<script src="${script}"></script>`);
    assert.ok(shared !== -1, `${html} does not load content-dom.js`);
    assert.ok(own !== -1, `${html} does not load ${script}`);
    assert.ok(shared < own, `${html} loads content-dom.js after ${script}`);
  }
});

test('content-dom.js is in the extension package', () => {
  assert.ok(read('package.sh').includes("'content-dom.js'"));
});

test('options.js keeps no synonym map or category table of its own', () => {
  const options = read('options.js');
  assert.ok(!/^(?:const|let|var)\s+KEYWORD_SYNONYMS\b/m.test(options), 'options.js still declares KEYWORD_SYNONYMS');
  assert.ok(!/^(?:const|let|var)\s+CATEGORIES\b/m.test(options), 'options.js still declares CATEGORIES');
});

test('popup.js and content.js keep no category list of their own', () => {
  const popup = read('popup.js');
  const content = read('content.js');
  assert.ok(!/key:\s*'unboxing'/.test(popup), 'popup.js still lists categories');
  assert.ok(!/'true_crime'/.test(content), 'content.js still lists categories');
});
