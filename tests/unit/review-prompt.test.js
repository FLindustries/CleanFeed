'use strict';
// Review prompt (background.js + storage.js): the popup asks once, after real
// use, whether CleanFeed makes YouTube better.
//   - onInstalled starts the clock (stats.reviewSince) once, on install or update
//   - incrementStat('videosHidden') counts each local day once (stats.activeDays)
//   - getReviewPrompt shows only after 7+ days, 3+ active days, 20+ hidden videos
//   - Yes opens the Web Store reviews, Not really a feedback email, both end it;
//     the first Later snoozes 14 days, the second ends it

const assert = require('node:assert');
const test = require('./registry');
const loadBackground = require('./load-background');

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 10, 2, 12, 0, 0);

function setup(initial) {
  let clock = T0;
  const bg = loadBackground(initial || {}, { now: () => clock });
  return { bg, setNow: ms => { clock = ms; }, now: () => clock };
}

async function useOn(t, dayOffset, hidden) {
  t.setNow(T0 + dayOffset * DAY);
  await t.bg.handleMessage({ action: 'incrementStat', stat: 'videosHidden', amount: hidden });
}

async function ready() {
  const t = setup();
  await t.bg.listeners.onInstalled[0]({ reason: 'install' });
  await useOn(t, 0, 10);
  await useOn(t, 2, 6);
  await useOn(t, 5, 6);
  t.setNow(T0 + 8 * DAY);
  return t;
}

test('review prompt: install starts the clock once; an update keeps it', async () => {
  const t = setup();
  await t.bg.listeners.onInstalled[0]({ reason: 'install' });
  assert.strictEqual(t.bg.storage().stats.reviewSince, T0);
  t.setNow(T0 + 3 * DAY);
  await t.bg.listeners.onInstalled[0]({ reason: 'update' });
  assert.strictEqual(t.bg.storage().stats.reviewSince, T0);
});

test('review prompt: an update from an older version starts the clock', async () => {
  const t = setup({ stats: { channelsBlocked: 0, videosHidden: 500, interestsSaved: 0 } });
  await t.bg.listeners.onInstalled[0]({ reason: 'update' });
  assert.strictEqual(t.bg.storage().stats.reviewSince, T0);
  assert.strictEqual(t.bg.storage().stats.videosHidden, 500);
});

test('review prompt: each local day with hidden videos counts once', async () => {
  const t = setup();
  await useOn(t, 0, 3);
  await useOn(t, 0, 4);
  await useOn(t, 1, 1);
  const s = t.bg.storage().stats;
  assert.strictEqual(s.videosHidden, 8);
  assert.strictEqual(s.activeDays, 2);
});

test('review prompt: shows only after 7 days, 3 active days and 20 hidden videos', async () => {
  const t = await ready();
  assert.deepStrictEqual(await t.bg.handleMessage({ action: 'getReviewPrompt' }), { show: true });

  const early = setup();
  await early.bg.listeners.onInstalled[0]({ reason: 'install' });
  await useOn(early, 0, 10); await useOn(early, 1, 10); await useOn(early, 2, 10);
  early.setNow(T0 + 6 * DAY);
  assert.deepStrictEqual(await early.bg.handleMessage({ action: 'getReviewPrompt' }), { show: false });

  const fewDays = setup();
  await fewDays.bg.listeners.onInstalled[0]({ reason: 'install' });
  await useOn(fewDays, 0, 30); await useOn(fewDays, 1, 30);
  fewDays.setNow(T0 + 10 * DAY);
  assert.deepStrictEqual(await fewDays.bg.handleMessage({ action: 'getReviewPrompt' }), { show: false });

  const fewHidden = setup();
  await fewHidden.bg.listeners.onInstalled[0]({ reason: 'install' });
  await useOn(fewHidden, 0, 5); await useOn(fewHidden, 1, 5); await useOn(fewHidden, 2, 5);
  fewHidden.setNow(T0 + 10 * DAY);
  assert.deepStrictEqual(await fewHidden.bg.handleMessage({ action: 'getReviewPrompt' }), { show: false });
});

test('review prompt: Yes opens the Web Store reviews and never asks again', async () => {
  const t = await ready();
  await t.bg.handleMessage({ action: 'answerReviewPrompt', answer: 'yes' });
  assert.deepStrictEqual(t.bg.tabsCreated, [{ url: 'https://chromewebstore.google.com/detail/iikgdocegpniapcigmmgcnacfojmmnnd/reviews' }]);
  t.setNow(T0 + 60 * DAY);
  assert.deepStrictEqual(await t.bg.handleMessage({ action: 'getReviewPrompt' }), { show: false });
});

test('review prompt: Not really opens a feedback email and never asks again', async () => {
  const t = await ready();
  await t.bg.handleMessage({ action: 'answerReviewPrompt', answer: 'no' });
  assert.strictEqual(t.bg.tabsCreated.length, 1);
  assert.ok(t.bg.tabsCreated[0].url.startsWith('mailto:cleanfeed.support@gmail.com?subject='));
  assert.strictEqual(t.bg.storage().stats.reviewStatus, 'done');
});

test('review prompt: the first Later snoozes 14 days, the second ends it', async () => {
  const t = await ready();
  await t.bg.handleMessage({ action: 'answerReviewPrompt', answer: 'later' });
  assert.strictEqual(t.bg.tabsCreated.length, 0);
  t.setNow(T0 + 21 * DAY);
  assert.deepStrictEqual(await t.bg.handleMessage({ action: 'getReviewPrompt' }), { show: false });
  t.setNow(T0 + 23 * DAY);
  assert.deepStrictEqual(await t.bg.handleMessage({ action: 'getReviewPrompt' }), { show: true });
  await t.bg.handleMessage({ action: 'answerReviewPrompt', answer: 'later' });
  t.setNow(T0 + 90 * DAY);
  assert.deepStrictEqual(await t.bg.handleMessage({ action: 'getReviewPrompt' }), { show: false });
});
