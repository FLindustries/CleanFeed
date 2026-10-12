'use strict';
// getMenuInjectionAction: what the 3-dot menu injector (content.js
// injectBlockOption) does with an open popup. Findings #0 (re-injection loop
// froze the tab) and #35 (stale card in menus opened outside any card).

const assert = require('node:assert');
const test = require('./registry');
const loadContentDom = require('./load-content-dom');

test('a fresh click inside a card injects into a popup without CleanFeed items', () => {
  const { getMenuInjectionAction } = loadContentDom();
  assert.strictEqual(getMenuInjectionAction([], '7', 120), 'inject');
});

test('items already built for this click are kept: a repeat call changes nothing', () => {
  const { getMenuInjectionAction } = loadContentDom();
  assert.strictEqual(getMenuInjectionAction(['7', '7', '7', '7'], '7', 50), 'keep');
  // also long after the click (the popup is still open, YouTube flips attributes)
  assert.strictEqual(getMenuInjectionAction(['7', '7', '7'], '7', 60000), 'keep');
});

test('items for a channel-less card (topic item only) are kept too, not rebuilt', () => {
  const { getMenuInjectionAction } = loadContentDom();
  // separator, separator, topic item: no block item, but every node carries the token
  assert.strictEqual(getMenuInjectionAction(['3', '3', '3'], '3', 10), 'keep');
});

test('items built for an earlier click are replaced after a fresh card click', () => {
  const { getMenuInjectionAction } = loadContentDom();
  assert.strictEqual(getMenuInjectionAction(['6', '6', '6', '6'], '7', 200), 'replace');
});

test('a mix of tokens or untokened items counts as stale', () => {
  const { getMenuInjectionAction } = loadContentDom();
  assert.strictEqual(getMenuInjectionAction(['7', '6'], '7', 200), 'replace');
  assert.strictEqual(getMenuInjectionAction(['', ''], '7', 200), 'replace');
  assert.strictEqual(getMenuInjectionAction(['7', ''], '7', 5000), 'clear');
});

test('a click outside any card clears stale items and injects nothing', () => {
  const { getMenuInjectionAction } = loadContentDom();
  assert.strictEqual(getMenuInjectionAction(['6', '6', '6'], '', 100), 'clear');
  assert.strictEqual(getMenuInjectionAction([], '', 100), 'none');
});

test('a popup opened too long after the card click gets nothing', () => {
  const { getMenuInjectionAction, MENU_CLICK_WINDOW_MS } = loadContentDom();
  assert.strictEqual(MENU_CLICK_WINDOW_MS, 1000);
  assert.strictEqual(getMenuInjectionAction([], '7', MENU_CLICK_WINDOW_MS), 'inject');
  assert.strictEqual(getMenuInjectionAction([], '7', MENU_CLICK_WINDOW_MS + 1), 'none');
  assert.strictEqual(getMenuInjectionAction(['6', '6'], '7', 5000), 'clear');
});

test('a negative click age (clock moved back) is not treated as fresh', () => {
  const { getMenuInjectionAction } = loadContentDom();
  assert.strictEqual(getMenuInjectionAction([], '7', -5), 'none');
});

test('repeated calls converge: after inject/replace the next call is keep', () => {
  const { getMenuInjectionAction } = loadContentDom();
  // Simulates the observer re-running the injector on its own mutations.
  let items = ['4', '4', '4'];
  const token = '5';
  const actions = [];
  for (let i = 0; i < 5; i++) {
    const action = getMenuInjectionAction(items, token, 30 + i);
    actions.push(action);
    if (action === 'replace' || action === 'inject') items = [token, token, token];
    if (action === 'clear') items = [];
  }
  assert.deepStrictEqual(actions, ['replace', 'keep', 'keep', 'keep', 'keep']);
});
