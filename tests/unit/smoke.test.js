'use strict';
// Smoke tests: true statements about CURRENT behavior of content-dom.js.
// They prove the loader works and give later tasks a known-good baseline.

const assert = require('node:assert');
const test = require('./registry');
const loadContentDom = require('./load-content-dom');

const { plain } = loadContentDom;

test('loader exposes the content-dom.js bindings later tasks rely on', () => {
  const cf = loadContentDom();
  for (const name of [
    'cfEl', 'matchesKeyword', 'getExpandedKeywords', 'KEYWORD_SYNONYMS',
    'CATEGORY_EXEMPTIONS', 'isCategoryExempt', 'isValidChannelName',
    'cfSetSynonymFilters', 'YT'
  ]) {
    assert.ok(name in cf, `missing binding: ${name}`);
  }
  assert.strictEqual(typeof cf.matchesKeyword, 'function');
  assert.strictEqual(typeof cf.YT.getChannelName, 'function');
  assert.strictEqual(typeof cf.YT.VIDEO_CARDS, 'string');
});

test('matchesKeyword matches a whole word, case-insensitively', () => {
  const { matchesKeyword } = loadContentDom();
  assert.strictEqual(matchesKeyword('Minecraft house tutorial', 'minecraft'), true);
  assert.strictEqual(matchesKeyword('MINECRAFT house tutorial', 'Minecraft'), true);
});

test('matchesKeyword does not match inside a longer word', () => {
  const { matchesKeyword } = loadContentDom();
  assert.strictEqual(matchesKeyword('display', 'play'), false);
  assert.strictEqual(matchesKeyword('endgame', 'game'), false);
});

test('matchesKeyword matches multi-word phrases and escapes regex characters', () => {
  const { matchesKeyword } = loadContentDom();
  assert.strictEqual(matchesKeyword("Assassin's Creed full playthrough", "assassin's creed"), true);
  // regex metacharacters are escaped, so "." is a literal dot, not "any char"
  assert.strictEqual(matchesKeyword('node.js tips', 'node.js'), true);
  assert.strictEqual(matchesKeyword('nodexjs tips', 'node.js'), false);
  assert.strictEqual(matchesKeyword('anything', ''), false);
  assert.strictEqual(matchesKeyword('', 'anything'), false);
});

test('getExpandedKeywords expands a category name, but not a mere synonym of it', () => {
  const { getExpandedKeywords } = loadContentDom();
  const fromCategory = plain(getExpandedKeywords('crypto'));
  assert.strictEqual(fromCategory[0], 'crypto');
  assert.ok(fromCategory.includes('bitcoin'));
  assert.ok(fromCategory.includes('ethereum'));
  // Blocking "bitcoin" on its own blocks just "bitcoin" (audit #9)
  assert.deepStrictEqual(plain(getExpandedKeywords('bitcoin')), ['bitcoin']);
});

test('getExpandedKeywords returns just the lowercased keyword when it is not a category', () => {
  const { getExpandedKeywords } = loadContentDom();
  assert.deepStrictEqual(plain(getExpandedKeywords('Sourdough')), ['sourdough']);
});

test('cfSetSynonymFilters disables built-in synonyms and adds custom ones', () => {
  const { getExpandedKeywords, cfSetSynonymFilters } = loadContentDom();
  cfSetSynonymFilters(['Bitcoin'], { crypto: ['cardano'] });
  const expanded = plain(getExpandedKeywords('crypto'));
  assert.ok(!expanded.includes('bitcoin'), 'disabled synonym should be gone');
  assert.ok(expanded.includes('ethereum'));
  assert.ok(expanded.includes('cardano'), 'custom synonym should be added');
});

test('each loadContentDom() call starts from clean synonym filters', () => {
  const first = loadContentDom();
  first.cfSetSynonymFilters(['bitcoin'], {});
  const second = loadContentDom();
  assert.ok(plain(second.getExpandedKeywords('crypto')).includes('bitcoin'));
});

test('isCategoryExempt exempts discussion-style titles only for the right category', () => {
  const { isCategoryExempt } = loadContentDom();
  assert.strictEqual(isCategoryExempt('The history of Nintendo consoles', 'gaming'), true);
  assert.strictEqual(isCategoryExempt('Elden Ring boss fight', 'gaming'), false);
  assert.strictEqual(isCategoryExempt('The history of Nintendo consoles', 'crypto'), false);
  assert.strictEqual(isCategoryExempt('', 'gaming'), false);
});

test('isValidChannelName rejects separators, view counts and dates', () => {
  const { isValidChannelName } = loadContentDom();
  assert.strictEqual(isValidChannelName('Veritasium'), true);
  assert.strictEqual(isValidChannelName('•'), false);
  assert.strictEqual(isValidChannelName('1.2M views'), false);
  assert.strictEqual(isValidChannelName('3 days ago'), false);
  assert.strictEqual(isValidChannelName(''), false);
});

test('KEYWORD_SYNONYMS and CATEGORY_EXEMPTIONS have the expected shape', () => {
  const { KEYWORD_SYNONYMS, CATEGORY_EXEMPTIONS } = loadContentDom();
  assert.ok(Array.isArray(KEYWORD_SYNONYMS.gaming));
  assert.ok(KEYWORD_SYNONYMS.gaming.includes('minecraft'));
  assert.ok(Array.isArray(CATEGORY_EXEMPTIONS.gaming));
});

test('cfEl builds elements through the stubbed DOM without innerHTML', () => {
  const { cfEl } = loadContentDom();
  const el = cfEl('div', { id: 'x', className: 'a', title: 't' }, ['hello', cfEl('span', { textContent: 'world' })]);
  assert.strictEqual(el.tagName, 'DIV');
  assert.strictEqual(el.id, 'x');
  assert.strictEqual(el.className, 'a');
  assert.strictEqual(el.getAttribute('title'), 't');
  assert.strictEqual(el.textContent, 'helloworld');
});
