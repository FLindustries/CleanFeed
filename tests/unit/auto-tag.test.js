'use strict';
// Category auto-tag (audit findings #1, #8, #19):
//   - only a topic (a KEYWORD_SYNONYMS key) auto-tags channels; a plain keyword never does
//   - one video counts once per topic and channel, also across page loads
//   - a channel tags after 3 distinct videos
//   - "Untag" sticks: an untagged channel is never auto-tagged for that topic again

const assert = require('node:assert');
const test = require('./registry');
const loadContentDom = require('./load-content-dom');
const loadBackground = require('./load-background');
const { el } = require('./fake-dom');

// One batchIncrementCategoryHits message, as content.js sends it.
function hits(category, channel, videoKeys) {
  return { action: 'batchIncrementCategoryHits', hits: [[category + '::' + channel, videoKeys]] };
}

async function send(bg, ...requests) {
  let last;
  for (const request of requests) last = await bg.handleMessage(request);
  return last;
}

// --- Content side: which hidden videos count, and under which key ---

test('cfIsTopicKeyword: only a KEYWORD_SYNONYMS category key is a topic', () => {
  const { cfIsTopicKeyword } = loadContentDom();
  assert.strictEqual(cfIsTopicKeyword('gaming'), true);
  assert.strictEqual(cfIsTopicKeyword('Gaming'), true);
  assert.strictEqual(cfIsTopicKeyword(' crypto '), true);
  assert.strictEqual(cfIsTopicKeyword('trailer'), false);
  // A synonym of a topic is a plain keyword when blocked on its own
  assert.strictEqual(cfIsTopicKeyword('minecraft'), false);
  // Inherited object properties are not topics
  assert.strictEqual(cfIsTopicKeyword('constructor'), false);
  assert.strictEqual(cfIsTopicKeyword('__proto__'), false);
  assert.strictEqual(cfIsTopicKeyword(''), false);
  assert.strictEqual(cfIsTopicKeyword(null), false);
});

test('cfCategoryHitKey: a plain keyword queues no hit', () => {
  const { cfCategoryHitKey } = loadContentDom();
  assert.strictEqual(cfCategoryHitKey('trailer', 'IGN'), null);
  assert.strictEqual(cfCategoryHitKey('minecraft', 'IGN'), null);
});

test('cfCategoryHitKey: a topic queues a hit keyed by topic and channel, lowercased', () => {
  const { cfCategoryHitKey } = loadContentDom();
  assert.strictEqual(cfCategoryHitKey('gaming', 'IGN'), 'gaming::ign');
  assert.strictEqual(cfCategoryHitKey('Gaming', ' Every Eye '), 'gaming::every eye');
});

test('cfCategoryHitKey: garbage channel names never count', () => {
  const { cfCategoryHitKey } = loadContentDom();
  assert.strictEqual(cfCategoryHitKey('gaming', '•'), null);
  assert.strictEqual(cfCategoryHitKey('gaming', '1.2M views'), null);
  assert.strictEqual(cfCategoryHitKey('gaming', ''), null);
  assert.strictEqual(cfCategoryHitKey('gaming', null), null);
});

