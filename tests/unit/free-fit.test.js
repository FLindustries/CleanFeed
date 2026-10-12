'use strict';
// What fits the Free plan (v1.4 pricing, task 2).
//   - Presets (options.js PRESETS): every one has exactly 3 topics, each a
//     real topic (KEYWORD_SYNONYMS and CATEGORY_META); a Free user with no
//     keywords can apply any one; one that does not fit still gets the
//     over-cap notice with the real numbers.
//   - Keyword counter: the popup's "N/3 keywords used" is cfFreeKeywordsUsed
//     (content-dom.js), the same count the background cap uses (every entry of
//     blockedKeywords, topics included) in addKeyword, bulkAddBlockingTerms
//     and applyPreset.
//   - Whitelist chip (content.js): cfWhitelistOutcome says "saved" only for
//     { success: true }; a Free user's { success: false, reason: 'pro_only' }
//     is a failure.

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('./registry');
const loadBackground = require('./load-background');
const loadContentDom = require('./load-content-dom');

const ROOT = path.resolve(__dirname, '..', '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/\r\n/g, '\n');
const saved = words => words.map(keyword => ({ keyword, addedAt: 1 }));
const blocked = bg => (bg.storage().blockedKeywords || []).map(k => k.keyword);

// A node with just what options.js's preset notice touches.
function stubNode(tag) {
  let text = '';
  return {
    tagName: String(tag || '').toUpperCase(), className: '', hidden: false,
    children: [], listeners: {},
    get textContent() { return text; },
    set textContent(value) { text = String(value); this.children = []; }, // like the DOM: setting text drops the children
    appendChild(child) { this.children.push(child); return child; },
    addEventListener(type, fn) { this.listeners[type] = fn; }
  };
}

// options.js, loaded the way options.html does (features.js, content-dom.js,
// strict-client.js, then the page) with a stub document and chrome. Returns
// the page's PRESETS and a way to render its preset notice for a given state.
function loadOptions() {
  const noop = () => {};
  const notice = stubNode('div');
  notice.hidden = true;
  const messageCalls = [];
  const sandbox = {
    console,
    document: {
      addEventListener: noop,
      querySelectorAll: () => [],
      getElementById: id => (id === 'presets-notice' ? notice : null),
      createElement: tag => stubNode(tag)
    },
    chrome: {
      i18n: { getMessage: (key, subs) => { messageCalls.push({ key, subs }); return key; } },
      storage: { onChanged: { addListener: noop }, local: { get: async () => ({}) } },
      runtime: { sendMessage: async () => ({}), getManifest: () => ({ version: '0.0.0-test' }) },
      tabs: { query: noop }
    }
  };
  vm.createContext(sandbox);
  for (const name of ['features.js', 'content-dom.js', 'strict-client.js']) {
    vm.runInContext(read(name), sandbox, { filename: name });
  }
  const shim = `
;globalThis.__cfOptions = {
  PRESETS,
  showNotice(newState, notice) {
    state = newState;
    presetLimitNotice = notice;
    renderPresetLimitNotice(new Set((state.blockedKeywords || []).map(k => k.keyword.toLowerCase())));
  }
};
`;
  vm.runInContext(read('options.js') + shim, sandbox, { filename: 'options.js' });
  return { presets: loadContentDom.plain(sandbox.__cfOptions.PRESETS), showNotice: sandbox.__cfOptions.showNotice, notice, messageCalls };
}

// --- Presets ---

test('every preset has exactly 3 distinct topics, each a real topic', () => {
  const cf = loadContentDom();
  const { presets } = loadOptions();
  assert.ok(presets.length >= 5, 'the presets are there');
  const ids = new Set();
  for (const preset of presets) {
    assert.ok(!ids.has(preset.id), 'duplicate preset id ' + preset.id);
    ids.add(preset.id);
    assert.strictEqual(preset.keys.length, 3, `${preset.id} has ${preset.keys.length} topics`);
    assert.strictEqual(new Set(preset.keys).size, 3, `${preset.id} repeats a topic`);
    for (const key of preset.keys) {
      assert.ok(Object.prototype.hasOwnProperty.call(cf.KEYWORD_SYNONYMS, key), `${preset.id}: "${key}" is not a KEYWORD_SYNONYMS key`);
      assert.ok(Object.prototype.hasOwnProperty.call(cf.CATEGORY_META, key), `${preset.id}: "${key}" is not a topic in CATEGORY_META`);
    }
  }
});

test('free with no keywords: every preset applies whole (3 topics blocked, nothing refused)', async () => {
  const { presets } = loadOptions();
  for (const preset of presets) {
    const bg = loadBackground({ blockedKeywords: [] }, { isPro: false });
    assert.deepStrictEqual(await bg.handleMessage({ action: 'applyPreset', categoryKeys: preset.keys }),
      { success: true, added: 3, alreadyBlocked: 0 }, preset.id);
    assert.deepStrictEqual(blocked(bg), preset.keys, preset.id);
  }
});

test('free: a preset still reports the over-cap numbers when it does not fit', async () => {
  const { presets } = loadOptions();
  for (const preset of presets) {
    const bg = loadBackground({ blockedKeywords: saved(['minecraft']) }, { isPro: false });
    assert.deepStrictEqual(await bg.handleMessage({ action: 'applyPreset', categoryKeys: preset.keys }),
      { success: false, reason: 'free_limit', wouldAdd: 3, currentCount: 1, limit: 3 }, preset.id);
    assert.deepStrictEqual(blocked(bg), ['minecraft'], preset.id + ' added nothing');
  }
});

test('preset notice: shown with the real numbers when the preset does not fit, hidden when it does', () => {
  const page = loadOptions();
  const focus = page.presets[0];

  // One unrelated keyword: the preset adds 3, 2 slots are left of 3
  page.showNotice({ isPro: false, blockedKeywords: saved(['minecraft']) }, { id: focus.id, limit: 3 });
  assert.strictEqual(page.notice.hidden, false, 'notice shown');
  const call = page.messageCalls.filter(c => c.key === 'presetFreeLimitWarning').pop();
  assert.deepStrictEqual(call && loadContentDom.plain(call.subs), ['3', '2', '3']);
  assert.ok(page.notice.children.some(c => c.tagName === 'BUTTON'), 'an Upgrade button');

  // Nothing blocked: the preset fits, so no notice
  page.showNotice({ isPro: false, blockedKeywords: [] }, { id: focus.id, limit: 3 });
  assert.strictEqual(page.notice.hidden, true, 'no notice when it fits');
  assert.strictEqual(page.notice.children.length, 0);

  // Pro: never a notice
  page.showNotice({ isPro: true, blockedKeywords: saved(['a', 'b', 'c', 'd']) }, { id: focus.id, limit: 3 });
  assert.strictEqual(page.notice.hidden, true, 'no notice for Pro');
});

// --- Keyword counter ---

test('the free keyword limit in content-dom.js is the background cap', () => {
  const cf = loadContentDom();
  const bg = loadBackground({});
  assert.strictEqual(cf.CF_FREE_KEYWORD_LIMIT, bg.Storage.FREE_KEYWORD_LIMIT);
  assert.strictEqual(cf.CF_FREE_KEYWORD_LIMIT, 3);
});

test('cfFreeKeywordsUsed counts every saved keyword, topics included', () => {
  const cf = loadContentDom();
  assert.strictEqual(cf.cfFreeKeywordsUsed([]), 0);
  assert.strictEqual(cf.cfFreeKeywordsUsed(saved(['gaming', 'gossip', 'brainrot'])), 3, '3 topics read 3/3');
  assert.strictEqual(cf.cfFreeKeywordsUsed(saved(['minecraft', 'fortnite'])), 2);
  assert.strictEqual(cf.cfFreeKeywordsUsed(saved(['gaming', 'minecraft', 'news', 'fortnite'])), 4, 'over the cap (Pro lapsed) still counts all');
  assert.strictEqual(cf.cfFreeKeywordsUsed(undefined), 0);
  assert.strictEqual(cf.cfFreeKeywordsUsed(null), 0);
});

test('the counter equals what the background cap counts (addKeyword, bulk add, preset)', async () => {
  const cf = loadContentDom();
  const lists = [
    [], ['gaming'], ['minecraft'], ['gaming', 'gossip'], ['gaming', 'minecraft'],
    ['gaming', 'gossip', 'brainrot'], ['minecraft', 'fortnite', 'news'],
    ['gaming', 'minecraft', 'news', 'fortnite']
  ];
  for (const words of lists) {
    const used = cf.cfFreeKeywordsUsed(saved(words));
    const atCap = used >= cf.CF_FREE_KEYWORD_LIMIT;
    const label = JSON.stringify(words) + ` (counter ${used})`;

    const add = await loadBackground({ blockedKeywords: saved(words) }, { isPro: false })
      .handleMessage({ action: 'addKeyword', keyword: 'zebra stripes' });
    assert.strictEqual(add.reason === 'free_limit', atCap, 'addKeyword: ' + label);

    const bulk = await loadBackground({ blockedKeywords: saved(words) }, { isPro: false })
      .handleMessage({ action: 'bulkAddBlockingTerms', items: [{ type: 'keyword', phrase: 'zebra stripes' }] });
    assert.strictEqual(bulk.skippedFree === 1, atCap, 'bulkAddBlockingTerms: ' + label);

    const preset = await loadBackground({ blockedKeywords: saved(words) }, { isPro: false })
      .handleMessage({ action: 'applyPreset', categoryKeys: ['asmr'] });
    assert.strictEqual(preset.reason === 'free_limit', atCap, 'applyPreset: ' + label);
    if (preset.reason === 'free_limit') assert.strictEqual(preset.currentCount, used, 'applyPreset currentCount: ' + label);
  }
});

test('popup.js and options.js use the shared counter and limit, not a rule of their own', () => {
  const popup = read('popup.js');
  const options = read('options.js');
  assert.ok(/cfMsg\('keywordsUsed',\s*\[String\(cfFreeKeywordsUsed\(state\.blockedKeywords\)\)\]\)/.test(popup),
    'the popup counter shows cfFreeKeywordsUsed(state.blockedKeywords)');
  assert.strictEqual((popup.match(/keywordsUsed/g) || []).length, 1, 'the counter text is built in one place');
  for (const [file, source] of [['popup.js', popup], ['options.js', options]]) {
    assert.ok(/cfFreeKeywordsUsed\(state\.blockedKeywords\)\s*>=\s*CF_FREE_KEYWORD_LIMIT/.test(source), file + ' locks topics with the shared rule');
    assert.ok(!/totalKeywords\s*>=\s*3/.test(source), file + ' hard-codes the limit');
  }
});

// --- Whitelist chip ---

test('cfWhitelistOutcome: saved only for { success: true }', () => {
  const cf = loadContentDom();
  assert.strictEqual(cf.cfWhitelistOutcome({ success: true }), 'saved');
  for (const answer of [
    { success: false, reason: 'pro_only' },   // the background's answer to a Free user
    { success: false },
    {},
    { success: 'true' },
    { success: 1 },
    { error: 'boom' },
    { added: true },
    null,
    undefined,
    'ok',
    0
  ]) {
    assert.strictEqual(cf.cfWhitelistOutcome(answer), 'failed', JSON.stringify(answer));
  }
  assert.strictEqual(cf.cfWhitelistOutcome({ error: 'strict_locked' }), 'locked');
});

test('the whitelist chip waits for { success: true } before it disappears', async () => {
  // The background answers a Free user's whitelistChannel with pro_only
  const bg = loadBackground({}, { isPro: false });
  const answer = await bg.handleMessage({ action: 'whitelistChannel', name: 'Some Channel', id: '@some', exemptFrom: 'gaming' });
  assert.deepStrictEqual(answer, { success: false, reason: 'pro_only' });
  assert.strictEqual(loadContentDom().cfWhitelistOutcome(answer), 'failed');
  const pro = await loadBackground({}, { isPro: true })
    .handleMessage({ action: 'whitelistChannel', name: 'Some Channel', id: '@some', exemptFrom: 'gaming' });
  assert.strictEqual(loadContentDom().cfWhitelistOutcome(pro), 'saved');

  // content.js: the chip is removed and the local whitelist grows only on "saved"
  const source = read('content.js');
  const start = source.indexOf("action: 'whitelistChannel'");
  const end = source.indexOf('filterPage();', start);
  assert.ok(start > 0 && end > start, 'content.js has the whitelist chip handler');
  const handler = source.slice(start, end);
  assert.ok(/cfWhitelistOutcome\(res\)/.test(handler), 'the handler asks cfWhitelistOutcome');
  assert.ok(!/!res\s*\|\|\s*res\.error/.test(handler), 'the handler no longer treats "no error" as success');
  const check = handler.indexOf('cfWhitelistOutcome(res)');
  assert.ok(check >= 0 && check < handler.indexOf('chip.remove()'), 'the answer is checked before chip.remove()');
  assert.ok(check < handler.indexOf('whitelistedChannels.push'), 'the answer is checked before the local whitelist grows');
  assert.ok(/showActionFailedToast\(\)/.test(handler), 'a failed answer shows the existing failure toast');
  assert.ok(/showStrictLockedToast\(\)/.test(handler), 'the strict-mode toast stays');
});
