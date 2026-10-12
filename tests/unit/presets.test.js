'use strict';
// Quick presets on the free plan (background.js applyPreset), audit finding #26.
//   - A preset that would go past the 3 free slots is refused with the real
//     numbers: { reason: 'free_limit', wouldAdd, currentCount, limit }.
//   - A preset that fits within the cap just applies.
//   - A preset whose topics are all blocked already is never refused, even
//     with more than 3 keywords saved (e.g. Pro lapsed).

const assert = require('node:assert');
const test = require('./registry');
const loadBackground = require('./load-background');

const FOCUS = ['gaming', 'gossip', 'reaction', 'brainrot'];
const saved = (...words) => words.map(keyword => ({ keyword, addedAt: 1 }));
const blocked = bg => (bg.storage().blockedKeywords || []).map(k => k.keyword);

test('free: a preset past the cap is refused with how many topics it adds and the free slots', async () => {
  const bg = loadBackground({ blockedKeywords: [] }, { isPro: false });
  assert.deepStrictEqual(await bg.handleMessage({ action: 'applyPreset', categoryKeys: FOCUS }),
    { success: false, reason: 'free_limit', wouldAdd: 4, currentCount: 0, limit: 3 });
  assert.deepStrictEqual(bg.writes, [], 'nothing added');
});

test('free: topics already blocked are not counted as added', async () => {
  const bg = loadBackground({ blockedKeywords: saved('gaming', 'minecraft') }, { isPro: false });
  assert.deepStrictEqual(await bg.handleMessage({ action: 'applyPreset', categoryKeys: FOCUS }),
    { success: false, reason: 'free_limit', wouldAdd: 3, currentCount: 2, limit: 3 });
  assert.deepStrictEqual(blocked(bg), ['gaming', 'minecraft']);
});

test('free: a preset that fits within the cap just applies', async () => {
  const bg = loadBackground({ blockedKeywords: saved('gaming') }, { isPro: false });
  assert.deepStrictEqual(await bg.handleMessage({ action: 'applyPreset', categoryKeys: ['gaming', 'gossip', 'reaction'] }),
    { success: true, added: 2, alreadyBlocked: 1 });
  assert.deepStrictEqual(blocked(bg), ['gaming', 'gossip', 'reaction']);
});

test('free: a preset already fully blocked succeeds even with more than 3 keywords saved', async () => {
  const bg = loadBackground({ blockedKeywords: saved('gaming', 'gossip', 'reaction', 'brainrot', 'news') }, { isPro: false });
  assert.deepStrictEqual(await bg.handleMessage({ action: 'applyPreset', categoryKeys: FOCUS }),
    { success: true, added: 0, alreadyBlocked: 4 });
  assert.deepStrictEqual(bg.writes, []);
});

test('Pro: a preset applies whatever the count', async () => {
  const bg = loadBackground({ blockedKeywords: saved('news', 'politics', 'crypto') }, { isPro: true });
  assert.deepStrictEqual(await bg.handleMessage({ action: 'applyPreset', categoryKeys: FOCUS }),
    { success: true, added: 4, alreadyBlocked: 0 });
  assert.strictEqual(blocked(bg).length, 7);
});