test('cfVideoIdFromHref reads /watch?v= and /shorts/ links', () => {
  const { cfVideoIdFromHref } = loadContentDom();
  assert.strictEqual(cfVideoIdFromHref('/watch?v=dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.strictEqual(cfVideoIdFromHref('/watch?v=dQw4w9WgXcQ&pp=ygUHbWluZWNyYWZ0'), 'dQw4w9WgXcQ');
  assert.strictEqual(cfVideoIdFromHref('/watch?list=PL123&v=a-b_c1234Z9&index=2'), 'a-b_c1234Z9');
  assert.strictEqual(cfVideoIdFromHref('/shorts/Ab3_-xYz123'), 'Ab3_-xYz123');
  assert.strictEqual(cfVideoIdFromHref('/@ign'), null);
  assert.strictEqual(cfVideoIdFromHref('/watch?v=short'), null);
  assert.strictEqual(cfVideoIdFromHref(null), null);
});

test('cfCategoryVideoKey: the video id, else the title', () => {
  const { cfCategoryVideoKey } = loadContentDom();
  assert.strictEqual(cfCategoryVideoKey('dQw4w9WgXcQ', 'Some title'), 'dQw4w9WgXcQ');
  assert.strictEqual(cfCategoryVideoKey(null, '  Elden Ring Review '), 't:elden ring review');
  assert.strictEqual(cfCategoryVideoKey(null, ''), null);
  assert.strictEqual(cfCategoryVideoKey(null, null), null);
  assert.ok(cfCategoryVideoKey(null, 'x'.repeat(500)).length <= 102);
});

test('YT.getVideoId: the first /watch or /shorts link of a card', () => {
  const { YT } = loadContentDom();
  const card = el('yt-lockup-view-model', {},
    el('a', { href: '/@ign' }, 'IGN'),
    el('a', { href: '/watch?v=dQw4w9WgXcQ&pp=abc' }),
    el('a', { href: '/watch?v=zzzzzzzzzzz' }));
  assert.strictEqual(YT.getVideoId(card), 'dQw4w9WgXcQ');
  const short = el('ytm-shorts-lockup-view-model', {}, el('a', { href: '/shorts/Ab3_-xYz123' }));
  assert.strictEqual(YT.getVideoId(short), 'Ab3_-xYz123');
  assert.strictEqual(YT.getVideoId(el('div', {}, el('a', { href: '/@ign' }))), null);
});

// --- Background: counting, threshold, exclusions ---

test('auto-tag: 3 hits from the same video id do not tag the channel', async () => {
  const bg = loadBackground();
  await send(bg,
    hits('gaming', 'ign', ['dQw4w9WgXcQ']),
    hits('gaming', 'ign', ['dQw4w9WgXcQ']),
    hits('gaming', 'ign', ['dQw4w9WgXcQ', 'dQw4w9WgXcQ']));
  const s = bg.storage();
  assert.strictEqual(s.categoryTags && s.categoryTags.gaming, undefined);
  assert.deepStrictEqual(s.categoryHitVideos.gaming.ign, ['dQw4w9WgXcQ']);
  assert.strictEqual(s.categoryHits.gaming.ign, 1);
});

test('auto-tag: 3 distinct videos tag the channel', async () => {
  const bg = loadBackground();
  const first = await send(bg, hits('gaming', 'ign', ['aaaaaaaaaaa', 'bbbbbbbbbbb']));
  assert.deepStrictEqual(first.newlyTagged, []);
  assert.strictEqual((bg.storage().categoryTags || {}).gaming, undefined);
  const second = await send(bg, hits('gaming', 'ign', ['ccccccccccc']));
  assert.deepStrictEqual(second.newlyTagged, [{ category: 'gaming', channel: 'ign' }]);
  assert.deepStrictEqual(bg.storage().categoryTags.gaming, ['ign']);
});

test('auto-tag: 3 distinct videos in one batch tag the channel', async () => {
  const bg = loadBackground();
  const res = await send(bg, hits('gaming', 'ign', ['aaaaaaaaaaa', 'bbbbbbbbbbb', 't:some title']));
  assert.deepStrictEqual(res.newlyTagged, [{ category: 'gaming', channel: 'ign' }]);
  assert.deepStrictEqual(bg.storage().categoryTags.gaming, ['ign']);
});

test('auto-tag: an untagged channel stays untagged after 3 more distinct videos', async () => {
  const bg = loadBackground();
  await send(bg, hits('gaming', 'ign', ['aaaaaaaaaaa', 'bbbbbbbbbbb', 'ccccccccccc']));
  assert.deepStrictEqual(bg.storage().categoryTags.gaming, ['ign']);

  await send(bg, { action: 'untagChannelForCategory', category: 'gaming', channelName: 'IGN' });
  let s = bg.storage();
  assert.strictEqual(s.categoryTags.gaming, undefined);
  assert.deepStrictEqual(s.categoryTagExclusions, { gaming: ['ign'] });

  const res = await send(bg, hits('gaming', 'ign', ['ddddddddddd', 'eeeeeeeeeee', 'fffffffffff']));
  assert.deepStrictEqual(res.newlyTagged, []);
  s = bg.storage();
  assert.strictEqual(s.categoryTags.gaming, undefined);
  assert.deepStrictEqual(s.categoryTagExclusions, { gaming: ['ign'] });

  const state = await bg.handleMessage({ action: 'getFullState' });
  assert.deepStrictEqual(state.categoryTagExclusions, { gaming: ['ign'] });
});

test('auto-tag: an exclusion applies to its topic only', async () => {
  const bg = loadBackground();
  await send(bg, { action: 'untagChannelForCategory', category: 'gaming', channelName: 'IGN' });
  const res = await send(bg, hits('anime', 'ign', ['aaaaaaaaaaa', 'bbbbbbbbbbb', 'ccccccccccc']));
  assert.deepStrictEqual(res.newlyTagged, [{ category: 'anime', channel: 'ign' }]);
  assert.deepStrictEqual(bg.storage().categoryTags, { anime: ['ign'] });
});

test('auto-tag: removing the topic wipes its counts and tags but keeps untag exclusions', async () => {
  const bg = loadBackground({ blockedKeywords: [{ keyword: 'gaming', addedAt: 1 }] });
  await send(bg,
    hits('gaming', 'ign', ['aaaaaaaaaaa', 'bbbbbbbbbbb', 'ccccccccccc']),
    hits('gaming', 'gamespot', ['ddddddddddd']),
    { action: 'untagChannelForCategory', category: 'gaming', channelName: 'ign' },
    { action: 'removeKeyword', index: 0 });
  const s = bg.storage();
  assert.strictEqual(s.categoryTags.gaming, undefined);
  assert.strictEqual(s.categoryHits.gaming, undefined);
  assert.strictEqual(s.categoryHitVideos.gaming, undefined);
  assert.deepStrictEqual(s.categoryTagExclusions, { gaming: ['ign'] });
});

test('auto-tag: counted videos are capped per topic and channel, newest kept', async () => {
  const bg = loadBackground();
  const keys = Array.from({ length: 25 }, (_, i) => 'vid' + String(i).padStart(8, '0'));
  await send(bg, hits('gaming', 'ign', keys.slice(0, 2)));
  await send(bg, hits('gaming', 'ign', keys.slice(2)));
  const s = bg.storage();
  assert.deepStrictEqual(s.categoryHitVideos.gaming.ign, keys.slice(5));
  assert.deepStrictEqual(s.categoryTags.gaming, ['ign']);
});

test('auto-tag: a batch that tags nothing does not rewrite categoryTags', async () => {
  const bg = loadBackground({ categoryTags: { anime: ['crunchyroll'] } });
  await send(bg, hits('gaming', 'ign', ['aaaaaaaaaaa']));
  await send(bg, hits('gaming', 'ign', ['aaaaaaaaaaa']));
  for (const keys of bg.writes) assert.ok(!keys.includes('categoryTags'), 'wrote ' + keys.join(','));
  assert.deepStrictEqual(bg.storage().categoryTags, { anime: ['crunchyroll'] });
});

test('auto-tag: stored data from older versions keeps working', async () => {
  // v1.3 stored inflated raw hit counts (one video could add several) and had
  // no counted-video list: those counts no longer tag on their own.
  const bg = loadBackground({
    categoryHits: { gaming: { ign: 2, gamespot: 7 } },
    categoryTags: { gaming: ['every eye'], trailer: ['movieclips'] }
  });
  const res = await send(bg, hits('gaming', 'ign', ['aaaaaaaaaaa']));
  assert.deepStrictEqual(res.newlyTagged, []);
  const s = bg.storage();
  assert.deepStrictEqual(s.categoryTags, { gaming: ['every eye'], trailer: ['movieclips'] });
  assert.strictEqual(s.categoryHits.gaming.ign, 1);
  assert.strictEqual(s.categoryHits.gaming.gamespot, 7);
  // Untag works on a tag from an older version and on a store with no exclusions yet
  await send(bg, { action: 'untagChannelForCategory', category: 'gaming', channelName: 'Every Eye' });
  assert.deepStrictEqual(bg.storage().categoryTags, { trailer: ['movieclips'] });
  assert.deepStrictEqual(bg.storage().categoryTagExclusions, { gaming: ['every eye'] });
});

test('auto-tag: malformed messages and stored shapes are ignored, not fatal', async () => {
  const bg = loadBackground({ categoryHitVideos: { gaming: { ign: 'oops' } }, categoryTagExclusions: { gaming: 'oops' } });
  const res = await bg.handleMessage({
    action: 'batchIncrementCategoryHits',
    hits: [
      ['gaming::ign', 3],                // old count-only shape
      ['no-separator', ['aaaaaaaaaaa']],
      ['::ign', ['aaaaaaaaaaa']],
      ['gaming::', ['aaaaaaaaaaa']],
      'gaming::ign',
      null,
      ['gaming::ign', [42, '', null, 'aaaaaaaaaaa']]
    ]
  });
  assert.strictEqual(res.success, true);
  assert.deepStrictEqual(res.newlyTagged, []);
  assert.deepStrictEqual(bg.storage().categoryHitVideos.gaming.ign, ['aaaaaaaaaaa']);
  assert.deepStrictEqual(await bg.handleMessage({ action: 'batchIncrementCategoryHits' }), { success: true, newlyTagged: [] });
  // An entry that adds no video leaves no empty map behind
  await bg.handleMessage({ action: 'batchIncrementCategoryHits', hits: [['anime::crunchyroll', [42]], ['gaming::ign', ['bbbbbbbbbbb']]] });
  assert.strictEqual(bg.storage().categoryHitVideos.anime, undefined);
  assert.strictEqual(bg.storage().categoryHits.anime, undefined);
});

test('auto-tag: export and import carry the untag exclusions', async () => {
  const bg = loadBackground();
  await send(bg, { action: 'untagChannelForCategory', category: 'gaming', channelName: 'IGN' });
  const backup = await bg.handleMessage({ action: 'exportAllData' });
  assert.deepStrictEqual(backup.categoryTagExclusions, { gaming: ['ign'] });

  const other = loadBackground();
  await other.handleMessage({ action: 'importAllData', data: backup });
  assert.deepStrictEqual(other.storage().categoryTagExclusions, { gaming: ['ign'] });
  await other.handleMessage({ action: 'importAllData', data: { categoryTagExclusions: ['not', 'an', 'object'] } });
  assert.deepStrictEqual(other.storage().categoryTagExclusions, { gaming: ['ign'] });
});

test('auto-tag: install seeds the new storage keys with empty objects', async () => {
  const bg = loadBackground();
  await bg.Storage.init();
  const s = bg.storage();
  assert.deepStrictEqual(s.categoryHitVideos, {});
  assert.deepStrictEqual(s.categoryTagExclusions, {});
});
